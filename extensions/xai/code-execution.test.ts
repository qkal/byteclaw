import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeExecutionTool } from "./code-execution.js";

function installCodeExecutionFetch(payload?: Record<string, unknown>) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      json: () =>
        Promise.resolve(
          payload ?? {
            citations: ["https://example.com/data.csv"],
            output: [
              { type: "code_interpreter_call" },
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Mean: 42",
                    annotations: [{ type: "url_citation", url: "https://example.com/data.csv" }],
                  },
                ],
              },
            ],
          },
        ),
      ok: true,
    } as Response),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function parseFirstRequestBody(mockFetch: ReturnType<typeof installCodeExecutionFetch>) {
  const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  const requestBody = request?.body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xai code_execution tool", () => {
  it("enables code_execution when the xAI plugin web search key is configured", () => {
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("code_execution");
  });

  it("uses the xAI Responses code_interpreter tool", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                codeExecution: {
                  maxTurns: 2,
                  model: "grok-4-1-fast",
                  timeoutSeconds: 45,
                },
                webSearch: {
                  apiKey: "xai-config-test", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("code-execution:1", {
      task: "Calculate the mean of [40, 42, 44]",
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-4-1-fast");
    expect(body.max_turns).toBe(2);
    expect(body.tools).toEqual([{ type: "code_interpreter" }]);
    expect(
      (result?.details as { usedCodeExecution?: boolean } | undefined)?.usedCodeExecution,
    ).toBe(true);
  });

  it("reuses the xAI plugin web search key for code_execution requests", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // Pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("code-execution:plugin-key", {
      task: "Compute the standard deviation of [1, 2, 3]",
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer xai-plugin-key",
    );
  });

  it("reuses the legacy grok web search key for code_execution requests", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "xai-legacy-key", // Pragma: allowlist secret
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("code-execution:legacy-key", {
      task: "Count rows in a two-column table",
    });

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer xai-legacy-key",
    );
  });
});
