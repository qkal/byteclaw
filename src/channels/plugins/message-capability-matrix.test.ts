import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelMessageActionAdapter, ChannelPlugin } from "./types.js";

const telegramDescribeMessageToolMock = vi.fn();
const discordDescribeMessageToolMock = vi.fn();

const telegramPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => telegramDescribeMessageToolMock({ cfg }),
    supportsAction: () => true,
  },
};

const discordPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => discordDescribeMessageToolMock({ cfg }),
    supportsAction: () => true,
  },
};

// Keep this matrix focused on capability wiring. The extension packages already
// Cover their own full channel/plugin boot paths, so local stubs are enough here.
const slackPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.slack;
      const enabled =
        typeof account?.botToken === "string" &&
        account.botToken.trim() !== "" &&
        typeof account?.appToken === "string" &&
        account.appToken.trim() !== "";
      const capabilities = new Set<string>();
      if (enabled) {
        capabilities.add("blocks");
      }
      if (
        account?.capabilities &&
        (account.capabilities as { interactiveReplies?: unknown }).interactiveReplies === true
      ) {
        capabilities.add("interactive");
      }
      return {
        actions: enabled ? ["send"] : [],
        capabilities: [...capabilities] as ("blocks" | "interactive")[],
      };
    },
    supportsAction: () => true,
  },
};

const mattermostPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.mattermost;
      const enabled =
        account?.enabled !== false &&
        typeof account?.botToken === "string" &&
        account.botToken.trim() !== "" &&
        typeof account?.baseUrl === "string" &&
        account.baseUrl.trim() !== "";
      return {
        actions: enabled ? ["send"] : [],
        capabilities: enabled ? (["buttons"] as const) : [],
      };
    },
    supportsAction: () => true,
  },
};

const feishuPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.feishu;
      const enabled =
        account?.enabled !== false &&
        typeof account?.appId === "string" &&
        account.appId.trim() !== "" &&
        typeof account?.appSecret === "string" &&
        account.appSecret.trim() !== "";
      return {
        actions: enabled ? ["send"] : [],
        capabilities: enabled ? (["cards"] as const) : [],
      };
    },
    supportsAction: () => true,
  },
};

const msteamsPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: ({ cfg }) => {
      const account = cfg.channels?.msteams;
      const enabled =
        account?.enabled !== false &&
        typeof account?.tenantId === "string" &&
        account.tenantId.trim() !== "" &&
        typeof account?.appId === "string" &&
        account.appId.trim() !== "" &&
        typeof account?.appPassword === "string" &&
        account.appPassword.trim() !== "";
      return {
        actions: enabled ? ["poll"] : [],
        capabilities: enabled ? (["cards"] as const) : [],
      };
    },
    supportsAction: () => true,
  },
};

const zaloPlugin: Pick<ChannelPlugin, "actions"> = {
  actions: {
    describeMessageTool: () => ({ actions: [], capabilities: [] }),
    supportsAction: () => true,
  },
};

describe("channel action capability matrix", () => {
  afterEach(() => {
    telegramDescribeMessageToolMock.mockReset();
    discordDescribeMessageToolMock.mockReset();
  });

  function getCapabilities(plugin: Pick<ChannelPlugin, "actions">, cfg: OpenClawConfig) {
    const describeMessageTool: ChannelMessageActionAdapter["describeMessageTool"] | undefined =
      plugin.actions?.describeMessageTool;
    return [...(describeMessageTool?.({ cfg })?.capabilities ?? [])];
  }

  it("exposes Slack blocks by default and interactive when enabled", () => {
    const baseCfg = {
      channels: {
        slack: {
          appToken: "xapp-test",
          botToken: "xoxb-test",
        },
      },
    } as OpenClawConfig;
    const interactiveCfg = {
      channels: {
        slack: {
          appToken: "xapp-test",
          botToken: "xoxb-test",
          capabilities: { interactiveReplies: true },
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(slackPlugin, baseCfg)).toEqual(["blocks"]);
    expect(getCapabilities(slackPlugin, interactiveCfg)).toEqual(["blocks", "interactive"]);
  });

  it("forwards Telegram action capabilities through the channel wrapper", () => {
    telegramDescribeMessageToolMock.mockReturnValue({
      capabilities: ["interactive", "buttons"],
    });

    const result = getCapabilities(telegramPlugin, {} as OpenClawConfig);

    expect(result).toEqual(["interactive", "buttons"]);
    expect(telegramDescribeMessageToolMock).toHaveBeenCalledWith({ cfg: {} });
    discordDescribeMessageToolMock.mockReturnValue({
      capabilities: ["interactive", "components"],
    });

    const discordResult = getCapabilities(discordPlugin, {} as OpenClawConfig);

    expect(discordResult).toEqual(["interactive", "components"]);
    expect(discordDescribeMessageToolMock).toHaveBeenCalledWith({ cfg: {} });
  });

  it("exposes configured channel capabilities only when required credentials are present", () => {
    const configuredCfg = {
      channels: {
        mattermost: {
          baseUrl: "https://chat.example.com",
          botToken: "mm-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const unconfiguredCfg = {
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const configuredFeishuCfg = {
      channels: {
        feishu: {
          appId: "cli_a",
          appSecret: "secret",
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const disabledFeishuCfg = {
      channels: {
        feishu: {
          appId: "cli_a",
          appSecret: "secret",
          enabled: false,
        },
      },
    } as OpenClawConfig;
    const configuredMsteamsCfg = {
      channels: {
        msteams: {
          appId: "app",
          appPassword: "secret",
          enabled: true,
          tenantId: "tenant",
        },
      },
    } as OpenClawConfig;
    const disabledMsteamsCfg = {
      channels: {
        msteams: {
          appId: "app",
          appPassword: "secret",
          enabled: false,
          tenantId: "tenant",
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(mattermostPlugin, configuredCfg)).toEqual(["buttons"]);
    expect(getCapabilities(mattermostPlugin, unconfiguredCfg)).toEqual([]);
    expect(getCapabilities(feishuPlugin, configuredFeishuCfg)).toEqual(["cards"]);
    expect(getCapabilities(feishuPlugin, disabledFeishuCfg)).toEqual([]);
    expect(getCapabilities(msteamsPlugin, configuredMsteamsCfg)).toEqual(["cards"]);
    expect(getCapabilities(msteamsPlugin, disabledMsteamsCfg)).toEqual([]);
  });

  it("keeps Zalo actions on the empty capability set", () => {
    const cfg = {
      channels: {
        zalo: {
          botToken: "zl-token",
          enabled: true,
        },
      },
    } as OpenClawConfig;

    expect(getCapabilities(zaloPlugin, cfg)).toEqual([]);
  });
});
