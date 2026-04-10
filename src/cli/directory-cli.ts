import type { Command } from "commander";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { loadConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { danger } from "../globals.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";

function parseLimit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return null;
    }
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function buildRows(entries: { id: string; name?: string | undefined }[]) {
  return entries.map((entry) => ({
    ID: entry.id,
    Name: normalizeOptionalString(entry.name) ?? "",
  }));
}

function printDirectoryList(params: {
  title: string;
  emptyMessage: string;
  entries: { id: string; name?: string | undefined }[];
}): void {
  if (params.entries.length === 0) {
    defaultRuntime.log(theme.muted(params.emptyMessage));
    return;
  }

  const tableWidth = getTerminalTableWidth();
  defaultRuntime.log(`${theme.heading(params.title)} ${theme.muted(`(${params.entries.length})`)}`);
  defaultRuntime.log(
    renderTable({
      columns: [
        { flex: true, header: "ID", key: "ID", minWidth: 16 },
        { flex: true, header: "Name", key: "Name", minWidth: 18 },
      ],
      rows: buildRows(params.entries),
      width: tableWidth,
    }).trimEnd(),
  );
}

export function registerDirectoryCli(program: Command) {
  const directory = program
    .command("directory")
    .description("Lookup contact and group IDs (self, peers, groups) for supported chat channels")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw directory self --channel slack", "Show the connected account identity."],
          [
            'openclaw directory peers list --channel slack --query "alice"',
            "Search contact/user IDs by name.",
          ],
          ["openclaw directory groups list --channel discord", "List available groups/channels."],
          [
            "openclaw directory groups members --channel discord --group-id <id>",
            "List members for a specific group.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/directory",
          "docs.openclaw.ai/cli/directory",
        )}\n`,
    )
    .action(() => {
      directory.help({ error: true });
    });

  const withChannel = (cmd: Command) =>
    cmd
      .option("--channel <name>", "Channel (auto when only one is configured)")
      .option("--account <id>", "Account id (accountId)")
      .option("--json", "Output JSON", false);

  const resolve = async (opts: { channel?: string; account?: string }) => {
    const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
    const autoEnabled = applyPluginAutoEnable({
      config: loadConfig(),
      env: process.env,
    });
    let cfg = autoEnabled.config;
    const explicitChannel = opts.channel?.trim();
    const resolvedExplicit = explicitChannel
      ? await resolveInstallableChannelPlugin({
          allowInstall: true,
          cfg,
          rawChannel: explicitChannel,
          runtime: defaultRuntime,
          supports: (plugin) => Boolean(plugin.directory),
        })
      : null;
    if (resolvedExplicit?.configChanged) {
      ({ cfg } = resolvedExplicit);
      await replaceConfigFile({
        baseHash: (await sourceSnapshotPromise)?.hash,
        nextConfig: cfg,
      });
    } else if (autoEnabled.changes.length > 0) {
      await replaceConfigFile({
        baseHash: (await sourceSnapshotPromise)?.hash,
        nextConfig: cfg,
      });
    }
    const selection = explicitChannel
      ? {
          channel: resolvedExplicit?.channelId,
        }
      : await resolveMessageChannelSelection({
          cfg,
          channel: opts.channel ?? null,
        });
    const channelId = selection.channel;
    const plugin =
      resolvedExplicit?.plugin ?? (channelId ? getChannelPlugin(channelId) : undefined);
    if (!plugin) {
      throw new Error(`Unsupported channel: ${String(channelId)}`);
    }
    const accountId =
      normalizeOptionalString(opts.account) || resolveChannelDefaultAccountId({ cfg, plugin });
    return { accountId, cfg, channelId, plugin };
  };

  const runDirectoryList = async (params: {
    opts: {
      channel?: unknown;
      account?: unknown;
      query?: unknown;
      limit?: unknown;
      json?: unknown;
    };
    action: "listPeers" | "listGroups";
    unsupported: string;
    title: string;
    emptyMessage: string;
  }) => {
    const { cfg, channelId, accountId, plugin } = await resolve({
      account: params.opts.account as string | undefined,
      channel: params.opts.channel as string | undefined,
    });
    const fn =
      params.action === "listPeers" ? plugin.directory?.listPeers : plugin.directory?.listGroups;
    if (!fn) {
      throw new Error(`Channel ${channelId} does not support directory ${params.unsupported}`);
    }
    const result = await fn({
      accountId,
      cfg,
      limit: parseLimit(params.opts.limit),
      query: (params.opts.query as string | undefined) ?? null,
      runtime: defaultRuntime,
    });
    if (params.opts.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    printDirectoryList({ emptyMessage: params.emptyMessage, entries: result, title: params.title });
  };

  withChannel(directory.command("self").description("Show the current account user")).action(
    async (opts) => {
      try {
        const { cfg, channelId, accountId, plugin } = await resolve({
          account: opts.account as string | undefined,
          channel: opts.channel as string | undefined,
        });
        const fn = plugin.directory?.self;
        if (!fn) {
          throw new Error(`Channel ${channelId} does not support directory self`);
        }
        const result = await fn({ accountId, cfg, runtime: defaultRuntime });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        if (!result) {
          defaultRuntime.log(theme.muted("Not available."));
          return;
        }
        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(theme.heading("Self"));
        defaultRuntime.log(
          renderTable({
            columns: [
              { flex: true, header: "ID", key: "ID", minWidth: 16 },
              { flex: true, header: "Name", key: "Name", minWidth: 18 },
            ],
            rows: buildRows([result]),
            width: tableWidth,
          }).trimEnd(),
        );
      } catch (error) {
        defaultRuntime.error(danger(String(error)));
        defaultRuntime.exit(1);
      }
    },
  );

  const peers = directory.command("peers").description("Peer directory (contacts/users)");
  withChannel(peers.command("list").description("List peers"))
    .option("--query <text>", "Optional search query")
    .option("--limit <n>", "Limit results")
    .action(async (opts) => {
      try {
        await runDirectoryList({
          action: "listPeers",
          emptyMessage: "No peers found.",
          opts,
          title: "Peers",
          unsupported: "peers",
        });
      } catch (error) {
        defaultRuntime.error(danger(String(error)));
        defaultRuntime.exit(1);
      }
    });

  const groups = directory.command("groups").description("Group directory");
  withChannel(groups.command("list").description("List groups"))
    .option("--query <text>", "Optional search query")
    .option("--limit <n>", "Limit results")
    .action(async (opts) => {
      try {
        await runDirectoryList({
          action: "listGroups",
          emptyMessage: "No groups found.",
          opts,
          title: "Groups",
          unsupported: "groups",
        });
      } catch (error) {
        defaultRuntime.error(danger(String(error)));
        defaultRuntime.exit(1);
      }
    });

  withChannel(
    groups
      .command("members")
      .description("List group members")
      .requiredOption("--group-id <id>", "Group id"),
  )
    .option("--limit <n>", "Limit results")
    .action(async (opts) => {
      try {
        const { cfg, channelId, accountId, plugin } = await resolve({
          account: opts.account as string | undefined,
          channel: opts.channel as string | undefined,
        });
        const fn = plugin.directory?.listGroupMembers;
        if (!fn) {
          throw new Error(`Channel ${channelId} does not support group members listing`);
        }
        const groupId = normalizeStringifiedOptionalString(opts.groupId) ?? "";
        if (!groupId) {
          throw new Error("Missing --group-id");
        }
        const result = await fn({
          accountId,
          cfg,
          groupId,
          limit: parseLimit(opts.limit),
          runtime: defaultRuntime,
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        printDirectoryList({
          emptyMessage: "No group members found.",
          entries: result,
          title: "Group Members",
        });
      } catch (error) {
        defaultRuntime.error(danger(String(error)));
        defaultRuntime.exit(1);
      }
    });
}
