import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type AriaSnapshotNode, type RawAXNode, formatAriaSnapshot } from "./cdp.js";
import { assertBrowserNavigationAllowed, withBrowserNavigationPolicy } from "./navigation-guard.js";
import {
  type RoleRefMap,
  type RoleSnapshotOptions,
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
} from "./pw-role-snapshot.js";
import {
  type WithSnapshotForAI,
  assertPageNavigationCompletedSafely,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  storeRoleRefsForTarget,
} from "./pw-session.js";
import { withPageScopedCdpClient } from "./pw-session.page-cdp.js";

export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  const res = (await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    fn: async (send) => {
      await send("Accessibility.enable").catch(() => {});
      return (await send("Accessibility.getFullAXTree")) as {
        nodes?: RawAXNode[];
      };
    },
    page,
    targetId: opts.targetId,
  })) as {
    nodes?: RawAXNode[];
  };
  const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
  return { nodes: formatAriaSnapshot(nodes, limit) };
}

export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  const maybe = page as unknown as WithSnapshotForAI;
  if (!maybe._snapshotForAI) {
    throw new Error("Playwright _snapshotForAI is not available. Upgrade playwright-core.");
  }

  const result = await maybe._snapshotForAI({
    timeout: Math.max(500, Math.min(60_000, Math.floor(opts.timeoutMs ?? 5000))),
    track: "response",
  });
  let snapshot = String(result?.full ?? "");
  const {maxChars} = opts;
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : undefined;
  let truncated = false;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const built = buildRoleSnapshotFromAiSnapshot(snapshot);
  storeRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    mode: "aria",
    page,
    refs: built.refs,
    targetId: opts.targetId,
  });
  return truncated ? { refs: built.refs, snapshot, truncated } : { refs: built.refs, snapshot };
}

export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{
  snapshot: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  if (opts.refsMode === "aria") {
    if (normalizeOptionalString(opts.selector) || normalizeOptionalString(opts.frameSelector)) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    const maybe = page as unknown as WithSnapshotForAI;
    if (!maybe._snapshotForAI) {
      throw new Error("refs=aria requires Playwright _snapshotForAI support.");
    }
    const result = await maybe._snapshotForAI({
      timeout: 5000,
      track: "response",
    });
    const built = buildRoleSnapshotFromAiSnapshot(String(result?.full ?? ""), opts.options);
    storeRoleRefsForTarget({
      cdpUrl: opts.cdpUrl,
      mode: "aria",
      page,
      refs: built.refs,
      targetId: opts.targetId,
    });
    return {
      refs: built.refs,
      snapshot: built.snapshot,
      stats: getRoleSnapshotStats(built.snapshot, built.refs),
    };
  }

  const frameSelector = normalizeOptionalString(opts.frameSelector) ?? "";
  const selector = normalizeOptionalString(opts.selector) ?? "";
  const locator = frameSelector
    ? (selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root"))
    : (selector
      ? page.locator(selector)
      : page.locator(":root"));

  const ariaSnapshot = await locator.ariaSnapshot();
  const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ""), opts.options);
  storeRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    frameSelector: frameSelector || undefined,
    mode: "role",
    page,
    refs: built.refs,
    targetId: opts.targetId,
  });
  return {
    refs: built.refs,
    snapshot: built.snapshot,
    stats: getRoleSnapshotStats(built.snapshot, built.refs),
  };
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ url: string }> {
  const isRetryableNavigateError = (err: unknown): boolean => {
    const msg =
      typeof err === "string"
        ? err.toLowerCase()
        : (err instanceof Error
          ? err.message.toLowerCase()
          : "");
    return (
      msg.includes("frame has been detached") ||
      msg.includes("target page, context or browser has been closed")
    );
  };

  const url = normalizeOptionalString(opts.url) ?? "";
  if (!url) {
    throw new Error("url is required");
  }
  await assertBrowserNavigationAllowed({
    url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  const timeout = Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 20_000));
  let page = await getPageForTargetId(opts);
  ensurePageState(page);
  const navigate = async () =>
    await gotoPageWithNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
      timeoutMs: timeout,
      url,
    });
  let response;
  try {
    response = await navigate();
  } catch (error) {
    if (!isRetryableNavigateError(error)) {
      throw error;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      reason: "retry navigate after detached frame",
      targetId: opts.targetId,
    }).catch(() => {});
    page = await getPageForTargetId(opts);
    ensurePageState(page);
    response = await navigate();
  }
  await assertPageNavigationCompletedSafely({
    cdpUrl: opts.cdpUrl,
    page,
    response,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
  const finalUrl = page.url();
  return { url: finalUrl };
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.setViewportSize({
    height: Math.max(1, Math.floor(opts.height)),
    width: Math.max(1, Math.floor(opts.width)),
  });
}

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}
