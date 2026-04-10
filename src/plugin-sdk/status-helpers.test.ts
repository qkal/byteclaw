import { describe, expect, it } from "vitest";
import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildComputedAccountStatusSnapshot,
  buildRuntimeAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
  buildWebhookChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createAsyncComputedAccountStatusAdapter,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  createDependentCredentialStatusIssueCollector,
} from "./status-helpers.js";

const defaultRuntimeState = {
  lastError: null,
  lastStartAt: null,
  lastStopAt: null,
  running: false,
};

type ExpectedAccountSnapshot = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  probe?: unknown;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
} & Record<string, unknown>;

const defaultChannelSummary = {
  configured: false,
  ...defaultRuntimeState,
};

const defaultTokenChannelSummary = {
  ...defaultChannelSummary,
  lastProbeAt: null,
  mode: null,
  probe: undefined,
  tokenSource: "none",
};

const defaultAccountSnapshot: ExpectedAccountSnapshot = {
  accountId: "default",
  name: undefined,
  enabled: undefined,
  configured: false,
  ...defaultRuntimeState,
  probe: undefined,
  lastInboundAt: null,
  lastOutboundAt: null,
};

function expectedAccountSnapshot(
  overrides: Partial<ExpectedAccountSnapshot> = {},
): ExpectedAccountSnapshot {
  return {
    ...defaultAccountSnapshot,
    ...overrides,
  };
}

const adapterAccount = {
  accountId: "default",
  enabled: true,
  profileUrl: "https://example.test",
};

const adapterRuntime = {
  accountId: "default",
  running: true,
};

const adapterProbe = { ok: true };

function expectedAdapterAccountSnapshot() {
  return {
    ...expectedAccountSnapshot({
      configured: true,
      enabled: true,
      probe: adapterProbe,
      running: true,
    }),
    connected: true,
    profileUrl: adapterAccount.profileUrl,
  };
}

function createComputedStatusAdapter() {
  return createComputedAccountStatusAdapter<
    { accountId: string; enabled: boolean; profileUrl: string },
    { ok: boolean }
  >({
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      configured: true,
      enabled: account.enabled,
      extra: {
        connected: runtime?.running ?? false,
        probe,
        profileUrl: account.profileUrl,
      },
    }),
  });
}

function createAsyncStatusAdapter() {
  return createAsyncComputedAccountStatusAdapter<
    { accountId: string; enabled: boolean; profileUrl: string },
    { ok: boolean }
  >({
    defaultRuntime: createDefaultChannelRuntimeState("default"),
    resolveAccountSnapshot: async ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      configured: true,
      enabled: account.enabled,
      extra: {
        connected: runtime?.running ?? false,
        probe,
        profileUrl: account.profileUrl,
      },
    }),
  });
}

describe("createDefaultChannelRuntimeState", () => {
  it.each([
    {
      accountId: "default",
      expected: {
        accountId: "default",
        ...defaultRuntimeState,
      },
      extra: undefined,
      name: "builds default runtime state without extra fields",
    },
    {
      accountId: "alerts",
      expected: {
        accountId: "alerts",
        ...defaultRuntimeState,
        probeAt: 123,
        healthy: true,
      },
      extra: {
        healthy: true,
        probeAt: 123,
      },
      name: "merges extra fields into the default runtime state",
    },
  ])("$name", ({ accountId, extra, expected }) => {
    expect(createDefaultChannelRuntimeState(accountId, extra)).toEqual(expected);
  });
});

describe("buildBaseChannelStatusSummary", () => {
  it.each([
    {
      expected: defaultChannelSummary,
      input: {},
      name: "defaults missing values",
    },
    {
      expected: {
        ...defaultChannelSummary,
        configured: true,
        lastError: "boom",
        lastStartAt: 1,
        lastStopAt: 2,
        running: true,
      },
      input: {
        configured: true,
        lastError: "boom",
        lastStartAt: 1,
        lastStopAt: 2,
        running: true,
      },
      name: "keeps explicit values",
    },
  ])("$name", ({ input, expected }) => {
    expect(buildBaseChannelStatusSummary(input)).toEqual(expected);
  });

  it("merges extra fields into the normalized channel summary", () => {
    expect(
      buildBaseChannelStatusSummary(
        {
          configured: true,
        },
        {
          mode: "webhook",
          secretSource: "env",
        },
      ),
    ).toEqual({
      ...defaultChannelSummary,
      configured: true,
      mode: "webhook",
      secretSource: "env",
    });
  });
});

describe("buildBaseAccountStatusSnapshot", () => {
  it.each([
    {
      expected: expectedAccountSnapshot({ configured: true, enabled: true }),
      extra: undefined,
      input: {
        account: { accountId: "default", configured: true, enabled: true },
      },
      name: "builds account status with runtime defaults",
    },
    {
      expected: {
        ...expectedAccountSnapshot({ configured: true }),
        connected: true,
        mode: "polling",
      },
      extra: {
        connected: true,
        mode: "polling",
      },
      input: {
        account: { accountId: "default", configured: true },
      },
      name: "merges extra snapshot fields after the shared account shape",
    },
  ])("$name", ({ input, extra, expected }) => {
    expect(buildBaseAccountStatusSnapshot(input, extra)).toEqual(expected);
  });
});

describe("buildComputedAccountStatusSnapshot", () => {
  it("builds account status when configured is computed outside resolver", () => {
    expect(
      buildComputedAccountStatusSnapshot({
        accountId: "default",
        configured: false,
        enabled: true,
      }),
    ).toEqual(expectedAccountSnapshot({ enabled: true }));
  });

  it("merges computed extras after the shared fields", () => {
    expect(
      buildComputedAccountStatusSnapshot(
        {
          accountId: "default",
          configured: true,
        },
        {
          connected: true,
        },
      ),
    ).toEqual({
      ...expectedAccountSnapshot({ configured: true }),
      connected: true,
    });
  });
});

describe("computed account status adapters", () => {
  it.each([
    {
      createStatus: createComputedStatusAdapter,
      name: "sync",
    },
    {
      createStatus: createAsyncStatusAdapter,
      name: "async",
    },
  ])(
    "builds account snapshots from $name computed account metadata and extras",
    async ({ createStatus }) => {
      const status = createStatus();
      await expect(
        Promise.resolve(
          status.buildAccountSnapshot?.({
            account: adapterAccount,
            cfg: {} as never,
            probe: adapterProbe,
            runtime: adapterRuntime,
          }),
        ),
      ).resolves.toEqual(expectedAdapterAccountSnapshot());
    },
  );
});

describe("buildRuntimeAccountStatusSnapshot", () => {
  it.each([
    {
      expected: {
        ...defaultRuntimeState,
        probe: undefined,
      },
      extra: undefined,
      input: {},
      name: "builds runtime lifecycle fields with defaults",
    },
    {
      expected: {
        ...defaultRuntimeState,
        port: 3978,
        probe: undefined,
      },
      extra: { port: 3978 },
      input: {},
      name: "merges extra fields into runtime snapshots",
    },
  ])("$name", ({ input, extra, expected }) => {
    expect(buildRuntimeAccountStatusSnapshot(input, extra)).toEqual(expected);
  });
});

describe("buildTokenChannelStatusSummary", () => {
  it.each([
    {
      expected: defaultTokenChannelSummary,
      input: {},
      name: "includes token/probe fields with mode by default",
      options: undefined,
    },
    {
      expected: {
        configured: true,
        lastError: "boom",
        lastProbeAt: 3,
        lastStartAt: 1,
        lastStopAt: 2,
        probe: { ok: true },
        running: true,
        tokenSource: "env",
      },
      input: {
        configured: true,
        lastError: "boom",
        lastProbeAt: 3,
        lastStartAt: 1,
        lastStopAt: 2,
        probe: { ok: true },
        running: true,
        tokenSource: "env",
      },
      name: "can omit mode for channels without a mode state",
      options: { includeMode: false },
    },
  ])("$name", ({ input, options, expected }) => {
    expect(buildTokenChannelStatusSummary(input, options)).toEqual(expected);
  });
});

describe("buildWebhookChannelStatusSummary", () => {
  it("defaults mode to webhook and keeps supplied extras", () => {
    expect(
      buildWebhookChannelStatusSummary(
        {
          configured: true,
          running: true,
        },
        {
          secretSource: "env",
        },
      ),
    ).toEqual({
      configured: true,
      lastError: null,
      lastStartAt: null,
      lastStopAt: null,
      mode: "webhook",
      running: true,
      secretSource: "env",
    });
  });
});

describe("createDependentCredentialStatusIssueCollector", () => {
  it("uses source metadata from sanitized snapshots to pick the missing field", () => {
    const collect = createDependentCredentialStatusIssueCollector({
      channel: "line",
      dependencySourceKey: "tokenSource",
      missingDependentMessage: "LINE channel secret not configured",
      missingPrimaryMessage: "LINE channel access token not configured",
    });

    expect(
      collect([
        { accountId: "default", configured: false, tokenSource: "none" },
        { accountId: "work", configured: false, tokenSource: "env" },
        { accountId: "ok", configured: true, tokenSource: "env" },
      ]),
    ).toEqual([
      {
        accountId: "default",
        channel: "line",
        kind: "config",
        message: "LINE channel access token not configured",
      },
      {
        accountId: "work",
        channel: "line",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });
});

describe("collectStatusIssuesFromLastError", () => {
  it("returns runtime issues only for non-empty string lastError values", () => {
    expect(
      collectStatusIssuesFromLastError("demo-channel", [
        { accountId: "default", lastError: " timeout " },
        { accountId: "silent", lastError: "   " },
        { accountId: "typed", lastError: { message: "boom" } },
      ]),
    ).toEqual([
      {
        accountId: "default",
        channel: "demo-channel",
        kind: "runtime",
        message: "Channel error: timeout",
      },
    ]);
  });
});
