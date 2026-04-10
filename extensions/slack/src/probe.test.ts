import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const authTestMock = vi.hoisted(() => vi.fn());
const createSlackWebClientMock = vi.hoisted(() => vi.fn());
const withTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  withTimeout: withTimeoutMock,
}));

describe("probeSlack", () => {
  beforeEach(() => {
    authTestMock.mockReset();
    createSlackWebClientMock.mockReset();
    withTimeoutMock.mockReset();

    createSlackWebClientMock.mockReturnValue({
      auth: {
        test: authTestMock,
      },
    });
    withTimeoutMock.mockImplementation(async (promise: Promise<unknown>) => await promise);
  });

  it("maps Slack auth metadata on success", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      team: "OpenClaw",
      team_id: "T123",
      user: "openclaw-bot",
      user_id: "U123",
    });

    await expect(probeSlack("xoxb-test", 2500)).resolves.toEqual({
      bot: { id: "U123", name: "openclaw-bot" },
      elapsedMs: 45,
      ok: true,
      status: 200,
      team: { id: "T123", name: "OpenClaw" },
    });
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-test");
    expect(withTimeoutMock).toHaveBeenCalledWith(expect.any(Promise), 2500);
  });

  it("keeps optional auth metadata fields undefined when Slack omits them", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(235);
    authTestMock.mockResolvedValue({ ok: true });

    const result = await probeSlack("xoxb-test");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBe(35);
    expect(result.bot).toStrictEqual({ id: undefined, name: undefined });
    expect(result.team).toStrictEqual({ id: undefined, name: undefined });
  });
});
