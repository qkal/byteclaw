import path from "node:path";
import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import { captureScreenshot, snapshotAria } from "../cdp.js";
import {
  evaluateChromeMcpScript,
  navigateChromeMcpPage,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
} from "../chrome-mcp.js";
import {
  buildAiSnapshotFromChromeMcpSnapshot,
  flattenChromeMcpSnapshotToAriaNodes,
} from "../chrome-mcp.snapshot.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
} from "../navigation-guard.js";
import { withBrowserNavigationPolicy } from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  getPwAiModule,
  handleRouteError,
  readBody,
  requirePwAi,
  resolveProfileContext,
  withPlaywrightRouteContext,
  withRouteTabContext,
} from "./agent.shared.js";
import {
  resolveSnapshotPlan,
  shouldUsePlaywrightForAriaSnapshot,
  shouldUsePlaywrightForScreenshot,
} from "./agent.snapshot.plan.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

const CHROME_MCP_OVERLAY_ATTR = "data-openclaw-mcp-overlay";

async function clearChromeMcpOverlay(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
}): Promise<void> {
  await evaluateChromeMcpScript({
    fn: `() => {
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      return true;
    }`,
    profileName: params.profileName,
    targetId: params.targetId,
    userDataDir: params.userDataDir,
  }).catch(() => {});
}

async function renderChromeMcpLabels(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  refs: string[];
}): Promise<{ labels: number; skipped: number }> {
  const refList = JSON.stringify(params.refs);
  const result = await evaluateChromeMcpScript({
    args: params.refs,
    fn: `(...elements) => {
      const refs = ${refList};
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      const root = document.createElement("div");
      root.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "labels");
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";
      let labels = 0;
      let skipped = 0;
      elements.forEach((el, index) => {
        if (!(el instanceof Element)) {
          skipped += 1;
          return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
          skipped += 1;
          return;
        }
        labels += 1;
        const badge = document.createElement("div");
        badge.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "label");
        badge.textContent = refs[index] || String(labels);
        badge.style.position = "fixed";
        badge.style.left = \`\${Math.max(0, rect.left)}px\`;
        badge.style.top = \`\${Math.max(0, rect.top)}px\`;
        badge.style.transform = "translateY(-100%)";
        badge.style.padding = "2px 6px";
        badge.style.borderRadius = "999px";
        badge.style.background = "#FF4500";
        badge.style.color = "#fff";
        badge.style.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
        badge.style.whiteSpace = "nowrap";
        root.appendChild(badge);
      });
      document.documentElement.appendChild(root);
      return { labels, skipped };
    }`,
    profileName: params.profileName,
    targetId: params.targetId,
    userDataDir: params.userDataDir,
  });
  const labels =
    result &&
    typeof result === "object" &&
    typeof (result as { labels?: unknown }).labels === "number"
      ? (result as { labels: number }).labels
      : 0;
  const skipped =
    result &&
    typeof result === "object" &&
    typeof (result as { skipped?: unknown }).skipped === "number"
      ? (result as { skipped: number }).skipped
      : 0;
  return { labels, skipped };
}

async function saveNormalizedScreenshotResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  type: "png" | "jpeg";
  targetId: string;
  url: string;
}) {
  const normalized = await normalizeBrowserScreenshot(params.buffer, {
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
    maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  });
  await saveBrowserMediaResponse({
    buffer: normalized.buffer,
    contentType: normalized.contentType ?? `image/${params.type}`,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
    res: params.res,
    targetId: params.targetId,
    url: params.url,
  });
}

async function saveBrowserMediaResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  contentType: string;
  maxBytes: number;
  targetId: string;
  url: string;
}) {
  await ensureMediaDir();
  const saved = await saveMediaBuffer(
    params.buffer,
    params.contentType,
    "browser",
    params.maxBytes,
  );
  params.res.json({
    ok: true,
    path: path.resolve(saved.path),
    targetId: params.targetId,
    url: params.url,
  });
}

/** Resolve the correct targetId after a navigation that may trigger a renderer swap. */
export async function resolveTargetIdAfterNavigate(opts: {
  oldTargetId: string;
  navigatedUrl: string;
  listTabs: () => Promise<{ targetId: string; url: string }[]>;
}): Promise<string> {
  let currentTargetId = opts.oldTargetId;
  try {
    const pickReplacement = (
      tabs: { targetId: string; url: string }[],
      options?: { allowSingleTabFallback?: boolean },
    ) => {
      if (tabs.some((tab) => tab.targetId === opts.oldTargetId)) {
        return opts.oldTargetId;
      }
      const byUrl = tabs.filter((tab) => tab.url === opts.navigatedUrl);
      if (byUrl.length === 1) {
        return byUrl[0]?.targetId ?? opts.oldTargetId;
      }
      const uniqueReplacement = byUrl.filter((tab) => tab.targetId !== opts.oldTargetId);
      if (uniqueReplacement.length === 1) {
        return uniqueReplacement[0]?.targetId ?? opts.oldTargetId;
      }
      if (options?.allowSingleTabFallback && tabs.length === 1) {
        return tabs[0]?.targetId ?? opts.oldTargetId;
      }
      return opts.oldTargetId;
    };

    currentTargetId = pickReplacement(await opts.listTabs());
    if (currentTargetId === opts.oldTargetId) {
      await new Promise((r) => setTimeout(r, 800));
      currentTargetId = pickReplacement(await opts.listTabs(), {
        allowSingleTabFallback: true,
      });
    }
  } catch {
    // Best-effort: fall back to pre-navigation targetId
  }
  return currentTargetId;
}

export function registerBrowserAgentSnapshotRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/navigate", async (req, res) => {
    const body = readBody(req);
    const url = toStringOrEmpty(body.url);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    if (!url) {
      return jsonError(res, 400, "url is required");
    }
    await withRouteTabContext({
      ctx,
      req,
      res,
      run: async ({ profileCtx, tab, cdpUrl }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          const ssrfPolicyOpts = withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy);
          await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
          const result = await navigateChromeMcpPage({
            profileName: profileCtx.profile.name,
            targetId: tab.targetId,
            url,
            userDataDir: profileCtx.profile.userDataDir,
          });
          await assertBrowserNavigationResultAllowed({ url: result.url, ...ssrfPolicyOpts });
          return res.json({ ok: true, targetId: tab.targetId, ...result });
        }
        const pw = await requirePwAi(res, "navigate");
        if (!pw) {
          return;
        }
        const result = await pw.navigateViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          url,
          ...withBrowserNavigationPolicy(ctx.state().resolved.ssrfPolicy),
        });
        const currentTargetId = await resolveTargetIdAfterNavigate({
          listTabs: () => profileCtx.listTabs(),
          navigatedUrl: result.url,
          oldTargetId: tab.targetId,
        });
        res.json({ ok: true, targetId: currentTargetId, ...result });
      },
      targetId,
    });
  });

  app.post("/pdf", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
      return jsonError(res, 501, EXISTING_SESSION_LIMITS.snapshot.pdfUnsupported);
    }
    await withPlaywrightRouteContext({
      ctx,
      feature: "pdf",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const pdf = await pw.pdfViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
        });
        await saveBrowserMediaResponse({
          buffer: pdf.buffer,
          contentType: "application/pdf",
          maxBytes: pdf.buffer.byteLength,
          res,
          targetId: tab.targetId,
          url: tab.url,
        });
      },
      targetId,
    });
  });

  app.post("/screenshot", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const fullPage = toBoolean(body.fullPage) ?? false;
    const ref = toStringOrEmpty(body.ref) || undefined;
    const element = toStringOrEmpty(body.element) || undefined;
    const type = body.type === "jpeg" ? "jpeg" : "png";

    if (fullPage && (ref || element)) {
      return jsonError(res, 400, "fullPage is not supported for element screenshots");
    }

    await withRouteTabContext({
      ctx,
      req,
      res,
      run: async ({ profileCtx, tab, cdpUrl }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          if (element) {
            return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.screenshotElement);
          }
          const buffer = await takeChromeMcpScreenshot({
            format: type,
            fullPage,
            profileName: profileCtx.profile.name,
            targetId: tab.targetId,
            uid: ref,
            userDataDir: profileCtx.profile.userDataDir,
          });
          await saveNormalizedScreenshotResponse({
            buffer,
            res,
            targetId: tab.targetId,
            type,
            url: tab.url,
          });
          return;
        }

        let buffer: Buffer;
        const shouldUsePlaywright = shouldUsePlaywrightForScreenshot({
          element,
          profile: profileCtx.profile,
          ref,
          wsUrl: tab.wsUrl,
        });
        if (shouldUsePlaywright) {
          const pw = await requirePwAi(res, "screenshot");
          if (!pw) {
            return;
          }
          const snap = await pw.takeScreenshotViaPlaywright({
            cdpUrl,
            element,
            fullPage,
            ref,
            targetId: tab.targetId,
            type,
          });
          ({ buffer } = snap);
        } else {
          buffer = await captureScreenshot({
            format: type,
            fullPage,
            quality: type === "jpeg" ? 85 : undefined,
            wsUrl: tab.wsUrl ?? "",
          });
        }

        await saveNormalizedScreenshotResponse({
          buffer,
          res,
          targetId: tab.targetId,
          type,
          url: tab.url,
        });
      },
      targetId,
    });
  });

  app.get("/snapshot", async (req, res) => {
    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
    const hasPlaywright = Boolean(await getPwAiModule());
    const plan = resolveSnapshotPlan({
      hasPlaywright,
      profile: profileCtx.profile,
      query: req.query,
    });

    try {
      const tab = await profileCtx.ensureTabAvailable(targetId || undefined);
      if ((plan.labels || plan.mode === "efficient") && plan.format === "aria") {
        return jsonError(res, 400, "labels/mode=efficient require format=ai");
      }
      if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
        if (plan.selectorValue || plan.frameSelectorValue) {
          return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.snapshotSelector);
        }
        const snapshot = await takeChromeMcpSnapshot({
          profileName: profileCtx.profile.name,
          targetId: tab.targetId,
          userDataDir: profileCtx.profile.userDataDir,
        });
        if (plan.format === "aria") {
          return res.json({
            format: "aria",
            nodes: flattenChromeMcpSnapshotToAriaNodes(snapshot, plan.limit),
            ok: true,
            targetId: tab.targetId,
            url: tab.url,
          });
        }
        const built = buildAiSnapshotFromChromeMcpSnapshot({
          maxChars: plan.resolvedMaxChars,
          options: {
            compact: plan.compact ?? undefined,
            interactive: plan.interactive ?? undefined,
            maxDepth: plan.depth ?? undefined,
          },
          root: snapshot,
        });
        if (plan.labels) {
          const refs = Object.keys(built.refs);
          const labelResult = await renderChromeMcpLabels({
            profileName: profileCtx.profile.name,
            refs,
            targetId: tab.targetId,
            userDataDir: profileCtx.profile.userDataDir,
          });
          try {
            const labeled = await takeChromeMcpScreenshot({
              format: "png",
              profileName: profileCtx.profile.name,
              targetId: tab.targetId,
              userDataDir: profileCtx.profile.userDataDir,
            });
            const normalized = await normalizeBrowserScreenshot(labeled, {
              maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
              maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
            });
            await ensureMediaDir();
            const saved = await saveMediaBuffer(
              normalized.buffer,
              normalized.contentType ?? "image/png",
              "browser",
              DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            );
            return res.json({
              format: "ai",
              imagePath: path.resolve(saved.path),
              imageType: normalized.contentType?.includes("jpeg") ? "jpeg" : "png",
              labels: true,
              labelsCount: labelResult.labels,
              labelsSkipped: labelResult.skipped,
              ok: true,
              targetId: tab.targetId,
              url: tab.url,
              ...built,
            });
          } finally {
            await clearChromeMcpOverlay({
              profileName: profileCtx.profile.name,
              targetId: tab.targetId,
              userDataDir: profileCtx.profile.userDataDir,
            });
          }
        }
        return res.json({
          format: "ai",
          ok: true,
          targetId: tab.targetId,
          url: tab.url,
          ...built,
        });
      }
      if (plan.format === "ai") {
        const pw = await requirePwAi(res, "ai snapshot");
        if (!pw) {
          return;
        }
        const roleSnapshotArgs = {
          cdpUrl: profileCtx.profile.cdpUrl,
          frameSelector: plan.frameSelectorValue,
          options: {
            compact: plan.compact ?? undefined,
            interactive: plan.interactive ?? undefined,
            maxDepth: plan.depth ?? undefined,
          },
          refsMode: plan.refsMode,
          selector: plan.selectorValue,
          ssrfPolicy: ctx.state().resolved.ssrfPolicy,
          targetId: tab.targetId,
        };

        const snap = plan.wantsRoleSnapshot
          ? await pw.snapshotRoleViaPlaywright(roleSnapshotArgs)
          : await pw
              .snapshotAiViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                targetId: tab.targetId,
                ...(typeof plan.resolvedMaxChars === "number"
                  ? { maxChars: plan.resolvedMaxChars }
                  : {}),
              })
              .catch(async (error) => {
                // Public-API fallback when Playwright's private _snapshotForAI is missing.
                if (String(error).toLowerCase().includes("_snapshotforai")) {
                  return await pw.snapshotRoleViaPlaywright(roleSnapshotArgs);
                }
                throw error;
              });
        if (plan.labels) {
          const labeled = await pw.screenshotWithLabelsViaPlaywright({
            cdpUrl: profileCtx.profile.cdpUrl,
            refs: "refs" in snap ? snap.refs : {},
            targetId: tab.targetId,
            type: "png",
          });
          const normalized = await normalizeBrowserScreenshot(labeled.buffer, {
            maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
          });
          await ensureMediaDir();
          const saved = await saveMediaBuffer(
            normalized.buffer,
            normalized.contentType ?? "image/png",
            "browser",
            DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
          );
          const imageType = normalized.contentType?.includes("jpeg") ? "jpeg" : "png";
          return res.json({
            format: plan.format,
            imagePath: path.resolve(saved.path),
            imageType,
            labels: true,
            labelsCount: labeled.labels,
            labelsSkipped: labeled.skipped,
            ok: true,
            targetId: tab.targetId,
            url: tab.url,
            ...snap,
          });
        }

        return res.json({
          format: plan.format,
          ok: true,
          targetId: tab.targetId,
          url: tab.url,
          ...snap,
        });
      }

      const snap = shouldUsePlaywrightForAriaSnapshot({
        profile: profileCtx.profile,
        wsUrl: tab.wsUrl,
      })
        ? (() => requirePwAi(res, "aria snapshot").then(async (pw) => {
              if (!pw) {
                return null;
              }
              return await pw.snapshotAriaViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                limit: plan.limit,
                ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                targetId: tab.targetId,
              });
            }))()
        : snapshotAria({ limit: plan.limit, wsUrl: tab.wsUrl ?? "" });

      const resolved = await Promise.resolve(snap);
      if (!resolved) {
        return;
      }
      return res.json({
        format: plan.format,
        ok: true,
        targetId: tab.targetId,
        url: tab.url,
        ...resolved,
      });
    } catch (error) {
      handleRouteError(ctx, res, error);
    }
  });
}
