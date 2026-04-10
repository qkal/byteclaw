import { afterEach, describe, expect, it, vi } from "vitest";
import { twilioApiRequest } from "./api.js";

const originalFetch = globalThis.fetch;

describe("twilioApiRequest", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts form bodies with basic auth and parses json", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ sid: "CA123" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      twilioApiRequest({
        accountSid: "AC123",
        authToken: "secret",
        baseUrl: "https://api.twilio.com",
        body: {
          StatusCallbackEvent: ["initiated", "completed"],
          To: "+14155550123",
        },
        endpoint: "/Calls.json",
      }),
    ).resolves.toEqual({ sid: "CA123" });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] ?? [];
    expect(url).toBe("https://api.twilio.com/Calls.json");
    expect(init).toEqual(
      expect.objectContaining({
        headers: {
          Authorization: `Basic ${Buffer.from("AC123:secret").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
    );
    expect(String(init?.body)).toBe(
      "To=%2B14155550123&StatusCallbackEvent=initiated&StatusCallbackEvent=completed",
    );
  });

  it("passes through URLSearchParams, allows 404s, and returns undefined for empty bodies", async () => {
    const responses = [
      new Response(null, { status: 204 }),
      new Response("missing", { status: 404 }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;

    await expect(
      twilioApiRequest({
        accountSid: "AC123",
        authToken: "secret",
        baseUrl: "https://api.twilio.com",
        body: new URLSearchParams({ To: "+14155550123" }),
        endpoint: "/Calls.json",
      }),
    ).resolves.toBeUndefined();

    await expect(
      twilioApiRequest({
        accountSid: "AC123",
        allowNotFound: true,
        authToken: "secret",
        baseUrl: "https://api.twilio.com",
        body: {},
        endpoint: "/Calls/missing.json",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws twilio api errors for non-ok responses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      twilioApiRequest({
        accountSid: "AC123",
        authToken: "secret",
        baseUrl: "https://api.twilio.com",
        body: {},
        endpoint: "/Calls.json",
      }),
    ).rejects.toThrow("Twilio API error: 400 bad request");
  });
});
