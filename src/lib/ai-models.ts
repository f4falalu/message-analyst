// Client-safe presets for bring-your-own-key models. Every entry is just a
// starting point — base URL and model name stay editable in the UI.

export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  authStyle: "bearer" | "x-api-key" | "none";
  keyHint: string;
  supportsPdf: boolean;
  models: { id: string; label: string; note?: string }[];
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter (router — hundreds of models, one key)",
    baseUrl: "https://openrouter.ai/api/v1",
    authStyle: "bearer",
    keyHint: "openrouter.ai/keys",
    supportsPdf: true,
    models: [
      { id: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL 235B (Alibaba, open weights)", note: "Strong document OCR" },
      { id: "qwen/qwen2.5-vl-72b-instruct", label: "Qwen2.5-VL 72B (Alibaba, open weights)" },
      { id: "z-ai/glm-4.6v", label: "GLM-4.6V (Zhipu, open weights)" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek V3 (text only)" },
      { id: "mistralai/mistral-medium-3.1", label: "Mistral Medium 3.1 (vision)" },
      { id: "mistralai/pixtral-large-2411", label: "Pixtral Large (Mistral, vision)" },
      { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick (Meta, open weights)" },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI (direct)",
    baseUrl: "https://api.mistral.ai/v1",
    authStyle: "bearer",
    keyHint: "console.mistral.ai",
    supportsPdf: true,
    models: [
      { id: "mistral-medium-latest", label: "Mistral Medium (vision)" },
      { id: "pixtral-large-latest", label: "Pixtral Large (vision)" },
      { id: "pixtral-12b-2409", label: "Pixtral 12B (cheap, open weights)" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek (direct)",
    baseUrl: "https://api.deepseek.com/v1",
    authStyle: "bearer",
    keyHint: "platform.deepseek.com",
    supportsPdf: false,
    models: [{ id: "deepseek-chat", label: "DeepSeek V3 (text only — no scans)" }],
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi (direct)",
    baseUrl: "https://api.moonshot.ai/v1",
    authStyle: "bearer",
    keyHint: "platform.moonshot.ai",
    supportsPdf: false,
    models: [{ id: "moonshot-v1-32k-vision-preview", label: "Kimi vision preview" }],
  },
  {
    id: "zhipu",
    label: "Zhipu AI / GLM (direct)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authStyle: "bearer",
    keyHint: "bigmodel.cn",
    supportsPdf: false,
    models: [
      { id: "glm-4.6v", label: "GLM-4.6V (vision)" },
      { id: "glm-4-flash", label: "GLM-4 Flash (cheap, text)" },
    ],
  },
  {
    id: "together",
    label: "Together AI (open-source hosting)",
    baseUrl: "https://api.together.xyz/v1",
    authStyle: "bearer",
    keyHint: "api.together.ai",
    supportsPdf: false,
    models: [
      { id: "Qwen/Qwen2.5-VL-72B-Instruct", label: "Qwen2.5-VL 72B" },
      { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", label: "Llama 4 Maverick" },
    ],
  },
  {
    id: "groq",
    label: "Groq (very fast, open-weight models)",
    baseUrl: "https://api.groq.com/openai/v1",
    authStyle: "bearer",
    keyHint: "console.groq.com/keys",
    supportsPdf: false,
    models: [
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (vision)" },
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick (vision)" },
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks AI (open-source hosting)",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authStyle: "bearer",
    keyHint: "fireworks.ai",
    supportsPdf: false,
    models: [
      { id: "accounts/fireworks/models/qwen2p5-vl-32b-instruct", label: "Qwen2.5-VL 32B" },
      { id: "accounts/fireworks/models/llama4-maverick-instruct-basic", label: "Llama 4 Maverick" },
    ],
  },
  {
    id: "ollama",
    label: "Local / self-hosted (Ollama, vLLM, LM Studio)",
    baseUrl: "http://localhost:11434/v1",
    authStyle: "none",
    keyHint: "no key needed",
    supportsPdf: false,
    models: [
      { id: "qwen2.5vl:7b", label: "Qwen2.5-VL 7B (local)" },
      { id: "llama3.2-vision:11b", label: "Llama 3.2 Vision 11B (local)" },
    ],
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "",
    authStyle: "bearer",
    keyHint: "your provider's dashboard",
    supportsPdf: false,
    models: [],
  },
];
