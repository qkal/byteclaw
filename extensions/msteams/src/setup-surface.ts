import {
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelGroupPolicySetter,
  mergeAllowFromEntries,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import type { MSTeamsTeamConfig } from "../runtime-api.js";
import { formatUnknownError } from "./errors.js";
import {
  parseMSTeamsTeamEntry,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./setup-core.js";
import { resolveMSTeamsCredentials } from "./token.js";

const channel = "msteams" as const;
const setMSTeamsAllowFrom = createTopLevelChannelAllowFromSetter({
  channel,
});
const setMSTeamsGroupPolicy = createTopLevelChannelGroupPolicySetter({
  channel,
  enabled: true,
});

function looksLikeGuid(value: string): boolean {
  return /^[0-9a-fA-F-]{16,}$/.test(value);
}

async function promptMSTeamsAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const existing = params.cfg.channels?.msteams?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist MS Teams DMs by display name, UPN/email, or user id.",
      "We resolve names to user IDs via Microsoft Graph when credentials allow.",
      "Examples:",
      "- alex@example.com",
      "- Alex Johnson",
      "- 00000000-0000-0000-0000-000000000000",
    ].join("\n"),
    "MS Teams allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      initialValue: existing[0] ? String(existing[0]) : undefined,
      message: "MS Teams allowFrom (usernames or ids)",
      placeholder: "alex@example.com, Alex Johnson",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = splitSetupEntries(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "MS Teams allowlist");
      continue;
    }

    const resolved = await resolveMSTeamsUserAllowlist({
      cfg: params.cfg,
      entries: parts,
    }).catch(() => null);

    if (!resolved) {
      const ids = parts.filter((part) => looksLikeGuid(part));
      if (ids.length !== parts.length) {
        await params.prompter.note(
          "Graph lookup unavailable. Use user IDs only.",
          "MS Teams allowlist",
        );
        continue;
      }
      const unique = mergeAllowFromEntries(existing, ids);
      return setMSTeamsAllowFrom(params.cfg, unique);
    }

    const unresolved = resolved.filter((item) => !item.resolved || !item.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((item) => item.input).join(", ")}`,
        "MS Teams allowlist",
      );
      continue;
    }

    const ids = resolved.map((item) => item.id as string);
    const unique = mergeAllowFromEntries(existing, ids);
    return setMSTeamsAllowFrom(params.cfg, unique);
  }
}

function setMSTeamsTeamsAllowlist(
  cfg: OpenClawConfig,
  entries: { teamKey: string; channelKey?: string }[],
): OpenClawConfig {
  const baseTeams = cfg.channels?.msteams?.teams ?? {};
  const teams: Record<string, { channels?: Record<string, unknown> }> = { ...baseTeams };
  for (const entry of entries) {
    const { teamKey } = entry;
    if (!teamKey) {
      continue;
    }
    const existing = teams[teamKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = channels[entry.channelKey] ?? {};
      teams[teamKey] = { ...existing, channels };
    } else {
      teams[teamKey] = existing;
    }
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
        teams: teams as Record<string, MSTeamsTeamConfig>,
      },
    },
  };
}

function listMSTeamsGroupEntries(cfg: OpenClawConfig): string[] {
  return Object.entries(cfg.channels?.msteams?.teams ?? {}).flatMap(([teamKey, value]) => {
    const channels = value?.channels ?? {};
    const channelKeys = Object.keys(channels);
    if (channelKeys.length === 0) {
      return [teamKey];
    }
    return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
  });
}

async function resolveMSTeamsGroupAllowlist(params: {
  cfg: OpenClawConfig;
  entries: string[];
  prompter: Pick<WizardPrompter, "note">;
}): Promise<{ teamKey: string; channelKey?: string }[]> {
  let resolvedEntries = params.entries
    .map((entry) => parseMSTeamsTeamEntry(entry))
    .filter(Boolean) as { teamKey: string; channelKey?: string }[];
  if (params.entries.length === 0 || !resolveMSTeamsCredentials(params.cfg.channels?.msteams)) {
    return resolvedEntries;
  }
  try {
    const lookups = await resolveMSTeamsChannelAllowlist({
      cfg: params.cfg,
      entries: params.entries,
    });
    const resolvedChannels = lookups.filter(
      (entry) => entry.resolved && entry.teamId && entry.channelId,
    );
    const resolvedTeams = lookups.filter(
      (entry) => entry.resolved && entry.teamId && !entry.channelId,
    );
    const unresolved = lookups.filter((entry) => !entry.resolved).map((entry) => entry.input);
    resolvedEntries = [
      ...resolvedChannels.map((entry) => ({
        channelKey: entry.channelId as string,
        teamKey: entry.teamId as string,
      })),
      ...resolvedTeams.map((entry) => ({
        teamKey: entry.teamId as string,
      })),
      ...unresolved.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean),
    ] as { teamKey: string; channelKey?: string }[];
    const summary: string[] = [];
    if (resolvedChannels.length > 0) {
      summary.push(
        `Resolved channels: ${resolvedChannels
          .map((entry) => entry.channelId)
          .filter(Boolean)
          .join(", ")}`,
      );
    }
    if (resolvedTeams.length > 0) {
      summary.push(
        `Resolved teams: ${resolvedTeams
          .map((entry) => entry.teamId)
          .filter(Boolean)
          .join(", ")}`,
      );
    }
    if (unresolved.length > 0) {
      summary.push(`Unresolved (kept as typed): ${unresolved.join(", ")}`);
    }
    if (summary.length > 0) {
      await params.prompter.note(summary.join("\n"), "MS Teams channels");
    }
    return resolvedEntries;
  } catch (error) {
    await params.prompter.note(
      `Channel lookup failed; keeping entries as typed. ${formatUnknownError(error)}`,
      "MS Teams channels",
    );
    return resolvedEntries;
  }
}

const msteamsGroupAccess: NonNullable<ChannelSetupWizard["groupAccess"]> = {
  applyAllowlist: ({ cfg, resolved }) =>
    setMSTeamsTeamsAllowlist(cfg, resolved as { teamKey: string; channelKey?: string }[]),
  currentEntries: ({ cfg }) => listMSTeamsGroupEntries(cfg),
  currentPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy ?? "allowlist",
  label: "MS Teams channels",
  placeholder: "Team Name/Channel Name, teamId/conversationId",
  resolveAllowlist: async ({ cfg, entries, prompter }) =>
    await resolveMSTeamsGroupAllowlist({ cfg, entries, prompter }),
  setPolicy: ({ cfg, policy }) => setMSTeamsGroupPolicy(cfg, policy),
  updatePrompt: ({ cfg }) => Boolean(cfg.channels?.msteams?.teams),
};

const msteamsDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  allowFromKey: "channels.msteams.allowFrom",
  channel,
  getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
  label: "MS Teams",
  policyKey: "channels.msteams.dmPolicy",
  promptAllowFrom: promptMSTeamsAllowFrom,
});

export { msteamsSetupAdapter } from "./setup-core.js";

const msteamsSetupWizardBase = createMSTeamsSetupWizardBase();

export const msteamsSetupWizard: ChannelSetupWizard = {
  ...msteamsSetupWizardBase,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: { ...cfg.channels?.msteams, enabled: false },
    },
  }),
  dmPolicy: msteamsDmPolicy,
  groupAccess: msteamsGroupAccess,
};
