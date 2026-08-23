import { describe, expect, it } from "vitest";
import { relayTargetFrom } from "./relay-target";

// This guard is the only thing standing between an anonymous HTTP caller and
// "make our server fetch a URL of my choosing". The rejection cases matter more
// than the acceptance cases.
describe("relayTargetFrom", () => {
  describe("accepts the endpoints the local lane actually uses", () => {
    const allowed = [
      "https://abc123.ngrok-free.app/v1/models",
      "https://abc123.ngrok-free.app/v1/chat/completions",
      "https://abc123.ngrok-free.app/api/tags",
      "https://abc123.ngrok-free.app/api/pull",
      "https://abc123.ngrok-free.dev/v1/models",
    ];
    for (const url of allowed) {
      it(url, () => {
        expect(relayTargetFrom(url)?.href).toBe(url);
      });
    }

    // Regression: the capability probe added in local-read.ts calls /api/show.
    // Before this path was allow-listed the relay answered 400 and the probe
    // silently fell back to guessing vision support from the model name.
    it("allows /api/show so the capability probe survives the relay fallback", () => {
      expect(relayTargetFrom("https://abc123.ngrok-free.app/api/show")).not.toBeNull();
    });
  });

  describe("rejects anything outside the tunnel", () => {
    it("refuses plain http, which would strip transport security", () => {
      expect(relayTargetFrom("http://abc123.ngrok-free.app/v1/models")).toBeNull();
    });

    it("refuses cloud metadata, the classic SSRF target", () => {
      expect(relayTargetFrom("https://169.254.169.254/latest/meta-data/")).toBeNull();
    });

    it("refuses loopback and private addresses", () => {
      expect(relayTargetFrom("https://localhost:11434/v1/models")).toBeNull();
      expect(relayTargetFrom("https://127.0.0.1/v1/models")).toBeNull();
      expect(relayTargetFrom("https://10.0.0.5/v1/models")).toBeNull();
    });

    it("refuses arbitrary public hosts", () => {
      expect(relayTargetFrom("https://api.openai.com/v1/models")).toBeNull();
    });

    it("refuses non-http schemes", () => {
      expect(relayTargetFrom("file:///etc/passwd")).toBeNull();
      expect(relayTargetFrom("gopher://abc.ngrok-free.app/v1/models")).toBeNull();
    });
  });

  describe("rejects hostnames that merely look like the tunnel", () => {
    // Each of these ends with, contains, or prefixes the allowed suffix without
    // actually being a subdomain of it.
    const lookalikes = [
      "https://evilngrok-free.app/v1/models",
      "https://ngrok-free.app.attacker.com/v1/models",
      "https://abc.ngrok-free.app.attacker.com/v1/models",
      "https://abc.ngrok-free.com/v1/models",
      "https://abc.ngrok-free.appx/v1/models",
    ];
    for (const url of lookalikes) {
      it(url, () => {
        expect(relayTargetFrom(url)).toBeNull();
      });
    }
  });

  describe("rejects paths outside the model API", () => {
    const blocked = [
      "https://abc123.ngrok-free.app/api/delete",
      "https://abc123.ngrok-free.app/api/create",
      "https://abc123.ngrok-free.app/v1/embeddings",
      "https://abc123.ngrok-free.app/",
      "https://abc123.ngrok-free.app/admin",
      // Trailing segments must not slip past an anchored pattern.
      "https://abc123.ngrok-free.app/v1/models/../../admin",
      "https://abc123.ngrok-free.app/v1/models/extra",
    ];
    for (const url of blocked) {
      it(url, () => {
        expect(relayTargetFrom(url)).toBeNull();
      });
    }

    // /api/delete is destructive: it removes a model from the user's machine.
    it("cannot be used to delete a model", () => {
      expect(relayTargetFrom("https://abc123.ngrok-free.app/api/delete")).toBeNull();
    });
  });

  describe("handles absent and malformed input", () => {
    it("returns null rather than throwing", () => {
      expect(relayTargetFrom(null)).toBeNull();
      expect(relayTargetFrom(undefined)).toBeNull();
      expect(relayTargetFrom("")).toBeNull();
      expect(relayTargetFrom("not-a-url")).toBeNull();
      expect(relayTargetFrom("://///")).toBeNull();
    });
  });
});
