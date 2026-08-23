import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchModelCapabilities,
  fetchVisionCapability,
  isVisionModel,
  resolveVisionModels,
} from "./local-read";
import { PROVIDER_PRESETS, SUGGESTED_LOCAL_MODEL } from "./ai-models";

const BASE = "http://localhost:11434/v1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isVisionModel", () => {
  describe("accepts readers the app is meant to run", () => {
    const vision = [
      "qwen3-vl:2b",
      "qwen3-vl:4b",
      "qwen3-vl:8b",
      "qwen2.5vl:7b",
      "minicpm-v4.6:1b",
      "minicpm-v4.5:8b",
      "llama3.2-vision:11b",
      "llava:13b",
      "moondream",
      "granite3.2-vision",
      "pixtral-12b-2409",
    ];
    for (const id of vision) {
      it(id, () => expect(isVisionModel(id)).toBe(true));
    }
  });

  // Regression: the previous pattern listed `got-ocr` but had no bare `ocr`, so
  // every other document-OCR model was refused before a run could start.
  describe("accepts the OCR-specialist family", () => {
    const ocr = [
      "glm-ocr",
      "glm-ocr:q8_0",
      "deepseek-ocr",
      "got-ocr2",
      "nanonets-ocr-s",
      "olmocr:7b",
    ];
    for (const id of ocr) {
      it(id, () => expect(isVisionModel(id)).toBe(true));
    }
  });

  describe("rejects text-only models", () => {
    // Starting a run on one of these burns hours and returns nothing usable,
    // so a false positive here is worse than a false negative.
    const textOnly = ["deepseek-chat", "llama3.1:8b", "mistral:7b", "phi4", "codellama:13b"];
    for (const id of textOnly) {
      it(id, () => expect(isVisionModel(id)).toBe(false));
    }
  });
});

describe("fetchVisionCapability", () => {
  it("reports true when the endpoint lists the vision capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["completion", "vision"] })),
    );
    await expect(fetchVisionCapability(BASE, "qwen3-vl:2b")).resolves.toBe(true);
  });

  it("reports false when the endpoint lists capabilities without vision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["completion"] })),
    );
    await expect(fetchVisionCapability(BASE, "llama3.1:8b")).resolves.toBe(false);
  });

  it("asks Ollama's /api/show, not the OpenAI-compatible path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["vision"] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchVisionCapability(BASE, "qwen3-vl:2b");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/show");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ model: "qwen3-vl:2b" });
  });

  // null means "no answer", which is different from "not vision". Callers use
  // it to decide whether to fall back to the name heuristic.
  describe("returns null when the endpoint cannot answer", () => {
    it("on a 404, since LM Studio and vLLM serve only the OpenAI surface", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404)));
      await expect(fetchVisionCapability(BASE, "any")).resolves.toBeNull();
    });

    it("when the payload omits capabilities", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ details: {} })));
      await expect(fetchVisionCapability(BASE, "any")).resolves.toBeNull();
    });

    it("when capabilities is not an array", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ capabilities: "vision" })));
      await expect(fetchVisionCapability(BASE, "any")).resolves.toBeNull();
    });

    it("when the response is not JSON", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 200 })));
      await expect(fetchVisionCapability(BASE, "any")).resolves.toBeNull();
    });

    it("when the connection fails outright", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      await expect(fetchVisionCapability(BASE, "any")).resolves.toBeNull();
    });
  });
});

describe("resolveVisionModels", () => {
  it("believes the endpoint over the model's name", async () => {
    // A model whose name looks text-only but that genuinely has vision.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["vision"] })));
    const result = await resolveVisionModels(BASE, ["mystery-model-v3"]);
    expect(result.visionModels).toEqual(["mystery-model-v3"]);
    expect(result.authoritative).toBe(true);
  });

  it("excludes a vision-sounding name the endpoint says is text-only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["completion"] })),
    );
    const result = await resolveVisionModels(BASE, ["qwen3-vl:2b"]);
    expect(result.visionModels).toEqual([]);
    expect(result.authoritative).toBe(true);
  });

  it("falls back to names when the endpoint reports nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    const result = await resolveVisionModels(BASE, ["qwen3-vl:2b", "llama3.1:8b", "glm-ocr"]);
    expect(result.visionModels).toEqual(["qwen3-vl:2b", "glm-ocr"]);
    expect(result.authoritative).toBe(false);
  });

  it("mixes both signals per model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const { model } = JSON.parse(String(init.body)) as { model: string };
        if (model === "known-good")
          return Promise.resolve(jsonResponse({ capabilities: ["vision"] }));
        return Promise.resolve(jsonResponse({}, 404));
      }),
    );
    const result = await resolveVisionModels(BASE, ["known-good", "glm-ocr", "mistral:7b"]);
    expect(result.visionModels).toEqual(["known-good", "glm-ocr"]);
    expect(result.authoritative).toBe(true);
  });

  it("preserves the caller's model order, which is the read preference order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    const result = await resolveVisionModels(BASE, ["glm-ocr", "qwen3-vl:4b", "qwen3-vl:2b"]);
    expect(result.visionModels).toEqual(["glm-ocr", "qwen3-vl:4b", "qwen3-vl:2b"]);
  });

  it("handles an empty model list without calling the endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveVisionModels(BASE, []);
    expect(result).toEqual({ visionModels: [], thinkingModels: [], authoritative: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Measured against a real CPU-only host: qwen3-vl:2b reported
// capabilities ["vision","completion","tools","thinking"], then spent ~5,500
// characters on reasoning and emitted zero content, taking ~346s per document.
// The app reads delta.content, so every document failed as "empty response".
describe("resolveVisionModels flags reasoning models", () => {
  it("marks a vision model that also reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ capabilities: ["vision", "completion", "tools", "thinking"] }),
        ),
    );
    const result = await resolveVisionModels(BASE, ["qwen3-vl:2b"]);
    expect(result.visionModels).toEqual(["qwen3-vl:2b"]);
    expect(result.thinkingModels).toEqual(["qwen3-vl:2b"]);
  });

  it("leaves a plain vision model unflagged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["vision", "completion"] })),
    );
    const result = await resolveVisionModels(BASE, ["qwen2.5vl:7b"]);
    expect(result.visionModels).toEqual(["qwen2.5vl:7b"]);
    expect(result.thinkingModels).toEqual([]);
  });

  it("does not flag a text-only reasoning model, which is excluded anyway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["completion", "thinking"] })),
    );
    const result = await resolveVisionModels(BASE, ["deepseek-r1:1.5b"]);
    expect(result.visionModels).toEqual([]);
    expect(result.thinkingModels).toEqual([]);
  });

  it("cannot flag anything when the endpoint does not report capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    const result = await resolveVisionModels(BASE, ["qwen3-vl:2b"]);
    expect(result.visionModels).toEqual(["qwen3-vl:2b"]);
    expect(result.thinkingModels).toEqual([]);
    expect(result.authoritative).toBe(false);
  });
});

describe("fetchModelCapabilities", () => {
  it("lower-cases and returns the reported list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["Vision", "COMPLETION"] })),
    );
    await expect(fetchModelCapabilities(BASE, "m")).resolves.toEqual(["vision", "completion"]);
  });

  it("drops non-string entries rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ capabilities: ["vision", 42, null] })),
    );
    await expect(fetchModelCapabilities(BASE, "m")).resolves.toEqual(["vision"]);
  });

  it("returns null when the endpoint does not implement /api/show", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    await expect(fetchModelCapabilities(BASE, "m")).resolves.toBeNull();
  });
});

// The app refuses to start a run unless a model looks vision-capable. If a
// preset we ship fails our own gate, the user hits a dead end on a model we
// recommended. This is the check that would have caught the glm-ocr bug.
describe("shipped local presets pass the app's own vision gate", () => {
  const ollama = PROVIDER_PRESETS.find((preset) => preset.id === "ollama");

  it("the local preset exists", () => {
    expect(ollama).toBeDefined();
  });

  for (const model of ollama?.models ?? []) {
    it(`${model.id} is accepted by isVisionModel`, () => {
      expect(isVisionModel(model.id)).toBe(true);
    });
  }

  it("suggests a model it actually ships", () => {
    expect(ollama?.models.map((m) => m.id)).toContain(SUGGESTED_LOCAL_MODEL);
  });

  it("suggests a model that passes the gate", () => {
    expect(isVisionModel(SUGGESTED_LOCAL_MODEL)).toBe(true);
  });
});
