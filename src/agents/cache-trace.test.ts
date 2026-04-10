import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { createCacheTrace } from "./cache-trace.js";

describe("createCacheTrace", () => {
  it("returns null when diagnostics cache tracing is disabled", () => {
    const trace = createCacheTrace({
      cfg: {} as OpenClawConfig,
      env: {},
    });

    expect(trace).toBeNull();
  });

  it("honors diagnostics cache trace config and expands file paths", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            filePath: "~/.openclaw/logs/cache-trace.jsonl",
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(trace).not.toBeNull();
    expect(trace?.filePath).toBe(resolveUserPath("~/.openclaw/logs/cache-trace.jsonl"));

    trace?.recordStage("session:loaded", {
      messages: [],
      system: "sys",
    });

    expect(lines.length).toBe(1);
  });

  it("records empty prompt/system values when enabled", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includePrompt: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    trace?.recordStage("prompt:before", { prompt: "", system: "" });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.prompt).toBe("");
    expect(event.system).toBe("");
  });

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const wrapped = trace?.wrapStreamFn(((model: unknown, context: unknown, options: unknown) => ({
      context,
      model,
      options,
    })) as never);

    void wrapped?.(
      {
        api: "openai-responses",
        id: "gpt-5.4",
        provider: "openai",
      } as never,
      {
        messages: [],
        systemPrompt: "system prompt text",
      } as never,
      {},
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("stream:context");
    expect(event.system).toBe("system prompt text");
    expect(event.systemDigest).toBeTypeOf("string");
  });

  it("respects env overrides for enablement", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {
        OPENCLAW_CACHE_TRACE: "0",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(trace).toBeNull();
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    trace?.recordStage("stream:context", {
      messages: [
        {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
          metadata: {
            label: "preserve-me",
            secretKey: "message-secret-key",
          },
          role: "user",
          token: "message-secret-token",
        },
      ] as unknown as [],
      model: {
        apiKey: "sk-model-secret",
        id: "test-model",
        tokenCount: 8192,
      },
      options: {
        apiKey: "sk-options-secret",
        images: [{ data: "QUJDRA==", mimeType: "image/png", type: "image" }],
        nested: {
          password: "super-secret-password",
          safe: "keep-me",
          tokenCount: 42,
        },
      },
      system: {
        provider: { apiKey: "sk-system-secret", baseUrl: "https://api.example.com" },
      },
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.system).toEqual({
      provider: {
        baseUrl: "https://api.example.com",
      },
    });
    expect(event.model).toEqual({
      id: "test-model",
      tokenCount: 8192,
    });
    expect(event.options).toEqual({
      images: [
        {
          bytes: 4,
          data: "<redacted>",
          mimeType: "image/png",
          sha256: crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
          type: "image",
        },
      ],
      nested: {
        safe: "keep-me",
        tokenCount: 42,
      },
    });

    const optionsImages = (
      ((event.options as { images?: unknown[] } | undefined)?.images ?? []) as Record<string, unknown>[]
    )[0];
    expect(optionsImages?.data).toBe("<redacted>");
    expect(optionsImages?.bytes).toBe(4);
    expect(optionsImages?.sha256).toBe(
      crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
    );

    const firstMessage = ((event.messages as Record<string, unknown>[] | undefined) ?? [])[0];
    expect(firstMessage).not.toHaveProperty("token");
    expect(firstMessage).not.toHaveProperty("metadata.secretKey");
    expect(firstMessage).toMatchObject({
      metadata: {
        label: "preserve-me",
      },
      role: "user",
    });
    const source = (((firstMessage?.content as Record<string, unknown>[] | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(6);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("U0VDUkVU").digest("hex"));
  });

  it("handles circular references in messages without stack overflow", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const parent: Record<string, unknown> = { content: "hello", role: "user" };
    const child: Record<string, unknown> = { ref: parent };
    parent.child = child; // Circular reference

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.messageCount).toBe(1);
    expect(event.messageFingerprints).toHaveLength(1);
  });
});
