import { describe, expect, it, vi } from "vitest";

let writtenConfig: unknown = null;

vi.mock("../../config/config.js", () => ({
    loadConfig: () => ({
      skills: {
        entries: {},
      },
    }),
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
  }));

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      client: null as never,
      context: {} as never,
      isWebchatConnect: () => false,
      params: {
        apiKey: "abc\r\ndef",
        skillKey: "brave-search",
      },
      req: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
  });
});
