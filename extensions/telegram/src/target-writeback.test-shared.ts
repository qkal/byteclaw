import type { OpenClawConfig } from "openclaw/plugin-sdk/testing";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;

export const readConfigFileSnapshotForWrite: AsyncUnknownMock = vi.fn();
export const writeConfigFile: AsyncUnknownMock = vi.fn();
export const loadCronStore: AsyncUnknownMock = vi.fn();
export const resolveCronStorePath: UnknownMock = vi.fn();
export const saveCronStore: AsyncUnknownMock = vi.fn();

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadCronStore,
    readConfigFileSnapshotForWrite,
    resolveCronStorePath,
    saveCronStore,
    writeConfigFile,
  };
});

export function installMaybePersistResolvedTelegramTargetTests(params?: {
  includeGatewayScopeCases?: boolean;
}) {
  describe("maybePersistResolvedTelegramTarget", () => {
    let maybePersistResolvedTelegramTarget: typeof import("./target-writeback.js").maybePersistResolvedTelegramTarget;

    beforeEach(async () => {
      vi.resetModules();
      ({ maybePersistResolvedTelegramTarget } = await import("./target-writeback.js"));
      readConfigFileSnapshotForWrite.mockReset();
      writeConfigFile.mockReset();
      loadCronStore.mockReset();
      resolveCronStorePath.mockReset();
      saveCronStore.mockReset();
      resolveCronStorePath.mockReturnValue("/tmp/cron/jobs.json");
    });

    it("skips writeback when target is already numeric", async () => {
      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "-100123",
        resolvedChatId: "-100123",
      });

      expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
      expect(loadCronStore).not.toHaveBeenCalled();
    });

    if (params?.includeGatewayScopeCases) {
      it("skips config and cron writeback for gateway callers missing operator.admin", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          gatewayClientScopes: ["operator.write"],
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(loadCronStore).not.toHaveBeenCalled();
        expect(saveCronStore).not.toHaveBeenCalled();
      });

      it("skips config and cron writeback for gateway callers with an empty scope set", async () => {
        await maybePersistResolvedTelegramTarget({
          cfg: {
            cron: { store: "/tmp/cron/jobs.json" },
          } as OpenClawConfig,
          gatewayClientScopes: [],
          rawTarget: "t.me/mychannel",
          resolvedChatId: "-100123",
        });

        expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
        expect(writeConfigFile).not.toHaveBeenCalled();
        expect(loadCronStore).not.toHaveBeenCalled();
        expect(saveCronStore).not.toHaveBeenCalled();
      });
    }

    it("writes back matching config and cron targets", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                accounts: {
                  alerts: {
                    defaultTo: "@mychannel",
                  },
                },
                defaultTo: "t.me/mychannel",
              },
            },
          },
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
      loadCronStore.mockResolvedValue({
        jobs: [
          { delivery: { channel: "telegram", to: "https://t.me/mychannel" }, id: "a" },
          { delivery: { channel: "slack", to: "C123" }, id: "b" },
        ],
        version: 1,
      });

      await maybePersistResolvedTelegramTarget({
        cfg: {
          cron: { store: "/tmp/cron/jobs.json" },
        } as OpenClawConfig,
        rawTarget: "t.me/mychannel",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              accounts: {
                alerts: {
                  defaultTo: "-100123",
                },
              },
              defaultTo: "-100123",
            },
          },
        }),
        expect.objectContaining({ expectedConfigPath: "/tmp/openclaw.json" }),
      );
      expect(saveCronStore).toHaveBeenCalledTimes(1);
      expect(saveCronStore).toHaveBeenCalledWith(
        "/tmp/cron/jobs.json",
        expect.objectContaining({
          jobs: [
            { delivery: { channel: "telegram", to: "-100123" }, id: "a" },
            { delivery: { channel: "slack", to: "C123" }, id: "b" },
          ],
        }),
      );
    });

    it("preserves topic suffix style in writeback target", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "t.me/mychannel:topic:9",
              },
            },
          },
        },
        writeOptions: {},
      });
      loadCronStore.mockResolvedValue({ jobs: [], version: 1 });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "t.me/mychannel:topic:9",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123:topic:9",
            },
          },
        }),
        expect.any(Object),
      );
    });

    it("matches username targets case-insensitively", async () => {
      readConfigFileSnapshotForWrite.mockResolvedValue({
        snapshot: {
          config: {
            channels: {
              telegram: {
                defaultTo: "https://t.me/mychannel",
              },
            },
          },
        },
        writeOptions: {},
      });
      loadCronStore.mockResolvedValue({
        jobs: [{ delivery: { channel: "telegram", to: "https://t.me/mychannel" }, id: "a" }],
        version: 1,
      });

      await maybePersistResolvedTelegramTarget({
        cfg: {} as OpenClawConfig,
        rawTarget: "@MyChannel",
        resolvedChatId: "-100123",
      });

      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            telegram: {
              defaultTo: "-100123",
            },
          },
        }),
        expect.any(Object),
      );
      expect(saveCronStore).toHaveBeenCalledWith(
        "/tmp/cron/jobs.json",
        expect.objectContaining({
          jobs: [{ delivery: { channel: "telegram", to: "-100123" }, id: "a" }],
        }),
      );
    });
  });
}
