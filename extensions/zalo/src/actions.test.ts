import { describe, expect, it } from "vitest";
import { zaloMessageActions } from "./actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("zaloMessageActions.describeMessageTool", () => {
  it("honors the selected Zalo account during discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          accounts: {
            default: {
              botToken: "default-token",
              enabled: false,
            },
            work: {
              botToken: "work-token",
              enabled: true,
            },
          },
          botToken: "root-token",
          enabled: true,
        },
      },
    };

    expect(zaloMessageActions.describeMessageTool?.({ accountId: "default", cfg })).toBeNull();
    expect(zaloMessageActions.describeMessageTool?.({ accountId: "work", cfg })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
  });
});
