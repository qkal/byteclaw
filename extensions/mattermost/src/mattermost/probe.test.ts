import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

const { mockFetchGuard, mockRelease } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(),
  mockRelease: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return { ...original, fetchWithSsrFGuard: mockFetchGuard };
});

describe("probeMattermost", () => {
  beforeEach(() => {
    mockFetchGuard.mockReset();
    mockRelease.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns baseUrl missing for empty base URL", async () => {
    await expect(probeMattermost(" ", "token")).resolves.toEqual({
      error: "baseUrl missing",
      ok: false,
    });
    expect(mockFetchGuard).not.toHaveBeenCalled();
  });

  it("normalizes base URL and returns bot info", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      release: mockRelease,
      response: new Response(JSON.stringify({ id: "bot-1", username: "clawbot" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    });

    const result = await probeMattermost("https://mm.example.com/api/v4/", "bot-token");

    expect(mockFetchGuard).toHaveBeenCalledWith({
      auditContext: "mattermost-probe",
      init: expect.objectContaining({
        headers: { Authorization: "Bearer bot-token" },
      }),
      policy: undefined,
      url: "https://mm.example.com/api/v4/users/me",
    });
    expect(result).toEqual(
      expect.objectContaining({
        bot: { id: "bot-1", username: "clawbot" },
        ok: true,
        status: 200,
      }),
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("forwards allowPrivateNetwork to the SSRF guard policy", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      release: mockRelease,
      response: new Response(JSON.stringify({ id: "bot-1" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    });

    await probeMattermost("https://mm.example.com", "bot-token", 2500, true);

    expect(mockFetchGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: { allowPrivateNetwork: true },
      }),
    );
  });

  it("returns API error details from JSON response", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      release: mockRelease,
      response: new Response(JSON.stringify({ message: "invalid auth token" }), {
        headers: { "content-type": "application/json" },
        status: 401,
        statusText: "Unauthorized",
      }),
    });

    await expect(probeMattermost("https://mm.example.com", "bad-token")).resolves.toEqual(
      expect.objectContaining({
        error: "invalid auth token",
        ok: false,
        status: 401,
      }),
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("falls back to statusText when error body is empty", async () => {
    mockFetchGuard.mockResolvedValueOnce({
      release: mockRelease,
      response: new Response("", {
        headers: { "content-type": "text/plain" },
        status: 403,
        statusText: "Forbidden",
      }),
    });

    await expect(probeMattermost("https://mm.example.com", "token")).resolves.toEqual(
      expect.objectContaining({
        error: "Forbidden",
        ok: false,
        status: 403,
      }),
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("returns fetch error when request throws", async () => {
    mockFetchGuard.mockRejectedValueOnce(new Error("network down"));

    await expect(probeMattermost("https://mm.example.com", "token")).resolves.toEqual(
      expect.objectContaining({
        error: "network down",
        ok: false,
        status: null,
      }),
    );
  });
});
