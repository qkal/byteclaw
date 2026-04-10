import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
} from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import type { BrowserActRequest, BrowserFormField } from "./client-actions.types.js";
import { fetchBrowserJson } from "./client-fetch.js";

export type { BrowserActRequest, BrowserFormField } from "./client-actions.types.js";

export interface BrowserActResponse {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
  results?: { ok: boolean; error?: string }[];
}

export interface BrowserDownloadPayload {
  url: string;
  suggestedFilename: string;
  path: string;
}

interface BrowserDownloadResult {
  ok: true;
  targetId: string;
  download: BrowserDownloadPayload;
}

async function postDownloadRequest(
  baseUrl: string | undefined,
  route: "/wait/download" | "/download",
  body: Record<string, unknown>,
  profile?: string,
): Promise<BrowserDownloadResult> {
  const q = buildProfileQuery(profile);
  return await fetchBrowserJson<BrowserDownloadResult>(withBaseUrl(baseUrl, `${route}${q}`), {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserNavigate(
  baseUrl: string | undefined,
  opts: {
    url: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTabResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTabResult>(withBaseUrl(baseUrl, `/navigate${q}`), {
    body: JSON.stringify({ targetId: opts.targetId, url: opts.url }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserArmDialog(
  baseUrl: string | undefined,
  opts: {
    accept: boolean;
    promptText?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/dialog${q}`), {
    body: JSON.stringify({
      accept: opts.accept,
      promptText: opts.promptText,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserArmFileChooser(
  baseUrl: string | undefined,
  opts: {
    paths: string[];
    ref?: string;
    inputRef?: string;
    element?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/file-chooser${q}`), {
    body: JSON.stringify({
      element: opts.element,
      inputRef: opts.inputRef,
      paths: opts.paths,
      ref: opts.ref,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserWaitForDownload(
  baseUrl: string | undefined,
  opts: {
    path?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadResult> {
  return await postDownloadRequest(
    baseUrl,
    "/wait/download",
    {
      path: opts.path,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    },
    opts.profile,
  );
}

export async function browserDownload(
  baseUrl: string | undefined,
  opts: {
    ref: string;
    path: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadResult> {
  return await postDownloadRequest(
    baseUrl,
    "/download",
    {
      path: opts.path,
      ref: opts.ref,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    },
    opts.profile,
  );
}

export async function browserAct(
  baseUrl: string | undefined,
  req: BrowserActRequest,
  opts?: { profile?: string },
): Promise<BrowserActResponse> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserActResponse>(withBaseUrl(baseUrl, `/act${q}`), {
    body: JSON.stringify(req),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

export async function browserScreenshotAction(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    profile?: string;
  },
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/screenshot${q}`), {
    body: JSON.stringify({
      element: opts.element,
      fullPage: opts.fullPage,
      ref: opts.ref,
      targetId: opts.targetId,
      type: opts.type,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}
