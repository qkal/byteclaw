import { describe, expect, it, vi } from "vitest";
import {
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "../../../test/helpers/plugins/setup-wizard.js";
import {
  createAllowlistSetupWizardProxy,
  createDelegatedFinalize,
  createDelegatedPrepare,
  createDelegatedResolveConfigured,
  createDelegatedSetupWizardProxy,
} from "./setup-wizard-proxy.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

describe("createDelegatedResolveConfigured", () => {
  it("forwards configured resolution to the loaded wizard", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        credentials: [],
        status: {
          configuredLabel: "configured",
          resolveConfigured: async ({ cfg, accountId }) =>
            Boolean(cfg.channels?.[accountId ?? "demo"]),
          unconfiguredLabel: "needs setup",
        },
      }),
    );

    const resolveConfigured = createDelegatedResolveConfigured(loadWizard);

    expect(await resolveConfigured({ cfg: {} })).toBe(false);
    expect(await resolveConfigured({ accountId: "work", cfg: { channels: { work: {} } } })).toBe(
      true,
    );
  });
});

describe("createDelegatedPrepare", () => {
  it("forwards prepare when the loaded wizard implements it", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        credentials: [],
        prepare: async ({ cfg }) => ({ cfg: { ...cfg, channels: { demo: { enabled: true } } } }),
        status: {
          configuredLabel: "configured",
          resolveConfigured: () => true,
          unconfiguredLabel: "needs setup",
        },
      }),
    );

    const prepare = createDelegatedPrepare(loadWizard);

    expect(await runSetupWizardPrepare({ prepare })).toEqual({
      cfg: {
        channels: {
          demo: { enabled: true },
        },
      },
    });
  });
});

describe("createDelegatedFinalize", () => {
  it("forwards finalize when the loaded wizard implements it", async () => {
    const loadWizard = vi.fn(
      async (): Promise<ChannelSetupWizard> => ({
        channel: "demo",
        credentials: [],
        finalize: async ({ cfg, forceAllowFrom }) => ({
          cfg: {
            ...cfg,
            channels: {
              demo: { forceAllowFrom },
            },
          },
        }),
        status: {
          configuredLabel: "configured",
          resolveConfigured: () => true,
          unconfiguredLabel: "needs setup",
        },
      }),
    );

    const finalize = createDelegatedFinalize(loadWizard);

    expect(await runSetupWizardFinalize({ finalize, forceAllowFrom: true })).toEqual({
      cfg: {
        channels: {
          demo: { forceAllowFrom: true },
        },
      },
    });
  });
});

describe("createAllowlistSetupWizardProxy", () => {
  it("falls back when delegated surfaces are absent", async () => {
    const wizard = createAllowlistSetupWizardProxy({
      createBase: ({ promptAllowFrom, resolveAllowFromEntries, resolveGroupAllowlist }) => ({
        allowFrom: {
          apply: (params) => params.cfg,
          invalidWithoutCredentialNote: "need id",
          message: "Allow from",
          parseId: () => null,
          placeholder: "id",
          resolveEntries: resolveAllowFromEntries,
        },
        channel: "demo",
        credentials: [],
        dmPolicy: {
          allowFromKey: "channels.demo.allowFrom",
          channel: "demo" as never,
          getCurrent: () => "pairing",
          label: "Demo",
          policyKey: "channels.demo.dmPolicy",
          promptAllowFrom,
          setPolicy: (cfg) => cfg,
        },
        groupAccess: {
          currentEntries: () => [],
          currentPolicy: () => "allowlist",
          label: "Groups",
          placeholder: "group",
          resolveAllowlist: resolveGroupAllowlist,
          setPolicy: (params) => params.cfg,
          updatePrompt: () => false,
        },
        status: {
          configuredLabel: "configured",
          resolveConfigured: () => true,
          unconfiguredLabel: "needs setup",
        },
      }),
      fallbackResolvedGroupAllowlist: (entries) => entries.map((input) => ({ input })),
      loadWizard: async () =>
        ({
          channel: "demo",
          credentials: [],
          status: {
            configuredLabel: "configured",
            resolveConfigured: () => true,
            unconfiguredLabel: "needs setup",
          },
        }) satisfies ChannelSetupWizard,
    });

    expect(
      await promptSetupWizardAllowFrom({ promptAllowFrom: wizard.dmPolicy?.promptAllowFrom }),
    ).toEqual({});
    expect(
      await resolveSetupWizardAllowFromEntries({
        entries: ["alice"],
        resolveEntries: wizard.allowFrom?.resolveEntries,
      }),
    ).toEqual([{ id: null, input: "alice", resolved: false }]);
    expect(
      await resolveSetupWizardGroupAllowlist({
        entries: ["general"],
        resolveAllowlist: wizard.groupAccess?.resolveAllowlist,
      }),
    ).toEqual([{ input: "general" }]);
  });
});

describe("createDelegatedSetupWizardProxy", () => {
  it("builds a direct proxy wizard with delegated status/prepare/finalize", async () => {
    const wizard = createDelegatedSetupWizardProxy({
      channel: "demo",
      completionNote: { lines: ["line"], title: "Done" },
      credentials: [],
      delegateFinalize: true,
      delegatePrepare: true,
      loadWizard: async () =>
        ({
          channel: "demo",
          credentials: [],
          finalize: async ({ cfg }) => ({
            cfg: { ...cfg, channels: { demo: { finalized: true } } },
          }),
          prepare: async ({ cfg }) => ({
            cfg: { ...cfg, channels: { demo: { prepared: true } } },
          }),
          status: {
            configuredHint: "ready",
            configuredLabel: "configured",
            configuredScore: 1,
            resolveConfigured: async ({ cfg }) => Boolean(cfg.channels?.demo),
            resolveQuickstartScore: async () => 3,
            resolveSelectionHint: async () => "hint",
            resolveStatusLines: async () => ["line"],
            unconfiguredHint: "missing",
            unconfiguredLabel: "needs setup",
            unconfiguredScore: 0,
          },
        }) satisfies ChannelSetupWizard,
      status: {
        configuredHint: "ready",
        configuredLabel: "configured",
        configuredScore: 1,
        unconfiguredHint: "missing",
        unconfiguredLabel: "needs setup",
        unconfiguredScore: 0,
      },
      textInputs: [],
    });

    expect(await wizard.status.resolveConfigured({ cfg: {} })).toBe(false);
    expect(await wizard.status.resolveStatusLines?.({ cfg: {}, configured: false })).toEqual([
      "line",
    ]);
    expect(await runSetupWizardPrepare({ prepare: wizard.prepare })).toEqual({
      cfg: {
        channels: {
          demo: { prepared: true },
        },
      },
    });
    expect(await runSetupWizardFinalize({ finalize: wizard.finalize })).toEqual({
      cfg: {
        channels: {
          demo: { finalized: true },
        },
      },
    });
  });
});
