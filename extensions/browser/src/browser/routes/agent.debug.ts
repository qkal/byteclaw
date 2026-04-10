import crypto from "node:crypto";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { DEFAULT_TRACE_DIR } from "./path-output.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { toBoolean, toStringOrEmpty } from "./utils.js";

export function registerBrowserAgentDebugRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get("/console", async (req, res) => {
    const targetId = resolveTargetIdFromQuery(req.query);
    const level = typeof req.query.level === "string" ? req.query.level : "";

    await withPlaywrightRouteContext({
      ctx,
      feature: "console messages",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const messages = await pw.getConsoleMessagesViaPlaywright({
          cdpUrl,
          level: normalizeOptionalString(level),
          targetId: tab.targetId,
        });
        res.json({ messages, ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.get("/errors", async (req, res) => {
    const targetId = resolveTargetIdFromQuery(req.query);
    const clear = toBoolean(req.query.clear) ?? false;

    await withPlaywrightRouteContext({
      ctx,
      feature: "page errors",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const result = await pw.getPageErrorsViaPlaywright({
          cdpUrl,
          clear,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
      targetId,
    });
  });

  app.get("/requests", async (req, res) => {
    const targetId = resolveTargetIdFromQuery(req.query);
    const filter = typeof req.query.filter === "string" ? req.query.filter : "";
    const clear = toBoolean(req.query.clear) ?? false;

    await withPlaywrightRouteContext({
      ctx,
      feature: "network requests",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const result = await pw.getNetworkRequestsViaPlaywright({
          cdpUrl,
          clear,
          filter: normalizeOptionalString(filter),
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
      targetId,
    });
  });

  app.post("/trace/start", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const screenshots = toBoolean(body.screenshots) ?? undefined;
    const snapshots = toBoolean(body.snapshots) ?? undefined;
    const sources = toBoolean(body.sources) ?? undefined;

    await withPlaywrightRouteContext({
      ctx,
      feature: "trace start",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.traceStartViaPlaywright({
          cdpUrl,
          screenshots,
          snapshots,
          sources,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/trace/stop", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const out = toStringOrEmpty(body.path) || "";

    await withPlaywrightRouteContext({
      ctx,
      feature: "trace stop",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const id = crypto.randomUUID();
        const tracePath = await resolveWritableOutputPathOrRespond({
          defaultFileName: `browser-trace-${id}.zip`,
          ensureRootDir: true,
          requestedPath: out,
          res,
          rootDir: DEFAULT_TRACE_DIR,
          scopeLabel: "trace directory",
        });
        if (!tracePath) {
          return;
        }
        await pw.traceStopViaPlaywright({
          cdpUrl,
          path: tracePath,
          targetId: tab.targetId,
        });
        res.json({
          ok: true,
          path: path.resolve(tracePath),
          targetId: tab.targetId,
        });
      },
      targetId,
    });
  });
}
