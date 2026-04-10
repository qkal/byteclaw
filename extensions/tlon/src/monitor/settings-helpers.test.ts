import { describe, expect, it } from "vitest";
import type { TlonResolvedAccount } from "../types.js";
import {
  applyTlonSettingsOverrides,
  buildTlonSettingsMigrations,
  shouldMigrateTlonSetting,
} from "./settings-helpers.js";

const baseAccount: TlonResolvedAccount = {
  accountId: "default",
  autoAcceptDmInvites: true,
  autoAcceptGroupInvites: true,
  autoDiscoverChannels: true,
  code: "lidlut-tabwed-pillex-ridrup",
  configured: true,
  dangerouslyAllowPrivateNetwork: false,
  defaultAuthorizedShips: ["~nec"],
  dmAllowlist: ["~zod"],
  enabled: true,
  groupChannels: ["chat/~host/general"],
  groupInviteAllowlist: ["~bus"],
  name: "Tlon",
  ownerShip: "~marzod",
  ship: "~sampel-palnet",
  showModelSignature: false,
  url: "https://example.com",
};

describe("shouldMigrateTlonSetting", () => {
  it("does not rehydrate explicit empty-array revocations during startup migration", () => {
    const migrations = buildTlonSettingsMigrations(baseAccount, {
      defaultAuthorizedShips: [],
      dmAllowlist: [],
      groupInviteAllowlist: [],
    });

    expect(
      Object.fromEntries(
        migrations
          .filter((migration) =>
            ["dmAllowlist", "groupInviteAllowlist", "defaultAuthorizedShips"].includes(
              migration.key,
            ),
          )
          .map((migration) => [
            migration.key,
            shouldMigrateTlonSetting(migration.fileValue, migration.settingsValue),
          ]),
      ),
    ).toEqual({
      defaultAuthorizedShips: false,
      dmAllowlist: false,
      groupInviteAllowlist: false,
    });
  });

  it("still seeds file-config allowlists on first run when settings are missing", () => {
    const migrations = buildTlonSettingsMigrations(baseAccount, {});

    expect(
      Object.fromEntries(
        migrations
          .filter((migration) =>
            ["dmAllowlist", "groupInviteAllowlist", "defaultAuthorizedShips"].includes(
              migration.key,
            ),
          )
          .map((migration) => [
            migration.key,
            shouldMigrateTlonSetting(migration.fileValue, migration.settingsValue),
          ]),
      ),
    ).toEqual({
      defaultAuthorizedShips: true,
      dmAllowlist: true,
      groupInviteAllowlist: true,
    });
  });
});

describe("applyTlonSettingsOverrides", () => {
  it("treats explicit empty settings allowlists as authoritative deny-all", () => {
    const result = applyTlonSettingsOverrides({
      account: baseAccount,
      currentSettings: {
        dmAllowlist: [],
        groupInviteAllowlist: [],
      },
    });

    expect(result.effectiveDmAllowlist).toEqual([]);
    expect(result.effectiveGroupInviteAllowlist).toEqual([]);
  });

  it("falls back to file config when settings fields are removed", () => {
    const result = applyTlonSettingsOverrides({
      account: baseAccount,
      currentSettings: {},
    });

    expect(result.effectiveDmAllowlist).toEqual(baseAccount.dmAllowlist);
    expect(result.effectiveGroupInviteAllowlist).toEqual(baseAccount.groupInviteAllowlist);
    expect(result.effectiveAutoDiscoverChannels).toBe(baseAccount.autoDiscoverChannels);
    expect(result.effectiveOwnerShip).toBe(baseAccount.ownerShip);
  });

  it("keeps other explicit settings overrides authoritative", () => {
    const result = applyTlonSettingsOverrides({
      account: baseAccount,
      currentSettings: {
        autoAcceptDmInvites: false,
        autoAcceptGroupInvites: false,
        autoDiscoverChannels: false,
        ownerShip: "~nec",
        pendingApprovals: [],
        showModelSig: true,
      },
    });

    expect(result.effectiveAutoDiscoverChannels).toBe(false);
    expect(result.effectiveAutoAcceptDmInvites).toBe(false);
    expect(result.effectiveAutoAcceptGroupInvites).toBe(false);
    expect(result.effectiveShowModelSig).toBe(true);
    expect(result.effectiveOwnerShip).toBe("~nec");
    expect(result.pendingApprovals).toEqual([]);
  });
});
