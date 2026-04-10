import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveWebhooksPluginConfig } from "./config.js";

describe("resolveWebhooksPluginConfig", () => {
  it("resolves default paths and SecretRef-backed secrets", async () => {
    const routes = await resolveWebhooksPluginConfig({
      cfg: {} as OpenClawConfig,
      env: {
        OPENCLAW_WEBHOOK_SECRET: "shared-secret",
      },
      pluginConfig: {
        routes: {
          zapier: {
            secret: {
              id: "OPENCLAW_WEBHOOK_SECRET",
              provider: "default",
              source: "env",
            },
            sessionKey: "agent:main:main",
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        controllerId: "webhooks/zapier",
        path: "/plugins/webhooks/zapier",
        routeId: "zapier",
        secret: "shared-secret",
        sessionKey: "agent:main:main",
      },
    ]);
  });

  it("skips routes whose secret cannot be resolved", async () => {
    const warn = vi.fn();

    const routes = await resolveWebhooksPluginConfig({
      cfg: {} as OpenClawConfig,
      env: {},
      logger: { warn } as never,
      pluginConfig: {
        routes: {
          missing: {
            secret: {
              id: "MISSING_SECRET",
              provider: "default",
              source: "env",
            },
            sessionKey: "agent:main:main",
          },
        },
      },
    });

    expect(routes).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[webhooks] skipping route missing:"),
    );
  });

  it("rejects duplicate normalized paths", async () => {
    await expect(
      resolveWebhooksPluginConfig({
        cfg: {} as OpenClawConfig,
        env: {},
        pluginConfig: {
          routes: {
            first: {
              path: "/plugins/webhooks/shared",
              secret: "a",
              sessionKey: "agent:main:main",
            },
            second: {
              path: "/plugins/webhooks/shared/",
              secret: "b",
              sessionKey: "agent:main:other",
            },
          },
        },
      }),
    ).rejects.toThrow(/conflicts with routes\.first\.path/i);
  });
});
