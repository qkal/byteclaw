import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const controlServiceMocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({ control: true })),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
}));

const dispatcherMocks = vi.hoisted(() => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: dispatcherMocks.dispatch,
  })),
  dispatch: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    browser: {},
    nodeHost: { browserProxy: { allowProfiles: [] as string[], enabled: true } },
  })),
}));

const browserConfigMocks = vi.hoisted(() => ({
  resolveBrowserConfig: vi.fn(() => ({
    defaultProfile: "openclaw",
    enabled: true,
  })),
}));

vi.mock("openclaw/plugin-sdk/browser-config-runtime", () => ({
  loadConfig: configMocks.loadConfig,
}));

vi.mock("openclaw/plugin-sdk/browser-node-runtime", () => ({
  withTimeout: vi.fn(
    async (
      run: (signal: AbortSignal | undefined) => Promise<unknown>,
      timeoutMs?: number,
      label?: string,
    ) => {
      const resolved =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
          ? Math.max(1, Math.floor(timeoutMs))
          : undefined;
      if (!resolved) {
        return await run(undefined);
      }
      const abortCtrl = new AbortController();
      const timeoutError = new Error(`${label ?? "request"} timed out`);
      const timer = setTimeout(() => abortCtrl.abort(timeoutError), resolved);
      try {
        return await Promise.race([
          run(abortCtrl.signal),
          new Promise<never>((_, reject) => {
            abortCtrl.signal.addEventListener(
              "abort",
              () => reject(abortCtrl.signal.reason ?? timeoutError),
              { once: true },
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/browser-setup-tools", () => ({
  detectMime: vi.fn(async () => "image/png"),
}));

vi.mock("../browser/cdp.helpers.js", () => ({
  redactCdpUrl: vi.fn((url: string) => {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      const normalized = parsed.toString().replace(/\/$/, "");
      const token = parsed.searchParams.get("token");
      if (!token || token.length <= 8) {
        return normalized;
      }
      return normalized.replace(token, `${token.slice(0, 6)}…${token.slice(-4)}`);
    } catch {
      return url;
    }
  }),
}));

vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: browserConfigMocks.resolveBrowserConfig,
}));

vi.mock("../browser/request-policy.js", () => ({
  isPersistentBrowserProfileMutation: vi.fn((method: string, path: string) => {
    if (method === "POST" && (path === "/profiles/create" || path === "/reset-profile")) {
      return true;
    }
    return method === "DELETE" && /^\/profiles\/[^/]+$/.test(path);
  }),
  normalizeBrowserRequestPath: vi.fn((path: string) => path),
  resolveRequestedBrowserProfile: vi.fn(
    ({
      query,
      body,
      profile,
    }: {
      query?: Record<string, unknown>;
      body?: unknown;
      profile?: string;
    }) => {
      if (query && typeof query.profile === "string" && query.profile.trim()) {
        return query.profile.trim();
      }
      const bodyProfile =
        body && typeof body === "object" ? (body as { profile?: unknown }).profile : undefined;
      if (typeof bodyProfile === "string" && bodyProfile.trim()) {
        return bodyProfile.trim();
      }
      return typeof profile === "string" && profile.trim() ? profile.trim() : undefined;
    },
  ),
}));

vi.mock("../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: dispatcherMocks.createBrowserRouteDispatcher,
}));

vi.mock("../control-service.js", () => ({
  createBrowserControlContext: controlServiceMocks.createBrowserControlContext,
  startBrowserControlServiceFromConfig: controlServiceMocks.startBrowserControlServiceFromConfig,
}));

let resetBrowserProxyCommandStateForTests: typeof import("./invoke-browser.js").resetBrowserProxyCommandStateForTests;
let runBrowserProxyCommand: typeof import("./invoke-browser.js").runBrowserProxyCommand;

beforeAll(async () => {
  ({ resetBrowserProxyCommandStateForTests, runBrowserProxyCommand } =
    await import("./invoke-browser.js"));
});

describe("runBrowserProxyCommand", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetBrowserProxyCommandStateForTests();
    dispatcherMocks.dispatch.mockReset();
    dispatcherMocks.createBrowserRouteDispatcher.mockReset().mockImplementation(() => ({
      dispatch: dispatcherMocks.dispatch,
    }));
    controlServiceMocks.createBrowserControlContext.mockReset().mockReturnValue({ control: true });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockReset().mockResolvedValue(true);
    configMocks.loadConfig.mockReset().mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: [] as string[], enabled: true } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReset().mockReturnValue({
      defaultProfile: "openclaw",
      enabled: true,
    });
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: [] as string[], enabled: true } },
    });
    browserConfigMocks.resolveBrowserConfig.mockReturnValue({
      defaultProfile: "openclaw",
      enabled: true,
    });
    controlServiceMocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
  });

  it("adds profile and browser status details on ws-backed timeouts", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        body: {
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: "http://127.0.0.1:18792",
          running: true,
        },
        status: 200,
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "openclaw",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=openclaw; status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=http:\/\/127\.0\.0\.1:18792\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("includes chrome-mcp transport in timeout diagnostics when no CDP URL exists", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        body: {
          cdpHttp: true,
          cdpReady: false,
          cdpUrl: null,
          running: true,
          transport: "chrome-mcp",
        },
        status: 200,
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "user",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /browser proxy timed out for GET \/snapshot after 5ms; ws-backed browser action; profile=user; status\(running=true, cdpHttp=true, cdpReady=false, transport=chrome-mcp\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("redacts sensitive cdpUrl details in timeout diagnostics", async () => {
    vi.useFakeTimers();
    dispatcherMocks.dispatch
      .mockImplementationOnce(async () => {
        await new Promise(() => {});
      })
      .mockResolvedValueOnce({
        body: {
          cdpHttp: true,
          cdpReady: false,
          cdpUrl:
            "https://alice:supersecretpasswordvalue1234@example.com/chrome?token=supersecrettokenvalue1234567890",
          running: true,
        },
        status: 200,
      });

    const result = expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          profile: "remote",
          timeoutMs: 5,
        }),
      ),
    ).rejects.toThrow(
      /status\(running=true, cdpHttp=true, cdpReady=false, cdpUrl=https:\/\/example\.com\/chrome\?token=supers…7890\)/,
    );
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it("keeps non-timeout browser errors intact", async () => {
    dispatcherMocks.dispatch.mockResolvedValue({
      body: { error: "tab not found" },
      status: 500,
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "POST",
          path: "/act",
          profile: "openclaw",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("tab not found");
  });

  it("rejects unauthorized query.profile when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: ["openclaw"], enabled: true } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "GET",
          path: "/snapshot",
          query: { profile: "user" },
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects unauthorized body.profile when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: ["openclaw"], enabled: true } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          body: { profile: "user" },
          method: "POST",
          path: "/stop",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser profile not allowed");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile creation when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: ["openclaw"], enabled: true } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          body: { cdpUrl: "http://127.0.0.1:9222", name: "poc" },
          method: "POST",
          path: "/profiles/create",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile deletion when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: ["openclaw"], enabled: true } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          method: "DELETE",
          path: "/profiles/poc",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects persistent profile reset when allowProfiles is configured", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: ["openclaw"], enabled: true } },
    });

    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          body: { name: "openclaw", profile: "openclaw" },
          method: "POST",
          path: "/reset-profile",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes an allowlisted body profile into the dispatched query", async () => {
    configMocks.loadConfig.mockReturnValue({
      browser: {},
      nodeHost: { browserProxy: { allowProfiles: ["openclaw"], enabled: true } },
    });
    dispatcherMocks.dispatch.mockResolvedValue({
      body: { ok: true },
      status: 200,
    });

    await runBrowserProxyCommand(
      JSON.stringify({
        body: { profile: "openclaw" },
        method: "POST",
        path: "/stop",
        timeoutMs: 50,
      }),
    );

    expect(dispatcherMocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/stop",
        query: { profile: "openclaw" },
      }),
    );
  });

  it("rejects persistent profile creation when allowProfiles is empty", async () => {
    await expect(
      runBrowserProxyCommand(
        JSON.stringify({
          body: { cdpUrl: "http://127.0.0.1:9222", name: "poc" },
          method: "POST",
          path: "/profiles/create",
          timeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("INVALID_REQUEST: browser.proxy cannot mutate persistent browser profiles");
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
  });
});
