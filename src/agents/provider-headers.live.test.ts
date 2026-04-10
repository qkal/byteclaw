import { beforeAll, describe, expect, it } from "vitest";
import {
  LIVE_CACHE_TEST_ENABLED,
  logLiveCache,
  resolveLiveDirectModel,
  withLiveCacheHeartbeat,
} from "./live-cache-test-support.js";

const describeLive = LIVE_CACHE_TEST_ENABLED ? describe : describe.skip;

describeLive("provider response headers (live)", () => {
  describe("openai", () => {
    let fixture: Awaited<ReturnType<typeof resolveLiveDirectModel>>;

    beforeAll(async () => {
      fixture = await resolveLiveDirectModel({
        api: "openai-responses",
        envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
        preferredModelIds: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.4"],
        provider: "openai",
      });
    }, 120_000);

    it("returns request-id style headers from Responses", async () => {
      const response = await withLiveCacheHeartbeat(
        fetch("https://api.openai.com/v1/responses", {
          body: JSON.stringify({
            input: "Reply with OK.",
            max_output_tokens: 32,
            model: fixture.model.id,
          }),
          headers: {
            authorization: `Bearer ${fixture.apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
        "openai headers probe",
      );
      const bodyText = await response.text();
      expect(response.ok, bodyText).toBe(true);

      const requestId = response.headers.get("x-request-id");
      const processingMs = response.headers.get("openai-processing-ms");
      const rateLimitHeaders = [...response.headers.entries()]
        .filter(([key]) => key.startsWith("x-ratelimit-"))
        .map(([key, value]) => `${key}=${value}`);

      logLiveCache(
        `openai headers x-request-id=${requestId ?? "(missing)"} openai-processing-ms=${processingMs ?? "(missing)"} ${rateLimitHeaders.join(" ")}`.trim(),
      );
      expect(requestId).toBeTruthy();
    }, 120_000);
  });

  describe("anthropic", () => {
    let fixture: Awaited<ReturnType<typeof resolveLiveDirectModel>>;

    beforeAll(async () => {
      fixture = await resolveLiveDirectModel({
        api: "anthropic-messages",
        envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
        preferredModelIds: ["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-haiku-3-5"],
        provider: "anthropic",
      });
    }, 120_000);

    it("returns request-id from Messages", async () => {
      const response = await withLiveCacheHeartbeat(
        fetch("https://api.anthropic.com/v1/messages", {
          body: JSON.stringify({
            max_tokens: 32,
            messages: [{ role: "user", content: "Reply with OK." }],
            model: fixture.model.id,
          }),
          headers: {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": fixture.apiKey,
          },
          method: "POST",
        }),
        "anthropic headers probe",
      );
      const bodyText = await response.text();
      expect(response.ok, bodyText).toBe(true);

      const requestId = response.headers.get("request-id");
      logLiveCache(`anthropic headers request-id=${requestId ?? "(missing)"}`);
      expect(requestId).toBeTruthy();
    }, 120_000);
  });
});
