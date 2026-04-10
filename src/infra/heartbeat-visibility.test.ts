import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";

describe("resolveHeartbeatVisibility", () => {
  function createChannelDefaultsHeartbeatConfig(heartbeat: {
    showOk?: boolean;
    showAlerts?: boolean;
    useIndicator?: boolean;
  }): OpenClawConfig {
    return {
      channels: {
        defaults: {
          heartbeat,
        },
      },
    } as OpenClawConfig;
  }

  function createTelegramAccountHeartbeatConfig(): OpenClawConfig {
    return {
      channels: {
        telegram: {
          accounts: {
            primary: {
              heartbeat: {
                showOk: false,
              },
            },
          },
          heartbeat: {
            showOk: true,
          },
        },
      },
    } as OpenClawConfig;
  }

  it("returns default values when no config is provided", () => {
    const cfg = {} as OpenClawConfig;
    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result).toEqual({
      showAlerts: true,
      showOk: false,
      useIndicator: true,
    });
  });

  it("uses channel defaults when provided", () => {
    const cfg = createChannelDefaultsHeartbeatConfig({
      showAlerts: false,
      showOk: true,
      useIndicator: false,
    });

    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result).toEqual({
      showAlerts: false,
      showOk: true,
      useIndicator: false,
    });
  });

  it("per-channel config overrides channel defaults", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showAlerts: true,
            showOk: false,
            useIndicator: true,
          },
        },
        telegram: {
          heartbeat: {
            showOk: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result).toEqual({
      showAlerts: true,
      showOk: true,
      useIndicator: true,
    });
  });

  it("per-account config overrides per-channel config", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showAlerts: true,
            showOk: false,
            useIndicator: true,
          },
        },
        telegram: {
          accounts: {
            primary: {
              heartbeat: {
                showAlerts: true,
                showOk: true,
              },
            },
          },
          heartbeat: {
            showAlerts: false,
            showOk: false,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({
      accountId: "primary",
      cfg,
      channel: "telegram",
    });

    expect(result).toEqual({
      showAlerts: true,
      showOk: true,
      useIndicator: true,
    });
  });

  it("falls through to defaults when account has no heartbeat config", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
          },
        },
        telegram: {
          accounts: {
            primary: {},
          },
          heartbeat: {
            showAlerts: false,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({
      accountId: "primary",
      cfg,
      channel: "telegram",
    });

    expect(result).toEqual({
      showAlerts: false,
      showOk: false,
      useIndicator: true,
    });
  });

  it("handles missing accountId gracefully", () => {
    const cfg = createTelegramAccountHeartbeatConfig();
    const result = resolveHeartbeatVisibility({ cfg, channel: "telegram" });

    expect(result.showOk).toBe(true);
  });

  it("handles non-existent account gracefully", () => {
    const cfg = createTelegramAccountHeartbeatConfig();
    const result = resolveHeartbeatVisibility({
      accountId: "nonexistent",
      cfg,
      channel: "telegram",
    });

    expect(result.showOk).toBe(true);
  });

  it("works with whatsapp channel", () => {
    const cfg = {
      channels: {
        whatsapp: {
          heartbeat: {
            showAlerts: false,
            showOk: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "whatsapp" });

    expect(result).toEqual({
      showAlerts: false,
      showOk: true,
      useIndicator: true,
    });
  });

  it("works with discord channel", () => {
    const cfg = {
      channels: {
        discord: {
          heartbeat: {
            useIndicator: false,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "discord" });

    expect(result).toEqual({
      showAlerts: true,
      showOk: false,
      useIndicator: false,
    });
  });

  it("works with slack channel", () => {
    const cfg = {
      channels: {
        slack: {
          heartbeat: {
            showAlerts: true,
            showOk: true,
            useIndicator: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "slack" });

    expect(result).toEqual({
      showAlerts: true,
      showOk: true,
      useIndicator: true,
    });
  });

  it("webchat uses channel defaults only (no per-channel config)", () => {
    const cfg = createChannelDefaultsHeartbeatConfig({
      showAlerts: false,
      showOk: true,
      useIndicator: false,
    });

    const result = resolveHeartbeatVisibility({ cfg, channel: "webchat" });

    expect(result).toEqual({
      showAlerts: false,
      showOk: true,
      useIndicator: false,
    });
  });

  it("webchat returns defaults when no channel defaults configured", () => {
    const cfg = {} as OpenClawConfig;

    const result = resolveHeartbeatVisibility({ cfg, channel: "webchat" });

    expect(result).toEqual({
      showAlerts: true,
      showOk: false,
      useIndicator: true,
    });
  });

  it("webchat ignores accountId (only uses defaults)", () => {
    const cfg = {
      channels: {
        defaults: {
          heartbeat: {
            showOk: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveHeartbeatVisibility({
      accountId: "some-account",
      cfg,
      channel: "webchat",
    });

    expect(result.showOk).toBe(true);
  });
});
