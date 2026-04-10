import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime-api.js";
import type { CoreConfig, MatrixRoomConfig } from "../../types.js";
import { resolveMatrixMonitorConfig } from "./config.js";

type MatrixRoomsConfig = Record<string, MatrixRoomConfig>;

function createRuntime() {
  const runtime: RuntimeEnv = {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
  return runtime;
}

describe("resolveMatrixMonitorConfig", () => {
  it("canonicalizes resolved user aliases and room keys without keeping stale aliases", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ inputs, kind }: { inputs: string[]; kind: "user" | "group" }) => {
        if (kind === "user") {
          return inputs.map((input) => {
            if (input === "Bob") {
              return { id: "@bob:example.org", input, resolved: true };
            }
            if (input === "Dana") {
              return { id: "@dana:example.org", input, resolved: true };
            }
            return { input, resolved: false };
          });
        }
        return inputs.map((input) =>
          input === "General"
            ? { id: "!general:example.org", input, resolved: true }
            : { input, resolved: false },
        );
      },
    );

    const roomsConfig: MatrixRoomsConfig = {
      "*": { enabled: true },
      General: {
        enabled: true,
      },
      "room:!ops:example.org": {
        enabled: true,
        users: ["Dana", "user:@Erin:Example.org"],
      },
    };

    const result = await resolveMatrixMonitorConfig({
      accountId: "ops",
      allowFrom: ["matrix:@Alice:Example.org", "Bob"],
      cfg: {} as CoreConfig,
      groupAllowFrom: ["user:@Carol:Example.org"],
      resolveTargets,
      roomsConfig,
      runtime,
    });

    expect(result.allowFrom).toEqual(["@alice:example.org", "@bob:example.org"]);
    expect(result.groupAllowFrom).toEqual(["@carol:example.org"]);
    expect(result.roomsConfig).toEqual({
      "!general:example.org": {
        enabled: true,
      },
      "!ops:example.org": {
        enabled: true,
        users: ["@dana:example.org", "@erin:example.org"],
      },
      "*": { enabled: true },
    });
    expect(resolveTargets).toHaveBeenCalledTimes(3);
    expect(resolveTargets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "ops",
        inputs: ["Bob"],
        kind: "user",
      }),
    );
    expect(resolveTargets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "ops",
        inputs: ["General"],
        kind: "group",
      }),
    );
    expect(resolveTargets).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        accountId: "ops",
        inputs: ["Dana"],
        kind: "user",
      }),
    );
  });

  it("strips config prefixes before lookups and logs unresolved guidance once per section", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) =>
        inputs.map((input) => ({
          input,
          resolved: false,
          ...(kind === "group" ? { note: `missing ${input}` } : {}),
        })),
    );

    const result = await resolveMatrixMonitorConfig({
      accountId: "ops",
      allowFrom: ["user:Ghost"],
      cfg: {} as CoreConfig,
      groupAllowFrom: ["matrix:@known:example.org"],
      resolveTargets,
      roomsConfig: {
        "channel:Project X": {
          enabled: true,
          users: ["matrix:Ghost"],
        },
      },
      runtime,
    });

    expect(result.allowFrom).toEqual([]);
    expect(result.groupAllowFrom).toEqual(["@known:example.org"]);
    expect(result.roomsConfig).toEqual({});
    expect(resolveTargets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "ops",
        inputs: ["Ghost"],
        kind: "user",
      }),
    );
    expect(resolveTargets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "ops",
        inputs: ["Project X"],
        kind: "group",
      }),
    );
    expect(resolveTargets).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith("matrix dm allowlist unresolved: user:Ghost");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix dm allowlist entries must be full Matrix IDs (example: @user:server). Unresolved entries are ignored.",
    );
    expect(runtime.log).toHaveBeenCalledWith("matrix rooms unresolved: channel:Project X");
    expect(runtime.log).toHaveBeenCalledWith(
      "matrix rooms must be room IDs or aliases (example: !room:server or #alias:server). Unresolved entries are ignored.",
    );
  });

  it("resolves exact room aliases to canonical room ids instead of trusting alias keys directly", async () => {
    const runtime = createRuntime();
    const resolveTargets = vi.fn(
      async ({ kind, inputs }: { inputs: string[]; kind: "user" | "group" }) => {
        if (kind === "group") {
          return inputs.map((input) =>
            input === "#allowed:example.org"
              ? { id: "!allowed-room:example.org", input, resolved: true }
              : { input, resolved: false },
          );
        }
        return [];
      },
    );

    const result = await resolveMatrixMonitorConfig({
      accountId: "ops",
      cfg: {} as CoreConfig,
      resolveTargets,
      roomsConfig: {
        "#allowed:example.org": {
          enabled: true,
        },
      },
      runtime,
    });

    expect(result.roomsConfig).toEqual({
      "!allowed-room:example.org": {
        enabled: true,
      },
    });
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ops",
        inputs: ["#allowed:example.org"],
        kind: "group",
      }),
    );
  });
});
