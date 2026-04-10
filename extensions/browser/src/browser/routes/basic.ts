import { getChromeMcpPid } from "../chrome-mcp.js";
import { resolveBrowserExecutableForPlatform } from "../chrome.executables.js";
import { toBrowserErrorResponse } from "../errors.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { createBrowserProfilesService } from "../profiles-service.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { resolveProfileContext } from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { getProfileContext, jsonError, toStringOrEmpty } from "./utils.js";

function handleBrowserRouteError(res: BrowserResponse, err: unknown) {
  const mapped = toBrowserErrorResponse(err);
  if (mapped) {
    return jsonError(res, mapped.status, mapped.message);
  }
  jsonError(res, 500, String(err));
}

async function withBasicProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (error) {
    return handleBrowserRouteError(params.res, error);
  }
}

async function withProfilesServiceMutation(params: {
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  run: (service: ReturnType<typeof createBrowserProfilesService>) => Promise<unknown>;
}) {
  try {
    const service = createBrowserProfilesService(params.ctx);
    const result = await params.run(service);
    params.res.json(result);
  } catch (error) {
    return handleBrowserRouteError(params.res, error);
  }
}

export function registerBrowserBasicRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  // List all profiles with their status
  app.get("/profiles", async (_req, res) => {
    try {
      const service = createBrowserProfilesService(ctx);
      const profiles = await service.listProfiles();
      res.json({ profiles });
    } catch (error) {
      jsonError(res, 500, String(error));
    }
  });

  // Get status (profile-aware)
  app.get("/", async (req, res) => {
    let current: ReturnType<typeof ctx.state>;
    try {
      current = ctx.state();
    } catch {
      return jsonError(res, 503, "browser server not started");
    }

    const profileCtx = getProfileContext(req, ctx);
    if ("error" in profileCtx) {
      return jsonError(res, profileCtx.status, profileCtx.error);
    }

    try {
      const [cdpHttp, cdpReady] = await Promise.all([
        profileCtx.isHttpReachable(300),
        profileCtx.isReachable(600),
      ]);

      const profileState = current.profiles.get(profileCtx.profile.name);
      const capabilities = getBrowserProfileCapabilities(profileCtx.profile);
      let detectedBrowser: string | null = null;
      let detectedExecutablePath: string | null = null;
      let detectError: string | null = null;

      try {
        const detected = resolveBrowserExecutableForPlatform(current.resolved, process.platform);
        if (detected) {
          detectedBrowser = detected.kind;
          detectedExecutablePath = detected.path;
        }
      } catch (error) {
        detectError = String(error);
      }

      res.json({
        attachOnly: profileCtx.profile.attachOnly,
        cdpHttp,
        cdpPort: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpPort,
        cdpReady,
        cdpUrl: capabilities.usesChromeMcp ? null : profileCtx.profile.cdpUrl,
        chosenBrowser: profileState?.running?.exe.kind ?? null,
        color: profileCtx.profile.color,
        detectError,
        detectedBrowser,
        detectedExecutablePath,
        driver: profileCtx.profile.driver,
        enabled: current.resolved.enabled,
        executablePath: current.resolved.executablePath ?? null,
        headless: current.resolved.headless,
        noSandbox: current.resolved.noSandbox,
        pid: capabilities.usesChromeMcp
          ? getChromeMcpPid(profileCtx.profile.name)
          : (profileState?.running?.pid ?? null),
        profile: profileCtx.profile.name,
        running: cdpReady,
        transport: capabilities.usesChromeMcp ? "chrome-mcp" : "cdp",
        userDataDir: profileState?.running?.userDataDir ?? profileCtx.profile.userDataDir ?? null,
      });
    } catch (error) {
      const mapped = toBrowserErrorResponse(error);
      if (mapped) {
        return jsonError(res, mapped.status, mapped.message);
      }
      jsonError(res, 500, String(error));
    }
  });

  // Start browser (profile-aware)
  app.post("/start", async (req, res) => {
    await withBasicProfileRoute({
      ctx,
      req,
      res,
      run: async (profileCtx) => {
        await profileCtx.ensureBrowserAvailable();
        res.json({ ok: true, profile: profileCtx.profile.name });
      },
    });
  });

  // Stop browser (profile-aware)
  app.post("/stop", async (req, res) => {
    await withBasicProfileRoute({
      ctx,
      req,
      res,
      run: async (profileCtx) => {
        const result = await profileCtx.stopRunningBrowser();
        res.json({
          ok: true,
          profile: profileCtx.profile.name,
          stopped: result.stopped,
        });
      },
    });
  });

  // Reset profile (profile-aware)
  app.post("/reset-profile", async (req, res) => {
    await withBasicProfileRoute({
      ctx,
      req,
      res,
      run: async (profileCtx) => {
        const result = await profileCtx.resetProfile();
        res.json({ ok: true, profile: profileCtx.profile.name, ...result });
      },
    });
  });

  // Create a new profile
  app.post("/profiles/create", async (req, res) => {
    const name = toStringOrEmpty((req.body as { name?: unknown })?.name);
    const color = toStringOrEmpty((req.body as { color?: unknown })?.color);
    const cdpUrl = toStringOrEmpty((req.body as { cdpUrl?: unknown })?.cdpUrl);
    const userDataDir = toStringOrEmpty((req.body as { userDataDir?: unknown })?.userDataDir);
    const driver = toStringOrEmpty((req.body as { driver?: unknown })?.driver);

    if (!name) {
      return jsonError(res, 400, "name is required");
    }
    if (driver && driver !== "openclaw" && driver !== "clawd" && driver !== "existing-session") {
      return jsonError(
        res,
        400,
        `unsupported profile driver "${driver}"; use "openclaw", "clawd", or "existing-session"`,
      );
    }

    await withProfilesServiceMutation({
      ctx,
      res,
      run: async (service) =>
        await service.createProfile({
          cdpUrl: cdpUrl || undefined,
          color: color || undefined,
          driver:
            driver === "existing-session"
              ? "existing-session"
              : driver === "openclaw" || driver === "clawd"
                ? "openclaw"
                : undefined,
          name,
          userDataDir: userDataDir || undefined,
        }),
    });
  });

  // Delete a profile
  app.delete("/profiles/:name", async (req, res) => {
    const name = toStringOrEmpty(req.params.name);
    if (!name) {
      return jsonError(res, 400, "profile name is required");
    }

    await withProfilesServiceMutation({
      ctx,
      res,
      run: async (service) => await service.deleteProfile(name),
    });
  });
}
