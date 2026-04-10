import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  collectLegacyToolsBySenderWarnings,
  maybeRepairLegacyToolsBySenderKeys,
  scanLegacyToolsBySenderKeys,
} from "./legacy-tools-by-sender.js";

describe("doctor legacy toolsBySender helpers", () => {
  it("finds untyped legacy sender keys", () => {
    const hits = scanLegacyToolsBySenderKeys({
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: {
                "*": { deny: ["exec"] },
                "id:alice": { deny: ["exec"] },
                owner: { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      {
        key: "owner",
        pathLabel: "channels.whatsapp.groups.123@g.us.toolsBySender",
        targetKey: "id:owner",
        toolsBySenderPath: ["channels", "whatsapp", "groups", "123@g.us", "toolsBySender"],
      },
    ]);
  });

  it("migrates legacy sender keys to typed id entries", () => {
    const result = maybeRepairLegacyToolsBySenderKeys({
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              toolsBySender: {
                alice: { deny: ["exec"] },
                "id:owner": { allow: ["fs.read"] },
                owner: { deny: ["exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      expect.stringContaining("migrated 1 legacy key to typed id: entries"),
      expect.stringContaining("removed 1 legacy key where typed id: entries already existed"),
    ]);
    expect(result.config.channels?.whatsapp?.groups?.["123@g.us"]?.toolsBySender).toEqual({
      "id:alice": { deny: ["exec"] },
      "id:owner": { allow: ["fs.read"] },
    });
  });

  it("formats legacy sender key warnings", () => {
    const warnings = collectLegacyToolsBySenderWarnings({
      doctorFixCommand: "openclaw doctor --fix",
      hits: [
        {
          key: "owner",
          pathLabel: "channels.whatsapp.groups.123@g.us.toolsBySender",
          targetKey: "id:owner",
          toolsBySenderPath: ["channels", "whatsapp", "groups", "123@g.us", "toolsBySender"],
        },
      ],
    });

    expect(warnings).toEqual([
      expect.stringContaining("legacy untyped toolsBySender key"),
      expect.stringContaining("explicit prefixes"),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });
});
