import { describe, expect, it } from "vitest";
import { tlonDoctor } from "./doctor.js";

describe("tlon doctor", () => {
  it("normalizes legacy private-network aliases", () => {
    const normalize = tlonDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          tlon: {
            accounts: {
              alt: {
                allowPrivateNetwork: false,
              },
            },
            allowPrivateNetwork: true,
          },
        },
      } as never,
    });

    expect(result.config.channels?.tlon?.network).toEqual({
      dangerouslyAllowPrivateNetwork: true,
    });
    expect(
      (
        result.config.channels?.tlon?.accounts?.alt as
          | { network?: Record<string, unknown> }
          | undefined
      )?.network,
    ).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
  });
});
