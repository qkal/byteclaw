import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawConfig, OpenClawPluginApi } from "../runtime-api.js";

vi.mock("../../../test/helpers/config/bundled-channel-config-runtime.js", () => ({
  getBundledChannelConfigSchemaMap: () => new Map(),
  getBundledChannelRuntimeMap: () => new Map(),
}));

const resolveMattermostAccount = vi.hoisted(() => vi.fn());
const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const hasConfiguredSecretInput = vi.hoisted(() => vi.fn((value: unknown) => Boolean(value)));

vi.mock("./setup.accounts.runtime.js", () => ({
  listMattermostAccountIds: vi.fn((cfg: OpenClawConfig) => {
    const accounts = cfg.channels?.mattermost?.accounts;
    const ids = accounts ? Object.keys(accounts) : [];
    return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
  }),
  resolveMattermostAccount: (params: Parameters<typeof resolveMattermostAccount>[0]) => {
    const mocked = resolveMattermostAccount(params);
    return (
      mocked ?? {
        accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
        baseUrl: normalizeMattermostBaseUrl(params.cfg.channels?.mattermost?.baseUrl),
        baseUrlSource: params.cfg.channels?.mattermost?.baseUrl ? "config" : "none",
        botToken:
          typeof params.cfg.channels?.mattermost?.botToken === "string"
            ? params.cfg.channels.mattermost.botToken
            : undefined,
        botTokenSource:
          typeof params.cfg.channels?.mattermost?.botToken === "string" ? "config" : "none",
        config: params.cfg.channels?.mattermost ?? {},
        enabled: params.cfg.channels?.mattermost?.enabled !== false,
      }
    );
  },
}));

vi.mock("./setup.client.runtime.js", () => ({
  normalizeMattermostBaseUrl,
}));

vi.mock("./setup.secret-input.runtime.js", () => ({
  hasConfiguredSecretInput,
}));

function createApi(
  registrationMode: OpenClawPluginApi["registrationMode"],
  registerHttpRoute = vi.fn(),
): OpenClawPluginApi {
  return createTestPluginApi({
    config: {},
    id: "mattermost",
    name: "Mattermost",
    registerHttpRoute,
    registrationMode,
    runtime: {} as OpenClawPluginApi["runtime"],
    source: "test",
  });
}

let plugin: typeof import("../index.js").default;
let mattermostSetupWizard: typeof import("./setup-surface.js").mattermostSetupWizard;
let isMattermostConfigured: typeof import("./setup-core.js").isMattermostConfigured;
let resolveMattermostAccountWithSecrets: typeof import("./setup-core.js").resolveMattermostAccountWithSecrets;
let mattermostSetupAdapter: typeof import("./setup-core.js").mattermostSetupAdapter;

describe("mattermost setup", () => {
  beforeAll(async () => {
    ({ mattermostSetupWizard } = await import("./setup-surface.js"));
    ({ isMattermostConfigured, resolveMattermostAccountWithSecrets, mattermostSetupAdapter } =
      await import("./setup-core.js"));
    plugin = {
      register(api: OpenClawPluginApi) {
        if (api.registrationMode === "full") {
          api.registerHttpRoute({
            auth: "plugin",
            handler: async () => true,
            path: "/api/channels/mattermost/command",
          });
        }
      },
    } as typeof plugin;
  });

  beforeEach(() => {
    registerEnvDefaults();
  });

  afterEach(() => {
    resolveMattermostAccount.mockReset();
    normalizeMattermostBaseUrl.mockReset();
    normalizeMattermostBaseUrl.mockImplementation((value: string | undefined) => value);
    hasConfiguredSecretInput.mockReset();
    hasConfiguredSecretInput.mockImplementation((value: unknown) => Boolean(value));
    vi.unstubAllEnvs();
  });

  it("reports configuration only when token and base url are both present", () => {
    expect(
      isMattermostConfigured({
        baseUrl: "https://chat.example.com",
        botToken: "bot-token",
        config: {},
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        baseUrl: "https://chat.example.com",
        botToken: "",
        config: { botToken: "secret-ref" },
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        baseUrl: "",
        botToken: "",
        config: {},
      } as never),
    ).toBe(false);
  });

  it("resolves accounts with unresolved secret refs allowed", () => {
    resolveMattermostAccount.mockReturnValue({ accountId: "default" });

    const cfg = { channels: { mattermost: {} } };

    expect(resolveMattermostAccountWithSecrets(cfg as never, "default")).toEqual({
      accountId: "default",
    });
    expect(resolveMattermostAccount).toHaveBeenCalledWith({
      accountId: "default",
      allowUnresolvedSecretRef: true,
      cfg,
    });
  });

  it("validates env and explicit credential requirements", () => {
    const { validateInput } = mattermostSetupAdapter;
    expect(validateInput).toBeTypeOf("function");

    expect(
      validateInput!({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("Mattermost env vars can only be used for the default account.");

    normalizeMattermostBaseUrl.mockReturnValue(undefined);
    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { botToken: "tok", httpUrl: "not-a-url", useEnv: false },
      } as never),
    ).toBe("Mattermost requires --bot-token and --http-url (or --use-env).");

    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { botToken: "tok", httpUrl: "https://chat.example.com", useEnv: false },
      } as never),
    ).toBeNull();
  });

  it("applies normalized config for default and named accounts", () => {
    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    const { applyAccountConfig } = mattermostSetupAdapter;
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      applyAccountConfig({
        accountId: DEFAULT_ACCOUNT_ID,
        cfg: { channels: { mattermost: {} } },
        input: {
          botToken: "tok",
          httpUrl: "https://chat.example.com",
          name: "Default",
        },
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          baseUrl: "https://chat.example.com",
          botToken: "tok",
          enabled: true,
          name: "Default",
        },
      },
    });

    expect(
      applyAccountConfig({
        accountId: "Work Team",
        cfg: {
          channels: {
            mattermost: {
              name: "Legacy",
            },
          },
        },
        input: {
          botToken: "tok2",
          httpUrl: "https://chat.example.com",
          name: "Work",
        },
      } as never),
    ).toMatchObject({
      channels: {
        mattermost: {
          accounts: {
            default: { name: "Legacy" },
            "work-team": {
              baseUrl: "https://chat.example.com",
              botToken: "tok2",
              enabled: true,
              name: "Work",
            },
          },
        },
      },
    });
  });

  it.each([
    { mode: "setup-only" as const, name: "skips slash callback registration in setup-only mode" },
    { mode: "full" as const, name: "registers slash callback routes in full mode" },
  ])("$name", ({ mode }) => {
    const registerHttpRoute = vi.fn();

    plugin.register(createApi(mode, registerHttpRoute));

    if (mode === "setup-only") {
      expect(registerHttpRoute).not.toHaveBeenCalled();
      return;
    }

    expect(registerHttpRoute).toHaveBeenCalledTimes(1);
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: "plugin",
        path: "/api/channels/mattermost/command",
      }),
    );
  });

  it("treats secret-ref tokens plus base url as configured", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: {
              id: "MATTERMOST_BOT_TOKEN",
              provider: "default",
              source: "env",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      accountId: undefined,
      cfg: {
        channels: {
          mattermost: {
            accounts: {
              alerts: {
                baseUrl: "https://chat.example.com",
                botToken: {
                  id: "MATTERMOST_BOT_TOKEN",
                  provider: "default",
                  source: "env",
                },
              },
              work: {},
            },
            defaultAccount: "work",
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });

  it("shows intro note only when the target account is not configured", () => {
    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        accountId: "default",
        cfg: {
          channels: {
            mattermost: {},
          },
        } as OpenClawConfig,
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        accountId: "default",
        cfg: {
          channels: {
            mattermost: {
              baseUrl: "https://chat.example.com",
              botToken: {
                id: "MATTERMOST_BOT_TOKEN",
                provider: "default",
                source: "env",
              },
            },
          },
        } as OpenClawConfig,
      } as never),
    ).toBe(false);
  });

  it("offers env shortcut only for the default account when env is present and config is empty", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "bot-token");
    vi.stubEnv("MATTERMOST_URL", "https://chat.example.com");

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        accountId: "default",
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        accountId: "work",
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
      } as never),
    ).toBe(false);
  });

  it("keeps env shortcut as a no-op patch for the selected account", () => {
    expect(
      mattermostSetupWizard.envShortcut?.apply?.({
        accountId: "default",
        cfg: { channels: { mattermost: { enabled: false } } } as OpenClawConfig,
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    });
  });
});

function registerEnvDefaults() {
  vi.unstubAllEnvs();
}
