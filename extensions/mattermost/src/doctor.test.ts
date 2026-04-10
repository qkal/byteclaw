import { describe, expect, it } from "vitest";
import { mattermostDoctor } from "./doctor.js";

describe("mattermost doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = mattermostDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
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
      } as never,
    });

    expect(result.config.channels?.mattermost?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.mattermost?.accounts?.work as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
