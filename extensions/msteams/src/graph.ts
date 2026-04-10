import type { MSTeamsConfig } from "../runtime-api.js";
import { GRAPH_ROOT } from "./attachments/shared.js";

const GRAPH_BETA = "https://graph.microsoft.com/beta";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { readAccessToken } from "./token-response.js";
import { resolveMSTeamsCredentials } from "./token.js";
import { buildUserAgent } from "./user-agent.js";

export interface GraphUser {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
}

export interface GraphGroup {
  id?: string;
  displayName?: string;
}

export interface GraphChannel {
  id?: string;
  displayName?: string;
}

export interface GraphResponse<T> {
  value?: T[];
}

export function normalizeQuery(value?: string | null): string {
  return value?.trim() ?? "";
}

export function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

async function requestGraph(params: {
  token: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  root?: string;
  headers?: Record<string, string>;
  body?: unknown;
  errorPrefix?: string;
}): Promise<Response> {
  const hasBody = params.body !== undefined;
  const res = await fetch(`${params.root ?? GRAPH_ROOT}${params.path}`, {
    body: hasBody ? JSON.stringify(params.body) : undefined,
    headers: {
      Authorization: `Bearer ${params.token}`,
      "User-Agent": buildUserAgent(),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...params.headers,
    },
    method: params.method,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `${params.errorPrefix ?? "Graph"} ${params.path} failed (${res.status}): ${text || "unknown error"}`,
    );
  }
  return res;
}

async function readOptionalGraphJson<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function fetchGraphJson<T>(params: {
  token: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await requestGraph({
    headers: params.headers,
    path: params.path,
    token: params.token,
  });
  return (await res.json()) as T;
}

export async function resolveGraphToken(cfg: unknown): Promise<string> {
  const creds = resolveMSTeamsCredentials(
    (cfg as { channels?: { msteams?: unknown } })?.channels?.msteams as MSTeamsConfig | undefined,
  );
  if (!creds) {
    throw new Error("MS Teams credentials missing");
  }
  const { app } = await loadMSTeamsSdkWithAuth(creds);
  const tokenProvider = createMSTeamsTokenProvider(app);
  const graphTokenValue = await tokenProvider.getAccessToken("https://graph.microsoft.com");
  const accessToken = readAccessToken(graphTokenValue);
  if (!accessToken) {
    throw new Error("MS Teams graph token unavailable");
  }
  return accessToken;
}

export async function listTeamsByName(token: string, query: string): Promise<GraphGroup[]> {
  const escaped = escapeOData(query);
  const filter = `resourceProvisioningOptions/Any(x:x eq 'Team') and startsWith(displayName,'${escaped}')`;
  const path = `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphGroup>>({ path, token });
  return res.value ?? [];
}

export async function postGraphJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    body: params.body,
    errorPrefix: "Graph POST",
    method: "POST",
    path: params.path,
    token: params.token,
  });
  return readOptionalGraphJson<T>(res);
}

export async function postGraphBetaJson<T>(params: {
  token: string;
  path: string;
  body?: unknown;
}): Promise<T> {
  const res = await requestGraph({
    body: params.body,
    errorPrefix: "Graph beta POST",
    method: "POST",
    path: params.path,
    root: GRAPH_BETA,
    token: params.token,
  });
  return readOptionalGraphJson<T>(res);
}

export async function deleteGraphRequest(params: { token: string; path: string }): Promise<void> {
  await requestGraph({
    errorPrefix: "Graph DELETE",
    method: "DELETE",
    path: params.path,
    token: params.token,
  });
}

export async function listChannelsForTeam(token: string, teamId: string): Promise<GraphChannel[]> {
  const path = `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`;
  const res = await fetchGraphJson<GraphResponse<GraphChannel>>({ path, token });
  return res.value ?? [];
}
