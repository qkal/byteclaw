import { describe, expect, it } from "vitest";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";

describe("bundled channel legacy config migrations", () => {
  it("normalizes legacy private-network aliases exposed through bundled contract surfaces", () => {
    const result = applyChannelDoctorCompatibilityMigrations({
      channels: {
        mattermost: {
          accounts: {
            work: {
              allowPrivateNetwork: false,
            },
          },
          allowPrivateNetwork: true,
        },
      },
    });

    const nextChannels = (result.next.channels ?? {}) as {
      mattermost?: Record<string, unknown>;
    };

    expect(nextChannels.mattermost).toEqual({
      accounts: {
        work: {
          network: {
            dangerouslyAllowPrivateNetwork: false,
          },
        },
      },
      network: {
        dangerouslyAllowPrivateNetwork: true,
      },
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.mattermost.allowPrivateNetwork → channels.mattermost.network.dangerouslyAllowPrivateNetwork (true).",
        "Moved channels.mattermost.accounts.work.allowPrivateNetwork → channels.mattermost.accounts.work.network.dangerouslyAllowPrivateNetwork (false).",
      ]),
    );
  });
});
