import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "../errors.js";
import {
  assertBrowserNavigationAllowed,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { getProfileContext, jsonError, toNumber, toStringOrEmpty } from "./utils.js";

function resolveTabsProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
) {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

function handleTabsRouteError(
  ctx: BrowserRouteContext,
  res: BrowserResponse,
  err: unknown,
  opts?: { mapTabError?: boolean },
) {
  if (opts?.mapTabError) {
    const mapped = ctx.mapTabError(err);
    if (mapped) {
      return jsonError(res, mapped.status, mapped.message);
    }
  }
  return jsonError(res, 500, String(err));
}

async function withTabsProfileRoute(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  mapTabError?: boolean;
  run: (profileCtx: ProfileContext) => Promise<void>;
}) {
  const profileCtx = resolveTabsProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return;
  }
  try {
    await params.run(profileCtx);
  } catch (error) {
    handleTabsRouteError(params.ctx, params.res, error, { mapTabError: params.mapTabError });
  }
}

async function ensureBrowserRunning(profileCtx: ProfileContext, res: BrowserResponse) {
  if (!(await profileCtx.isReachable(300))) {
    jsonError(
      res,
      new BrowserProfileUnavailableError("browser not running").status,
      "browser not running",
    );
    return false;
  }
  return true;
}

function resolveIndexedTab(
  tabs: Awaited<ReturnType<ProfileContext["listTabs"]>>,
  index: number | undefined,
) {
  return typeof index === "number" ? tabs[index] : tabs.at(0);
}

function parseRequiredTargetId(res: BrowserResponse, rawTargetId: unknown): string | null {
  const targetId = toStringOrEmpty(rawTargetId);
  if (!targetId) {
    jsonError(res, 400, "targetId is required");
    return null;
  }
  return targetId;
}

async function runTabTargetMutation(params: {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId: string;
  mutate: (profileCtx: ProfileContext, targetId: string) => Promise<void>;
}) {
  await withTabsProfileRoute({
    ctx: params.ctx,
    mapTabError: true,
    req: params.req,
    res: params.res,
    run: async (profileCtx) => {
      if (!(await ensureBrowserRunning(profileCtx, params.res))) {
        return;
      }
      await params.mutate(profileCtx, params.targetId);
      params.res.json({ ok: true });
    },
  });
}

export function registerBrowserTabRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  app.get("/tabs", async (req, res) => {
    await withTabsProfileRoute({
      ctx,
      req,
      res,
      run: async (profileCtx) => {
        const reachable = await profileCtx.isReachable(300);
        if (!reachable) {
          return res.json({ running: false, tabs: [] as unknown[] });
        }
        const tabs = await profileCtx.listTabs();
        res.json({ running: true, tabs });
      },
    });
  });

  app.post("/tabs/open", async (req, res) => {
    const url = toStringOrEmpty((req.body as { url?: unknown })?.url);
    if (!url) {
      return jsonError(res, 400, "url is required");
    }

    await withTabsProfileRoute({
      ctx,
      mapTabError: true,
      req,
      res,
      run: async (profileCtx) => {
        await assertBrowserNavigationAllowed({
          url,
          ...withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy),
        });
        await profileCtx.ensureBrowserAvailable();
        const tab = await profileCtx.openTab(url);
        res.json(tab);
      },
    });
  });

  app.post("/tabs/focus", async (req, res) => {
    const targetId = parseRequiredTargetId(res, (req.body as { targetId?: unknown })?.targetId);
    if (!targetId) {
      return;
    }
    await runTabTargetMutation({
      ctx,
      mutate: async (profileCtx, id) => {
        await profileCtx.focusTab(id);
      },
      req,
      res,
      targetId,
    });
  });

  app.delete("/tabs/:targetId", async (req, res) => {
    const targetId = parseRequiredTargetId(res, req.params.targetId);
    if (!targetId) {
      return;
    }
    await runTabTargetMutation({
      ctx,
      mutate: async (profileCtx, id) => {
        await profileCtx.closeTab(id);
      },
      req,
      res,
      targetId,
    });
  });

  app.post("/tabs/action", async (req, res) => {
    const action = toStringOrEmpty((req.body as { action?: unknown })?.action);
    const index = toNumber((req.body as { index?: unknown })?.index);

    await withTabsProfileRoute({
      ctx,
      mapTabError: true,
      req,
      res,
      run: async (profileCtx) => {
        if (action === "list") {
          const reachable = await profileCtx.isReachable(300);
          if (!reachable) {
            return res.json({ ok: true, tabs: [] as unknown[] });
          }
          const tabs = await profileCtx.listTabs();
          return res.json({ ok: true, tabs });
        }

        if (action === "new") {
          await profileCtx.ensureBrowserAvailable();
          const tab = await profileCtx.openTab("about:blank");
          return res.json({ ok: true, tab });
        }

        if (action === "close") {
          const tabs = await profileCtx.listTabs();
          const target = resolveIndexedTab(tabs, index);
          if (!target) {
            throw new BrowserTabNotFoundError();
          }
          await profileCtx.closeTab(target.targetId);
          return res.json({ ok: true, targetId: target.targetId });
        }

        if (action === "select") {
          if (typeof index !== "number") {
            return jsonError(res, 400, "index is required");
          }
          const tabs = await profileCtx.listTabs();
          const target = tabs[index];
          if (!target) {
            throw new BrowserTabNotFoundError();
          }
          await profileCtx.focusTab(target.targetId);
          return res.json({ ok: true, targetId: target.targetId });
        }

        return jsonError(res, 400, "unknown tab action");
      },
    });
  });
}
