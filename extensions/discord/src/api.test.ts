import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDiscord } from "./api.js";
import { jsonResponse } from "./test-http-helpers.js";

describe("fetchDiscord", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("formats rate limit payloads without raw JSON", async () => {
    const fetcher = withFetchPreconnect(async () =>
      jsonResponse(
        {
          global: false,
          message: "You are being rate limited.",
          retry_after: 0.631,
        },
        429,
      ),
    );

    let error: unknown;
    try {
      await fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      });
    } catch (error) {
      error = error;
    }

    const message = String(error);
    expect(message).toContain("Discord API /users/@me/guilds failed (429)");
    expect(message).toContain("You are being rate limited.");
    expect(message).toContain("retry after 0.6s");
    expect(message).not.toContain("{");
    expect(message).not.toContain("retry_after");
  });

  it("preserves non-JSON error text", async () => {
    const fetcher = withFetchPreconnect(async () => new Response("Not Found", { status: 404 }));
    await expect(
      fetchDiscord("/users/@me/guilds", "test", fetcher, {
        retry: { attempts: 1 },
      }),
    ).rejects.toThrow("Discord API /users/@me/guilds failed (404): Not Found");
  });

  it("retries rate limits before succeeding", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          {
            global: false,
            message: "You are being rate limited.",
            retry_after: 0,
          },
          429,
        );
      }
      return jsonResponse([{ id: "1", name: "Guild" }], 200);
    });

    const result = await fetchDiscord<{ id: string; name: string }[]>(
      "/users/@me/guilds",
      "test",
      fetcher,
      { retry: { attempts: 2, jitter: 0, maxDelayMs: 0, minDelayMs: 0 } },
    );

    expect(result).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
