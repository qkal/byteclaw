import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  buildOpenGroupPolicyNoRouteAllowlistWarning,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
  collectAllowlistProviderGroupPolicyWarnings,
  collectAllowlistProviderRestrictSendersWarnings,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenGroupPolicyRestrictSendersWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  collectOpenProviderGroupPolicyWarnings,
  composeAccountWarningCollectors,
  composeWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createAllowlistProviderOpenWarningCollector,
  createAllowlistProviderRestrictSendersWarningCollector,
  createAllowlistProviderRouteAllowlistWarningCollector,
  createConditionalWarningCollector,
  createOpenGroupPolicyRestrictSendersWarningCollector,
  createOpenProviderConfiguredRouteWarningCollector,
  createOpenProviderGroupPolicyWarningCollector,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
  projectConfigAccountIdWarningCollector,
  projectConfigWarningCollector,
  projectWarningCollector,
} from "./group-policy-warnings.js";

describe("group policy warning builders", () => {
  it("composes warning collectors", () => {
    const collect = composeWarningCollectors<{ enabled: boolean }>(
      () => ["a"],
      ({ enabled }) => (enabled ? ["b"] : []),
    );

    expect(collect({ enabled: true })).toEqual(["a", "b"]);
    expect(collect({ enabled: false })).toEqual(["a"]);
  });

  it("projects warning collector inputs", () => {
    const collect = projectWarningCollector(
      ({ value }: { value: string }) => value,
      (value: string) => [value.toUpperCase()],
    );

    expect(collect({ value: "abc" })).toEqual(["ABC"]);
  });

  it("projects cfg-only warning collector inputs", () => {
    const collect = projectConfigWarningCollector<{ cfg: OpenClawConfig; accountId: string }>(
      ({ cfg }) => [cfg.channels ? "configured" : "none"],
    );

    expect(
      collect({
        accountId: "acct-1",
        cfg: { channels: { slack: {} } } as OpenClawConfig,
      }),
    ).toEqual(["configured"]);
  });

  it("projects cfg+accountId warning collector inputs", () => {
    const collect = projectConfigAccountIdWarningCollector<{
      cfg: OpenClawConfig;
      accountId?: string | null;
      account: { accountId: string };
    }>(({ accountId }) => [accountId ?? "default"]);

    expect(
      collect({
        account: { accountId: "ignored" },
        accountId: "acct-1",
        cfg: {} as OpenClawConfig,
      }),
    ).toEqual(["acct-1"]);
  });

  it("projects account-only warning collector inputs", () => {
    const collect = projectAccountWarningCollector<
      { accountId: string },
      { account: { accountId: string } }
    >((account) => [account.accountId]);

    expect(collect({ account: { accountId: "acct-1" } })).toEqual(["acct-1"]);
  });

  it("projects account+cfg warning collector inputs", () => {
    const collect = projectAccountConfigWarningCollector<
      { accountId: string },
      Record<string, unknown>,
      { account: { accountId: string }; cfg: OpenClawConfig }
    >(
      (cfg: OpenClawConfig) => cfg.channels ?? {},
      ({ account, cfg }) => [String(account.accountId), Object.keys(cfg).join(",") || "none"],
    );

    expect(
      collect({
        account: { accountId: "acct-1" },
        cfg: { channels: { slack: {} } } as OpenClawConfig,
      }),
    ).toEqual(["acct-1", "slack"]);
  });

  it("builds conditional warning collectors", () => {
    const collect = createConditionalWarningCollector<{ open: boolean; token?: string }>(
      ({ open }) => (open ? "open" : undefined),
      ({ token }) => (token ? undefined : ["missing token", "cannot send replies"]),
    );

    expect(collect({ open: true })).toEqual(["open", "missing token", "cannot send replies"]);
    expect(collect({ open: false, token: "x" })).toEqual([]);
  });

  it("composes account-scoped warning collectors", () => {
    const collect = composeAccountWarningCollectors<
      { enabled: boolean },
      { account: { enabled: boolean } }
    >(
      () => ["base"],
      (account) => (account.enabled ? "enabled" : undefined),
      () => ["extra-a", "extra-b"],
    );

    expect(collect({ account: { enabled: true } })).toEqual([
      "base",
      "enabled",
      "extra-a",
      "extra-b",
    ]);
    expect(collect({ account: { enabled: false } })).toEqual(["base", "extra-a", "extra-b"]);
  });

  it("builds base open-policy warning", () => {
    expect(
      buildOpenGroupPolicyWarning({
        openBehavior: "allows any member to trigger (mention-gated)",
        remediation: 'Set channels.example.groupPolicy="allowlist"',
        surface: "Example groups",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.example.groupPolicy="allowlist".',
    );
  });

  it("builds restrict-senders warning", () => {
    expect(
      buildOpenGroupPolicyRestrictSendersWarning({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member in allowed groups",
        surface: "Example groups",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom to restrict senders.',
    );
  });

  it("builds no-route-allowlist warning", () => {
    expect(
      buildOpenGroupPolicyNoRouteAllowlistWarning({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        surface: "Example groups",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
    );
  });

  it("builds configure-route-allowlist warning", () => {
    expect(
      buildOpenGroupPolicyConfigureRouteAllowlistWarning({
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any channel not explicitly denied",
        routeAllowlistPath: "channels.example.channels",
        surface: "Example channels",
      }),
    ).toBe(
      '- Example channels: groupPolicy="open" allows any channel not explicitly denied to trigger (mention-gated). Set channels.example.groupPolicy="allowlist" and configure channels.example.channels.',
    );
  });

  it("collects restrict-senders warning only for open policy", () => {
    expect(
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicy: "allowlist",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member",
        surface: "Example groups",
      }),
    ).toEqual([]);

    expect(
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicy: "open",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member",
        surface: "Example groups",
      }),
    ).toHaveLength(1);
  });

  it("resolves allowlist-provider runtime policy before collecting restrict-senders warnings", () => {
    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
          },
        },
        configuredGroupPolicy: undefined,
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member",
        providerConfigPresent: false,
        surface: "Example groups",
      }),
    ).toEqual([]);

    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
          },
        },
        configuredGroupPolicy: "open",
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member",
        providerConfigPresent: true,
        surface: "Example groups",
      }),
    ).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member",
        surface: "Example groups",
      }),
    ]);
  });

  it("passes resolved allowlist-provider policy into the warning collector", () => {
    expect(
      collectAllowlistProviderGroupPolicyWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
          },
        },
        collect: (groupPolicy) => [groupPolicy],
        configuredGroupPolicy: undefined,
        providerConfigPresent: false,
      }),
    ).toEqual(["allowlist"]);

    expect(
      collectAllowlistProviderGroupPolicyWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "disabled" },
          },
        },
        collect: (groupPolicy) => [groupPolicy],
        configuredGroupPolicy: "open",
        providerConfigPresent: true,
      }),
    ).toEqual(["open"]);
  });

  it("passes resolved open-provider policy into the warning collector", () => {
    expect(
      collectOpenProviderGroupPolicyWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "allowlist" },
          },
        },
        collect: (groupPolicy) => [groupPolicy],
        configuredGroupPolicy: undefined,
        providerConfigPresent: false,
      }),
    ).toEqual(["allowlist"]);

    expect(
      collectOpenProviderGroupPolicyWarnings({
        cfg: {},
        collect: (groupPolicy) => [groupPolicy],
        configuredGroupPolicy: undefined,
        providerConfigPresent: true,
      }),
    ).toEqual(["open"]);

    expect(
      collectOpenProviderGroupPolicyWarnings({
        cfg: {},
        collect: (groupPolicy) => [groupPolicy],
        configuredGroupPolicy: "disabled",
        providerConfigPresent: true,
      }),
    ).toEqual(["disabled"]);
  });

  it("collects route allowlist warning variants", () => {
    const params = {
      groupPolicy: "open" as const,
      noRouteAllowlist: {
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        surface: "Example groups",
      },
      restrictSenders: {
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member in allowed groups",
        surface: "Example groups",
      },
    };

    expect(
      collectOpenGroupPolicyRouteAllowlistWarnings({
        ...params,
        routeAllowlistConfigured: true,
      }),
    ).toEqual([buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)]);

    expect(
      collectOpenGroupPolicyRouteAllowlistWarnings({
        ...params,
        routeAllowlistConfigured: false,
      }),
    ).toEqual([buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)]);
  });

  it("collects configured-route warning variants", () => {
    const params = {
      configureRouteAllowlist: {
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any channel not explicitly denied",
        routeAllowlistPath: "channels.example.channels",
        surface: "Example channels",
      },
      groupPolicy: "open" as const,
      missingRouteAllowlist: {
        openBehavior: "with no route allowlist; any channel can trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
        surface: "Example channels",
      },
    };

    expect(
      collectOpenGroupPolicyConfiguredRouteWarnings({
        ...params,
        routeAllowlistConfigured: true,
      }),
    ).toEqual([buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)]);

    expect(
      collectOpenGroupPolicyConfiguredRouteWarnings({
        ...params,
        routeAllowlistConfigured: false,
      }),
    ).toEqual([buildOpenGroupPolicyWarning(params.missingRouteAllowlist)]);
  });

  it("builds account-aware allowlist-provider restrict-senders collectors", () => {
    const collectWarnings = createAllowlistProviderRestrictSendersWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      groupAllowFromPath: "channels.example.groupAllowFrom",
      groupPolicyPath: "channels.example.groupPolicy",
      openScope: "any member",
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      surface: "Example groups",
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open" },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member",
        surface: "Example groups",
      }),
    ]);
  });

  it("builds config-aware allowlist-provider collectors", () => {
    const collectWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
      cfg: {
        channels?: {
          defaults?: { groupPolicy?: "open" | "allowlist" | "disabled" };
          example?: Record<string, unknown>;
        };
      };
      channelLabel: string;
      configuredGroupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      collect: ({ channelLabel, groupPolicy }) =>
        groupPolicy === "open" ? [`warn:${channelLabel}`] : [],
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: ({ configuredGroupPolicy }) => configuredGroupPolicy,
    });

    expect(
      collectWarnings({
        cfg: { channels: { example: {} } },
        channelLabel: "example",
        configuredGroupPolicy: "open",
      }),
    ).toEqual(["warn:example"]);
  });

  it("builds account-aware route-allowlist collectors", () => {
    const collectWarnings = createAllowlistProviderRouteAllowlistWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
      groups?: Record<string, unknown>;
    }>({
      noRouteAllowlist: {
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        surface: "Example groups",
      },
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.groups ?? {}).length > 0,
      restrictSenders: {
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any member in allowed groups",
        surface: "Example groups",
      },
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open", groups: {} },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyNoRouteAllowlistWarning({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        surface: "Example groups",
      }),
    ]);
  });

  it("builds account-aware configured-route collectors", () => {
    const collectWarnings = createOpenProviderConfiguredRouteWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
      channels?: Record<string, unknown>;
    }>({
      configureRouteAllowlist: {
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any channel not explicitly denied",
        routeAllowlistPath: "channels.example.channels",
        surface: "Example channels",
      },
      missingRouteAllowlist: {
        openBehavior: "with no route allowlist; any channel can trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
        surface: "Example channels",
      },
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.channels ?? {}).length > 0,
    });

    expect(
      collectWarnings({
        account: { channels: { general: true }, groupPolicy: "open" },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyConfigureRouteAllowlistWarning({
        groupPolicyPath: "channels.example.groupPolicy",
        openScope: "any channel not explicitly denied",
        routeAllowlistPath: "channels.example.channels",
        surface: "Example channels",
      }),
    ]);
  });

  it("builds config-aware open-provider collectors", () => {
    const collectWarnings = createOpenProviderGroupPolicyWarningCollector<{
      cfg: { channels?: { example?: Record<string, unknown> } };
      configuredGroupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      collect: ({ groupPolicy }) => [groupPolicy],
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: ({ configuredGroupPolicy }) => configuredGroupPolicy,
    });

    expect(
      collectWarnings({
        cfg: { channels: { example: {} } },
        configuredGroupPolicy: "open",
      }),
    ).toEqual(["open"]);
  });

  it("builds account-aware simple open warning collectors", () => {
    const collectWarnings = createAllowlistProviderOpenWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      buildOpenWarning: {
        openBehavior: "allows any channel to trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
        surface: "Example channels",
      },
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open" },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyWarning({
        openBehavior: "allows any channel to trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
        surface: "Example channels",
      }),
    ]);
  });

  it("builds direct account-aware open-policy restrict-senders collectors", () => {
    const collectWarnings = createOpenGroupPolicyRestrictSendersWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      defaultGroupPolicy: "allowlist",
      groupAllowFromPath: "channels.example.groupAllowFrom",
      groupPolicyPath: "channels.example.groupPolicy",
      mentionGated: false,
      openScope: "any member",
      resolveGroupPolicy: (account) => account.groupPolicy,
      surface: "Example groups",
    });

    expect(collectWarnings({ groupPolicy: "allowlist" })).toEqual([]);
    expect(collectWarnings({ groupPolicy: "open" })).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        groupAllowFromPath: "channels.example.groupAllowFrom",
        groupPolicyPath: "channels.example.groupPolicy",
        mentionGated: false,
        openScope: "any member",
        surface: "Example groups",
      }),
    ]);
  });
});
