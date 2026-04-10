import { type LookupFn, type SsrFPolicy, fetchWithSsrFGuard } from "../../runtime-api.js";
import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";

export interface UrbitFetchOptions {
  baseUrl: string;
  path: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  auditContext?: string;
  pinDns?: boolean;
}

export async function urbitFetch(params: UrbitFetchOptions) {
  const validated = validateUrbitBaseUrl(params.baseUrl);
  if (!validated.ok) {
    throw new UrbitUrlError(validated.error);
  }

  const url = new URL(params.path, validated.baseUrl).toString();
  return await fetchWithSsrFGuard({
    auditContext: params.auditContext,
    fetchImpl: params.fetchImpl,
    init: params.init,
    lookupFn: params.lookupFn,
    maxRedirects: params.maxRedirects,
    pinDns: params.pinDns,
    policy: params.ssrfPolicy,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    url,
  });
}
