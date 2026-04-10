import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../../api.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { guardedJsonApiRequest } from "./guarded-json-api.js";

describe("guardedJsonApiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the SSRF-guarded fetch and parses json responses", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      release,
      response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    await expect(
      guardedJsonApiRequest({
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        body: { hello: "world" },
        errorPrefix: "request failed",
        headers: { Authorization: "Bearer token" },
        method: "POST",
        url: "https://api.example.com/v1/calls",
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      auditContext: "voice-call:test",
      init: {
        body: JSON.stringify({ hello: "world" }),
        headers: { Authorization: "Bearer token" },
        method: "POST",
      },
      policy: { allowedHostnames: ["api.example.com"] },
      url: "https://api.example.com/v1/calls",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for empty bodies and allowed 404s", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      release,
      response: new Response(null, { status: 204 }),
    });

    await expect(
      guardedJsonApiRequest({
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "request failed",
        headers: {},
        method: "GET",
        url: "https://api.example.com/v1/calls/1",
      }),
    ).resolves.toBeUndefined();

    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      release,
      response: new Response("missing", { status: 404 }),
    });

    await expect(
      guardedJsonApiRequest({
        allowNotFound: true,
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "request failed",
        headers: {},
        method: "GET",
        url: "https://api.example.com/v1/calls/2",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws prefixed errors and still releases the response handle", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      release,
      response: new Response("boom", { status: 500 }),
    });

    await expect(
      guardedJsonApiRequest({
        allowedHostnames: ["api.example.com"],
        auditContext: "voice-call:test",
        errorPrefix: "provider error",
        headers: {},
        method: "DELETE",
        url: "https://api.example.com/v1/calls/3",
      }),
    ).rejects.toThrow("provider error: 500 boom");

    expect(release).toHaveBeenCalledTimes(1);
  });
});
