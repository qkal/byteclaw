import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce", () => {
  it("falls back to the main session when a subagent session key is forced", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "5m",
              target: "whatsapp",
            },
            workspace: tmpDir,
          },
        },
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
        session: { store: storePath },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "120363401234567890@g.us",
            sessionId: "sid-main",
            updatedAt: Date.now(),
          },
          "agent:main:subagent:demo": {
            lastChannel: "whatsapp",
            lastProvider: "whatsapp",
            lastTo: "120363409999999999@g.us",
            sessionId: "sid-subagent",
            updatedAt: Date.now(),
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "Final alert" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: () => 0,
          getReplyFromConfig: replySpy,
          nowMs: () => 0,
          whatsapp: sendWhatsApp,
        },
        sessionKey: "agent:main:subagent:demo",
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
          SessionKey: mainSessionKey,
        }),
        expect.anything(),
        cfg,
      );
    });
  });
});
