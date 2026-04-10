import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import { validateConfigObjectRaw } from "./validation.js";

function validateOpenAiApiKeyRef(apiKey: unknown) {
  return validateConfigObjectRaw({
    models: {
      providers: {
        openai: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
  });
}

describe("config secret refs schema", () => {
  it("accepts top-level secrets sources and model apiKey refs", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
          filemain: {
            mode: "json",
            path: "~/.openclaw/secrets.json",
            source: "file",
            timeoutMs: 10_000,
          },
          vault: {
            allowSymlinkCommand: true,
            args: ["resolve"],
            command: "/usr/local/bin/openclaw-secret-resolver",
            source: "exec",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts openai-codex-responses as a model api value", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
            models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts googlechat serviceAccount refs", () => {
    const result = validateConfigObjectRaw({
      channels: {
        googlechat: {
          serviceAccountRef: {
            id: "/channels/googlechat/serviceAccount",
            provider: "filemain",
            source: "file",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts skills entry apiKey refs", () => {
    const result = validateConfigObjectRaw({
      skills: {
        entries: {
          "review-pr": {
            apiKey: { id: "SKILL_REVIEW_PR_API_KEY", provider: "default", source: "env" },
            enabled: true,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts media request secret refs for auth, headers, and tls material", () => {
    const result = validateConfigObjectRaw({
      tools: {
        media: {
          audio: {
            enabled: true,
            models: [{ model: "gpt-4o-mini-transcribe", provider: "openai" }],
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { id: "MEDIA_AUDIO_TOKEN", provider: "default", source: "env" },
              },
              headers: {
                "X-Tenant": { id: "MEDIA_TENANT_HEADER", provider: "default", source: "env" },
              },
              proxy: {
                mode: "explicit-proxy",
                tls: {
                  ca: { id: "/tls/proxy-ca", provider: "filemain", source: "file" },
                },
                url: "http://proxy.example:8080",
              },
              tls: {
                cert: { id: "/tls/client-cert", provider: "filemain", source: "file" },
                key: { id: "/tls/client-key", provider: "filemain", source: "file" },
                passphrase: { id: "media/audio/passphrase", provider: "vault", source: "exec" },
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts model provider request secret refs for auth, headers, and tls material", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { id: "OPENAI_PROVIDER_TOKEN", provider: "default", source: "env" },
              },
              headers: {
                "X-Tenant": { id: "OPENAI_TENANT_HEADER", provider: "default", source: "env" },
              },
              proxy: {
                mode: "explicit-proxy",
                tls: {
                  ca: { id: "/tls/provider-proxy-ca", provider: "filemain", source: "file" },
                },
                url: "http://proxy.example:8080",
              },
              tls: {
                cert: { id: "/tls/provider-cert", provider: "filemain", source: "file" },
                key: { id: "/tls/provider-key", provider: "filemain", source: "file" },
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts model provider header SecretRef values", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            headers: {
              Authorization: {
                id: "OPENAI_HEADER_TOKEN",
                provider: "default",
                source: "env",
              },
            },
            models: [],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.models?.providers?.openai?.headers?.Authorization).toEqual({
        id: "OPENAI_HEADER_TOKEN",
        provider: "default",
        source: "env",
      });
    }
  });

  it("rejects model provider request proxy url secret refs", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
            request: {
              proxy: {
                mode: "explicit-proxy",
                url: { id: "PROVIDER_PROXY_URL", provider: "default", source: "env" },
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.request.proxy")),
      ).toBe(true);
    }
  });

  it('accepts file refs with id "value" for singleValue mode providers', () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            apiKey: { id: "value", provider: "rawfile", source: "file" },
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
      secrets: {
        providers: {
          rawfile: {
            mode: "singleValue",
            path: "~/.openclaw/token.txt",
            source: "file",
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid secret ref id", () => {
    const result = validateOpenAiApiKeyRef({
      id: "bad id with spaces",
      provider: "default",
      source: "env",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
      ).toBe(true);
    }
  });

  it("rejects env refs that are not env var names", () => {
    const result = validateOpenAiApiKeyRef({
      id: "/providers/openai/apiKey",
      provider: "default",
      source: "env",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("models.providers.openai.apiKey") &&
            issue.message.includes("Env secret reference id"),
        ),
      ).toBe(true);
    }
  });

  it("rejects file refs that are not absolute JSON pointers", () => {
    const result = validateOpenAiApiKeyRef({
      id: "providers/openai/apiKey",
      provider: "default",
      source: "file",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("models.providers.openai.apiKey") &&
            issue.message.includes("absolute JSON pointer"),
        ),
      ).toBe(true);
    }
  });

  it("accepts valid exec secret reference ids", () => {
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      const result = validateOpenAiApiKeyRef({
        id,
        provider: "vault",
        source: "exec",
      });
      expect(result.ok, `expected valid exec ref id: ${id}`).toBe(true);
    }
  });

  it("rejects invalid exec secret reference ids", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const result = validateOpenAiApiKeyRef({
        id,
        provider: "vault",
        source: "exec",
      });
      expect(result.ok, `expected invalid exec ref id: ${id}`).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
        ).toBe(true);
      }
    }
  });
});
