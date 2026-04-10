import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackSlashMocks, resetSlackSlashMocks } from "./slash.test-harness.js";

vi.mock("./slash-commands.runtime.js", () => {
  const usageCommand = { key: "usage", nativeName: "usage" };
  const reportCommand = { key: "report", nativeName: "report" };
  const reportCompactCommand = { key: "reportcompact", nativeName: "reportcompact" };
  const reportExternalCommand = { key: "reportexternal", nativeName: "reportexternal" };
  const reportLongCommand = { key: "reportlong", nativeName: "reportlong" };
  const unsafeConfirmCommand = { key: "unsafeconfirm", nativeName: "unsafeconfirm" };
  const statusAliasCommand = { key: "status", nativeName: "status" };
  const periodArg = { description: "period", name: "period" };
  const baseReportPeriodChoices = [
    { label: "day", value: "day" },
    { label: "week", value: "week" },
    { label: "month", value: "month" },
    { label: "quarter", value: "quarter" },
  ];
  const fullReportPeriodChoices = [...baseReportPeriodChoices, { label: "year", value: "year" }];
  const hasNonEmptyArgValue = (values: unknown, key: string) => {
    const raw =
      typeof values === "object" && values !== null
        ? (values as Record<string, unknown>)[key]
        : undefined;
    return typeof raw === "string" && raw.trim().length > 0;
  };
  const resolvePeriodMenu = (
    params: { args?: { values?: unknown } },
    choices: {
      value: string;
      label: string;
    }[],
  ) => {
    if (hasNonEmptyArgValue(params.args?.values, "period")) {
      return null;
    }
    return { arg: periodArg, choices };
  };

  return {
    buildCommandTextFromArgs: (
      cmd: { nativeName?: string; key: string },
      args?: { values?: Record<string, unknown> },
    ) => {
      const name = cmd.nativeName ?? cmd.key;
      const values = args?.values ?? {};
      const { mode } = values;
      const { period } = values;
      const selected =
        typeof mode === "string" && mode.trim()
          ? mode.trim()
          : typeof period === "string" && period.trim()
            ? period.trim()
            : "";
      return selected ? `/${name} ${selected}` : `/${name}`;
    },
    findCommandByNativeName: (name: string) => {
      const normalized = name.trim().toLowerCase();
      if (normalized === "usage") {
        return usageCommand;
      }
      if (normalized === "report") {
        return reportCommand;
      }
      if (normalized === "reportcompact") {
        return reportCompactCommand;
      }
      if (normalized === "reportexternal") {
        return reportExternalCommand;
      }
      if (normalized === "reportlong") {
        return reportLongCommand;
      }
      if (normalized === "unsafeconfirm") {
        return unsafeConfirmCommand;
      }
      if (normalized === "agentstatus") {
        return statusAliasCommand;
      }
      return undefined;
    },
    listNativeCommandSpecsForConfig: () => [
      {
        acceptsArgs: true,
        args: [],
        description: "Usage",
        name: "usage",
      },
      {
        acceptsArgs: true,
        args: [],
        description: "Report",
        name: "report",
      },
      {
        acceptsArgs: true,
        args: [],
        description: "ReportCompact",
        name: "reportcompact",
      },
      {
        acceptsArgs: true,
        args: [],
        description: "ReportExternal",
        name: "reportexternal",
      },
      {
        acceptsArgs: true,
        args: [],
        description: "ReportLong",
        name: "reportlong",
      },
      {
        acceptsArgs: true,
        args: [],
        description: "UnsafeConfirm",
        name: "unsafeconfirm",
      },
      {
        acceptsArgs: false,
        args: [],
        description: "Status",
        name: "agentstatus",
      },
    ],
    parseCommandArgs: () => ({ values: {} }),
    resolveCommandArgMenu: (params: {
      command?: { key?: string };
      args?: { values?: unknown };
    }) => {
      if (params.command?.key === "report") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { label: "all", value: "all" },
        ]);
      }
      if (params.command?.key === "reportlong") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { label: "long", value: "x".repeat(90) },
        ]);
      }
      if (params.command?.key === "reportcompact") {
        return resolvePeriodMenu(params, baseReportPeriodChoices);
      }
      if (params.command?.key === "reportexternal") {
        return {
          arg: { description: "period", name: "period" },
          choices: Array.from({ length: 140 }, (_v, i) => ({
            label: `Period ${i + 1}`,
            value: `period-${i + 1}`,
          })),
        };
      }
      if (params.command?.key === "unsafeconfirm") {
        return {
          arg: { description: "mode", name: "mode_*`~<&>" },
          choices: [
            { label: "on", value: "on" },
            { label: "off", value: "off" },
          ],
        };
      }
      if (params.command?.key !== "usage") {
        return null;
      }
      const values = (params.args?.values ?? {}) as Record<string, unknown>;
      if (typeof values.mode === "string" && values.mode.trim()) {
        return null;
      }
      return {
        arg: { description: "mode", name: "mode" },
        choices: [
          { label: "tokens", value: "tokens" },
          { label: "cost", value: "cost" },
        ],
      };
    },
  };
});

type RegisterFn = (params: { ctx: unknown; account: unknown }) => Promise<void>;
const { registerSlackMonitorSlashCommands } = (await import("./slash.js")) as {
  registerSlackMonitorSlashCommands: RegisterFn;
};

const { dispatchMock } = getSlackSlashMocks();

beforeEach(() => {
  resetSlackSlashMocks();
});

async function registerCommands(ctx: unknown, account: unknown) {
  await registerSlackMonitorSlashCommands({ account: account as never, ctx: ctx as never });
}

function encodeValue(parts: { command: string; arg: string; value: string; userId: string }) {
  return [
    "cmdarg",
    encodeURIComponent(parts.command),
    encodeURIComponent(parts.arg),
    encodeURIComponent(parts.value),
    encodeURIComponent(parts.userId),
  ].join("|");
}

function findFirstActionsBlock(payload: { blocks?: { type: string }[] }) {
  return payload.blocks?.find((block) => block.type === "actions") as
    | { type: string; elements?: { type?: string; action_id?: string; confirm?: unknown }[] }
    | undefined;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createArgMenusHarness() {
  const commands = new Map<string, (args: unknown) => Promise<void>>();
  const actions = new Map<string, (args: unknown) => Promise<void>>();
  const options = new Map<string, (args: unknown) => Promise<void>>();
  const optionsReceiverContexts: unknown[] = [];

  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    action: (id: string, handler: (args: unknown) => Promise<void>) => {
      actions.set(id, handler);
    },
    client: { chat: { postEphemeral } },
    command: (name: string, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
    options(this: unknown, id: string, handler: (args: unknown) => Promise<void>) {
      optionsReceiverContexts.push(this);
      options.set(id, handler);
    },
  };

  const ctx = {
    allowFrom: ["*"],
    app,
    botToken: "bot-token",
    botUserId: "bot",
    cfg: { commands: { native: true, nativeSkills: false } },
    channelsConfig: undefined,
    defaultRequireMention: true,
    dmEnabled: true,
    dmPolicy: "open",
    groupDmChannels: [],
    groupDmEnabled: false,
    groupPolicy: "open",
    isChannelAllowed: () => true,
    resolveChannelName: async () => ({ name: "dm", type: "im" }),
    resolveUserName: async () => ({ name: "Ada" }),
    runtime: {},
    slashCommand: {
      enabled: true,
      ephemeral: true,
      name: "openclaw",
      sessionPrefix: "slack:slash",
    },
    teamId: "T1",
    textLimit: 4000,
    useAccessGroups: false,
  } as unknown;

  const account = {
    accountId: "acct",
    config: { commands: { native: true, nativeSkills: false } },
  } as unknown;

  return {
    account,
    actions,
    app,
    commands,
    ctx,
    options,
    optionsReceiverContexts,
    postEphemeral,
  };
}

function requireHandler(
  handlers: Map<string, (args: unknown) => Promise<void>>,
  key: string,
  label: string,
): (args: unknown) => Promise<void> {
  const handler = handlers.get(key);
  if (!handler) {
    throw new Error(`Missing ${label} handler`);
  }
  return handler;
}

function createSlashCommand(overrides: Partial<Record<string, string>> = {}) {
  return {
    channel_id: "C1",
    channel_name: "directmessage",
    text: "",
    trigger_id: "t1",
    user_id: "U1",
    user_name: "Ada",
    ...overrides,
  };
}

async function runCommandHandler(handler: (args: unknown) => Promise<void>) {
  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);
  await handler({
    ack,
    command: createSlashCommand(),
    respond,
  });
  return { ack, respond };
}

function expectArgMenuLayout(respond: ReturnType<typeof vi.fn>): {
  type: string;
  elements?: { type?: string; action_id?: string; confirm?: unknown }[];
} {
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = respond.mock.calls[0]?.[0] as { blocks?: { type: string }[] };
  expect(payload.blocks?.[0]?.type).toBe("header");
  expect(payload.blocks?.[1]?.type).toBe("section");
  expect(payload.blocks?.[2]?.type).toBe("context");
  return findFirstActionsBlock(payload) ?? { elements: [], type: "actions" };
}

function expectSingleDispatchedSlashBody(expectedBody: string) {
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
  expect(call.ctx?.Body).toBe(expectedBody);
}

interface ActionsBlockPayload {
  blocks?: { type: string; block_id?: string }[];
}

async function runCommandAndResolveActionsBlock(
  handler: (args: unknown) => Promise<void>,
): Promise<{
  respond: ReturnType<typeof vi.fn>;
  payload: ActionsBlockPayload;
  blockId?: string;
}> {
  const { respond } = await runCommandHandler(handler);
  const payload = respond.mock.calls[0]?.[0] as ActionsBlockPayload;
  const blockId = payload.blocks?.find((block) => block.type === "actions")?.block_id;
  return { blockId, payload, respond };
}

async function getFirstActionElementFromCommand(handler: (args: unknown) => Promise<void>) {
  const { respond } = await runCommandHandler(handler);
  expect(respond).toHaveBeenCalledTimes(1);
  const payload = respond.mock.calls[0]?.[0] as { blocks?: { type: string }[] };
  const actions = findFirstActionsBlock(payload);
  return actions?.elements?.[0];
}

async function runArgMenuAction(
  handler: (args: unknown) => Promise<void>,
  params: {
    action: Record<string, unknown>;
    userId?: string;
    userName?: string;
    channelId?: string;
    channelName?: string;
    respond?: ReturnType<typeof vi.fn>;
    includeRespond?: boolean;
  },
) {
  const includeRespond = params.includeRespond ?? true;
  const respond = params.respond ?? vi.fn().mockResolvedValue(undefined);
  const payload: Record<string, unknown> = {
    ack: vi.fn().mockResolvedValue(undefined),
    action: params.action,
    body: {
      channel: { id: params.channelId ?? "C1", name: params.channelName ?? "directmessage" },
      trigger_id: "t1",
      user: { id: params.userId ?? "U1", name: params.userName ?? "Ada" },
    },
  };
  if (includeRespond) {
    payload.respond = respond;
  }
  await handler(payload);
  return respond;
}

describe("Slack native command argument menus", () => {
  let harness: ReturnType<typeof createArgMenusHarness>;
  let usageHandler: (args: unknown) => Promise<void>;
  let reportHandler: (args: unknown) => Promise<void>;
  let reportCompactHandler: (args: unknown) => Promise<void>;
  let reportExternalHandler: (args: unknown) => Promise<void>;
  let reportLongHandler: (args: unknown) => Promise<void>;
  let unsafeConfirmHandler: (args: unknown) => Promise<void>;
  let agentStatusHandler: (args: unknown) => Promise<void>;
  let argMenuHandler: (args: unknown) => Promise<void>;
  let argMenuOptionsHandler: (args: unknown) => Promise<void>;

  beforeAll(async () => {
    harness = createArgMenusHarness();
    await registerCommands(harness.ctx, harness.account);
    usageHandler = requireHandler(harness.commands, "/usage", "/usage");
    reportHandler = requireHandler(harness.commands, "/report", "/report");
    reportCompactHandler = requireHandler(harness.commands, "/reportcompact", "/reportcompact");
    reportExternalHandler = requireHandler(harness.commands, "/reportexternal", "/reportexternal");
    reportLongHandler = requireHandler(harness.commands, "/reportlong", "/reportlong");
    unsafeConfirmHandler = requireHandler(harness.commands, "/unsafeconfirm", "/unsafeconfirm");
    agentStatusHandler = requireHandler(harness.commands, "/agentstatus", "/agentstatus");
    argMenuHandler = requireHandler(harness.actions, "openclaw_cmdarg", "arg-menu action");
    argMenuOptionsHandler = requireHandler(harness.options, "openclaw_cmdarg", "arg-menu options");
  });

  beforeEach(() => {
    harness.postEphemeral.mockClear();
  });

  it("registers options handlers without losing app receiver binding", async () => {
    const testHarness = createArgMenusHarness();
    await registerCommands(testHarness.ctx, testHarness.account);
    expect(testHarness.commands.size).toBeGreaterThan(0);
    expect(testHarness.actions.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.options.has("openclaw_cmdarg")).toBe(true);
    expect(testHarness.optionsReceiverContexts[0]).toBe(testHarness.app);
  });

  it("falls back to static menus when app.options() throws during registration", async () => {
    const commands = new Map<string, (args: unknown) => Promise<void>>();
    const actions = new Map<string, (args: unknown) => Promise<void>>();
    const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
    const app = {
      client: { chat: { postEphemeral } },
      command: (name: string, handler: (args: unknown) => Promise<void>) => {
        commands.set(name, handler);
      },
      action: (id: string, handler: (args: unknown) => Promise<void>) => {
        actions.set(id, handler);
      },
      // Simulate Bolt throwing during options registration (e.g. receiver not initialized)
      options: () => {
        throw new Error("Cannot read properties of undefined (reading 'listeners')");
      },
    };
    const ctx = {
      allowFrom: ["*"],
      app,
      botToken: "bot-token",
      botUserId: "bot",
      cfg: { commands: { native: true, nativeSkills: false } },
      channelsConfig: undefined,
      defaultRequireMention: true,
      dmEnabled: true,
      dmPolicy: "open",
      groupDmChannels: [],
      groupDmEnabled: false,
      groupPolicy: "open",
      isChannelAllowed: () => true,
      resolveChannelName: async () => ({ name: "dm", type: "im" }),
      resolveUserName: async () => ({ name: "Ada" }),
      runtime: {},
      slashCommand: {
        enabled: true,
        ephemeral: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
      },
      teamId: "T1",
      textLimit: 4000,
      useAccessGroups: false,
    } as unknown;
    const account = {
      accountId: "acct",
      config: { commands: { native: true, nativeSkills: false } },
    } as unknown;

    // Registration should not throw despite app.options() throwing
    await registerCommands(ctx, account);
    expect(commands.size).toBeGreaterThan(0);
    expect(actions.has("openclaw_cmdarg")).toBe(true);

    // The /reportexternal command (140 choices) should fall back to static_select
    // Instead of external_select since options registration failed
    const handler = commands.get("/reportexternal");
    expect(handler).toBeDefined();
    const respond = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);
    await handler!({
      ack,
      command: createSlashCommand(),
      respond,
    });
    expect(respond).toHaveBeenCalledTimes(1);
    const payload = respond.mock.calls[0]?.[0] as { blocks?: { type: string }[] };
    const actionsBlock = findFirstActionsBlock(payload);
    // Should be static_select (fallback) not external_select
    expect(actionsBlock?.elements?.[0]?.type).toBe("static_select");
  });

  it("shows a button menu when required args are omitted", async () => {
    const { respond } = await runCommandHandler(usageHandler);
    const actions = expectArgMenuLayout(respond);
    const elementType = actions?.elements?.[0]?.type;
    expect(elementType).toBe("button");
    expect(actions?.elements?.[0]?.confirm).toBeTruthy();
  });

  it("shows a static_select menu when choices exceed button row size", async () => {
    const { respond } = await runCommandHandler(reportHandler);
    const actions = expectArgMenuLayout(respond);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("static_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });

  it("falls back to buttons when static_select value limit would be exceeded", async () => {
    const firstElement = await getFirstActionElementFromCommand(reportLongHandler);
    expect(firstElement?.type).toBe("button");
    expect(firstElement?.confirm).toBeTruthy();
  });

  it("shows an overflow menu when choices fit compact range", async () => {
    const element = await getFirstActionElementFromCommand(reportCompactHandler);
    expect(element?.type).toBe("overflow");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(element?.confirm).toBeTruthy();
  });

  it("escapes mrkdwn characters in confirm dialog text", async () => {
    const element = (await getFirstActionElementFromCommand(unsafeConfirmHandler)) as
      | { confirm?: { text?: { text?: string } } }
      | undefined;
    expect(element?.confirm?.text?.text).toContain(
      "Run */unsafeconfirm* with *mode\\_\\*\\`\\~&lt;&amp;&gt;* set to this value?",
    );
  });

  it("dispatches the command when a menu button is clicked", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ arg: "mode", command: "usage", userId: "U1", value: "tokens" }),
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]?.[0] as { ctx?: { Body?: string } };
    expect(call.ctx?.Body).toBe("/usage tokens");
  });

  it("maps /agentstatus to /status when dispatching", async () => {
    await runCommandHandler(agentStatusHandler);
    expectSingleDispatchedSlashBody("/status");
  });

  it("dispatches the command when a static_select option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({ arg: "period", command: "report", userId: "U1", value: "month" }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/report month");
  });

  it("dispatches the command when an overflow option is chosen", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: {
        selected_option: {
          value: encodeValue({
            arg: "period",
            command: "reportcompact",
            userId: "U1",
            value: "quarter",
          }),
        },
      },
    });

    expectSingleDispatchedSlashBody("/reportcompact quarter");
  });

  it("shows an external_select menu when choices exceed static_select options max", async () => {
    const { respond, payload, blockId } =
      await runCommandAndResolveActionsBlock(reportExternalHandler);

    expect(respond).toHaveBeenCalledTimes(1);
    const actions = findFirstActionsBlock(payload);
    const element = actions?.elements?.[0];
    expect(element?.type).toBe("external_select");
    expect(element?.action_id).toBe("openclaw_cmdarg");
    expect(blockId).toContain("openclaw_cmdarg_ext:");
    const token = (blockId ?? "").slice("openclaw_cmdarg_ext:".length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("serves filtered options for external_select menus", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        actions: [{ block_id: blockId }],
        user: { id: "U1" },
        value: "period 12",
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    const optionsPayload = ackOptions.mock.calls[0]?.[0] as {
      options?: { text?: { text?: string }; value?: string }[];
    };
    const optionTexts = (optionsPayload.options ?? []).map((option) => option.text?.text ?? "");
    expect(optionTexts.some((text) => text.includes("Period 12"))).toBe(true);
  });

  it("rejects external_select option requests without user identity", async () => {
    const { blockId } = await runCommandAndResolveActionsBlock(reportExternalHandler);
    expect(blockId).toContain("openclaw_cmdarg_ext:");

    const ackOptions = vi.fn().mockResolvedValue(undefined);
    await argMenuOptionsHandler({
      ack: ackOptions,
      body: {
        actions: [{ block_id: blockId }],
        value: "period 1",
      },
    });

    expect(ackOptions).toHaveBeenCalledTimes(1);
    expect(ackOptions).toHaveBeenCalledWith({ options: [] });
  });

  it("rejects menu clicks from other users", async () => {
    const respond = await runArgMenuAction(argMenuHandler, {
      action: {
        value: encodeValue({ arg: "mode", command: "usage", userId: "U1", value: "tokens" }),
      },
      userId: "U2",
      userName: "Eve",
    });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: "That menu is for another user.",
    });
  });

  it("falls back to postEphemeral with token when respond is unavailable", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "garbage" },
      includeRespond: false,
    });

    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        token: "bot-token",
        user: "U1",
      }),
    );
  });

  it("treats malformed percent-encoding as an invalid button (no throw)", async () => {
    await runArgMenuAction(argMenuHandler, {
      action: { value: "cmdarg|%E0%A4%A|mode|on|U1" },
      includeRespond: false,
    });

    expect(harness.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C1",
        text: "Sorry, that button is no longer valid.",
        token: "bot-token",
        user: "U1",
      }),
    );
  });
});

function createPolicyHarness(overrides?: {
  groupPolicy?: "open" | "allowlist";
  channelsConfig?: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  channelId?: string;
  channelName?: string;
  allowFrom?: string[];
  useAccessGroups?: boolean;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
  resolveChannelName?: () => Promise<{ name?: string; type?: string }>;
}) {
  const commands = new Map<unknown, (args: unknown) => Promise<void>>();
  const postEphemeral = vi.fn().mockResolvedValue({ ok: true });
  const app = {
    client: { chat: { postEphemeral } },
    command: (name: unknown, handler: (args: unknown) => Promise<void>) => {
      commands.set(name, handler);
    },
  };

  const channelId = overrides?.channelId ?? "C_UNLISTED";
  const channelName = overrides?.channelName ?? "unlisted";

  const ctx = {
    allowFrom: overrides?.allowFrom ?? ["*"],
    app,
    botToken: "bot-token",
    botUserId: "bot",
    cfg: { commands: { native: false } },
    channelsConfig: overrides?.channelsConfig,
    defaultRequireMention: true,
    dmEnabled: true,
    dmPolicy: "open",
    groupDmChannels: [],
    groupDmEnabled: false,
    groupPolicy: overrides?.groupPolicy ?? "open",
    isChannelAllowed: () => true,
    resolveChannelName:
      overrides?.resolveChannelName ?? (async () => ({ name: channelName, type: "channel" })),
    resolveUserName: async () => ({ name: "Ada" }),
    runtime: {},
    shouldDropMismatchedSlackEvent: (body: unknown) =>
      overrides?.shouldDropMismatchedSlackEvent?.(body) ?? false,
    slashCommand: {
      enabled: true,
      ephemeral: true,
      name: "openclaw",
      sessionPrefix: "slack:slash",
    },
    teamId: "T1",
    textLimit: 4000,
    useAccessGroups: overrides?.useAccessGroups ?? true,
  } as unknown;

  const account = { accountId: "acct", config: { commands: { native: false } } } as unknown;

  return { account, channelId, channelName, commands, ctx, postEphemeral };
}

async function runSlashHandler(params: {
  commands: Map<unknown, (args: unknown) => Promise<void>>;
  body?: unknown;
  command: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }> &
    Pick<{ channel_id: string; channel_name: string }, "channel_id" | "channel_name">;
}): Promise<{ respond: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> }> {
  const handler = [...params.commands.values()][0];
  if (!handler) {
    throw new Error("Missing slash handler");
  }

  const respond = vi.fn().mockResolvedValue(undefined);
  const ack = vi.fn().mockResolvedValue(undefined);

  await handler({
    ack,
    body: params.body,
    command: {
      text: "hello",
      trigger_id: "t1",
      user_id: "U1",
      user_name: "Ada",
      ...params.command,
    },
    respond,
  });

  return { ack, respond };
}

async function registerAndRunPolicySlash(params: {
  harness: ReturnType<typeof createPolicyHarness>;
  body?: unknown;
  command?: Partial<{
    user_id: string;
    user_name: string;
    channel_id: string;
    channel_name: string;
    text: string;
    trigger_id: string;
  }>;
}) {
  await registerCommands(params.harness.ctx, params.harness.account);
  return await runSlashHandler({
    body: params.body,
    command: {
      channel_id: params.command?.channel_id ?? params.harness.channelId,
      channel_name: params.command?.channel_name ?? params.harness.channelName,
      ...params.command,
    },
    commands: params.harness.commands,
  });
}

function expectChannelBlockedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    response_type: "ephemeral",
    text: "This channel is not allowed.",
  });
}

function expectUnauthorizedResponse(respond: ReturnType<typeof vi.fn>) {
  expect(dispatchMock).not.toHaveBeenCalled();
  expect(respond).toHaveBeenCalledWith({
    response_type: "ephemeral",
    text: "You are not authorized to use this command.",
  });
}

describe("slack slash commands channel policy", () => {
  it("drops mismatched slash payloads before dispatch", async () => {
    const harness = createPolicyHarness({
      shouldDropMismatchedSlackEvent: () => true,
    });
    const { respond, ack } = await registerAndRunPolicySlash({
      body: {
        api_app_id: "A_MISMATCH",
        team_id: "T_MISMATCH",
      },
      harness,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("allows unlisted channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      channelId: "C_UNLISTED",
      channelName: "unlisted",
      channelsConfig: { C_LISTED: { requireMention: true } },
      groupPolicy: "open",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "This channel is not allowed." }),
    );
  });

  it("blocks explicitly denied channels when groupPolicy is open", async () => {
    const harness = createPolicyHarness({
      channelId: "C_DENIED",
      channelName: "denied",
      channelsConfig: { C_DENIED: { enabled: false } },
      groupPolicy: "open",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectChannelBlockedResponse(respond);
  });

  it("blocks unlisted channels when groupPolicy is allowlist", async () => {
    const harness = createPolicyHarness({
      channelId: "C_UNLISTED",
      channelName: "unlisted",
      channelsConfig: { C_LISTED: { requireMention: true } },
      groupPolicy: "allowlist",
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectChannelBlockedResponse(respond);
  });
});

describe("slack slash commands access groups", () => {
  it("fails closed when channel type lookup returns empty for channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "C_UNKNOWN",
      channelName: "unknown",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });

  it("still treats D-prefixed channel ids as DMs when lookup fails", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "D123",
      channelName: "notdirectmessage",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({
      command: {
        channel_id: "D123",
        channel_name: "notdirectmessage",
      },
      harness,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "You are not authorized to use this command." }),
    );
    const dispatchArg = dispatchMock.mock.calls[0]?.[0] as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(false);
  });

  it("computes CommandAuthorized for DM slash commands when dmPolicy is open", async () => {
    const harness = createPolicyHarness({
      allowFrom: ["U_OWNER"],
      channelId: "D999",
      channelName: "directmessage",
      resolveChannelName: async () => ({ name: "directmessage", type: "im" }),
    });
    await registerAndRunPolicySlash({
      command: {
        channel_id: "D999",
        channel_name: "directmessage",
        user_id: "U_ATTACKER",
        user_name: "Mallory",
      },
      harness,
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchMock.mock.calls[0]?.[0] as {
      ctx?: { CommandAuthorized?: boolean };
    };
    expect(dispatchArg?.ctx?.CommandAuthorized).toBe(false);
  });

  it("enforces access-group gating when lookup fails for private channels", async () => {
    const harness = createPolicyHarness({
      allowFrom: [],
      channelId: "G123",
      channelName: "private",
      resolveChannelName: async () => ({}),
    });
    const { respond } = await registerAndRunPolicySlash({ harness });

    expectUnauthorizedResponse(respond);
  });
});

describe("slack slash command session metadata", () => {
  const { recordSessionMetaFromInboundMock } = getSlackSlashMocks();

  it("calls recordSessionMetaFromInbound after dispatching a slash command", async () => {
    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerAndRunPolicySlash({ harness });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    const call = recordSessionMetaFromInboundMock.mock.calls[0]?.[0] as {
      sessionKey?: string;
      ctx?: { OriginatingChannel?: string };
    };
    expect(call.ctx?.OriginatingChannel).toBe("slack");
    expect(call.sessionKey).toBeDefined();
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const recordStarted = createDeferred<void>();
    const deferred = createDeferred<void>();
    recordSessionMetaFromInboundMock.mockClear().mockImplementation(() => {
      recordStarted.resolve();
      return deferred.promise;
    });

    const harness = createPolicyHarness({ groupPolicy: "open" });
    await registerCommands(harness.ctx, harness.account);

    const runPromise = runSlashHandler({
      command: {
        channel_id: harness.channelId,
        channel_name: harness.channelName,
      },
      commands: harness.commands,
    });

    await recordStarted.promise;
    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
