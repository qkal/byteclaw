import type { BrowserActionPathResult, BrowserActionTargetOk } from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";

function buildQuerySuffix(params: [string, string | boolean | undefined][]): string {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (typeof value === "boolean") {
      query.set(key, String(value));
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export async function browserConsoleMessages(
  baseUrl: string | undefined,
  opts: { level?: string; targetId?: string; profile?: string } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string }> {
  const suffix = buildQuerySuffix([
    ["level", opts.level],
    ["targetId", opts.targetId],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
  }>(withBaseUrl(baseUrl, `/console${suffix}`), { timeoutMs: 20_000 });
}

export async function browserPdfSave(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/pdf${q}`), {
    body: JSON.stringify({ targetId: opts.targetId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserPageErrors(
  baseUrl: string | undefined,
  opts: { targetId?: string; clear?: boolean; profile?: string } = {},
): Promise<{ ok: true; targetId: string; errors: BrowserPageError[] }> {
  const suffix = buildQuerySuffix([
    ["targetId", opts.targetId],
    ["clear", typeof opts.clear === "boolean" ? opts.clear : undefined],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    errors: BrowserPageError[];
  }>(withBaseUrl(baseUrl, `/errors${suffix}`), { timeoutMs: 20_000 });
}

export async function browserRequests(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    filter?: string;
    clear?: boolean;
    profile?: string;
  } = {},
): Promise<{ ok: true; targetId: string; requests: BrowserNetworkRequest[] }> {
  const suffix = buildQuerySuffix([
    ["targetId", opts.targetId],
    ["filter", opts.filter],
    ["clear", typeof opts.clear === "boolean" ? opts.clear : undefined],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    requests: BrowserNetworkRequest[];
  }>(withBaseUrl(baseUrl, `/requests${suffix}`), { timeoutMs: 20_000 });
}

export async function browserTraceStart(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    screenshots?: boolean;
    snapshots?: boolean;
    sources?: boolean;
    profile?: string;
  } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/trace/start${q}`), {
    body: JSON.stringify({
      screenshots: opts.screenshots,
      snapshots: opts.snapshots,
      sources: opts.sources,
      targetId: opts.targetId,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserTraceStop(
  baseUrl: string | undefined,
  opts: { targetId?: string; path?: string; profile?: string } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/trace/stop${q}`), {
    body: JSON.stringify({ path: opts.path, targetId: opts.targetId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserHighlight(
  baseUrl: string | undefined,
  opts: { ref: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(withBaseUrl(baseUrl, `/highlight${q}`), {
    body: JSON.stringify({ ref: opts.ref, targetId: opts.targetId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserResponseBody(
  baseUrl: string | undefined,
  opts: {
    url: string;
    targetId?: string;
    timeoutMs?: number;
    maxChars?: number;
    profile?: string;
  },
): Promise<{
  ok: true;
  targetId: string;
  response: {
    url: string;
    status?: number;
    headers?: Record<string, string>;
    body: string;
    truncated?: boolean;
  };
}> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    response: {
      url: string;
      status?: number;
      headers?: Record<string, string>;
      body: string;
      truncated?: boolean;
    };
  }>(withBaseUrl(baseUrl, `/response/body${q}`), {
    body: JSON.stringify({
      maxChars: opts.maxChars,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
      url: opts.url,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}
