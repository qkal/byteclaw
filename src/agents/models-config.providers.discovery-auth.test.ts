import { describe, expect, it } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveApiKeyFromCredential } from "./models-config.providers.secrets.js";

describe("provider discovery auth marker guardrails", () => {
  it("suppresses discovery secrets for marker-backed vLLM credentials", () => {
    const resolved = resolveApiKeyFromCredential({
      keyRef: { id: "/vllm/apiKey", provider: "vault", source: "file" },
      provider: "vllm",
      type: "api_key",
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(resolved?.discoveryApiKey).toBeUndefined();
  });

  it("suppresses discovery secrets for marker-backed Hugging Face credentials", () => {
    const resolved = resolveApiKeyFromCredential({
      keyRef: { id: "providers/hf/token", provider: "vault", source: "exec" },
      provider: "huggingface",
      type: "api_key",
    });

    expect(resolved?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(resolved?.discoveryApiKey).toBeUndefined();
  });

  it("keeps all-caps plaintext API keys for authenticated discovery", () => {
    const resolved = resolveApiKeyFromCredential({
      key: "ALLCAPS_SAMPLE",
      provider: "vllm",
      type: "api_key",
    });

    expect(resolved?.apiKey).toBe("ALLCAPS_SAMPLE");
    expect(resolved?.discoveryApiKey).toBe("ALLCAPS_SAMPLE");
  });
});
