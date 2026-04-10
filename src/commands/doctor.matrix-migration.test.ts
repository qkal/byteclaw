import { describe, expect, it, vi } from "vitest";
import {
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  runChannelPluginStartupMaintenance,
} from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";
import { doctorCommand } from "./doctor.js";

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: vi.fn(() => []),
}));

const DOCTOR_MIGRATION_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 45_000;

describe("doctor command", () => {
  it(
    "runs Matrix startup migration during repair flows",
    { timeout: DOCTOR_MIGRATION_TIMEOUT_MS },
    async () => {
      mockDoctorConfigSnapshot({
        config: {
          channels: {
            matrix: {
              accessToken: "tok-123",
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
            },
          },
        },
        parsed: {
          channels: {
            matrix: {
              accessToken: "tok-123",
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
            },
          },
        },
      });

      await doctorCommand(createDoctorRuntime(), { nonInteractive: true, repair: true });

      expect(runChannelPluginStartupMaintenance).toHaveBeenCalledTimes(1);
      expect(runChannelPluginStartupMaintenance).toHaveBeenCalledWith(
        expect.objectContaining({
          cfg: expect.objectContaining({
            channels: {
              matrix: {
                accessToken: "tok-123",
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
              },
            },
          }),
          log: expect.objectContaining({
            info: expect.any(Function),
            warn: expect.any(Function),
          }),
          logPrefix: "doctor",
          trigger: "doctor-fix",
        }),
      );
    },
  );
});
