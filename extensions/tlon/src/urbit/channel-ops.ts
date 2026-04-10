import type { LookupFn, SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { UrbitHttpError } from "./errors.js";
import { urbitFetch } from "./fetch.js";

export interface UrbitChannelDeps {
  baseUrl: string;
  cookie: string;
  ship: string;
  channelId: string;
  ssrfPolicy?: SsrFPolicy;
  lookupFn?: LookupFn;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

async function putUrbitChannel(
  deps: UrbitChannelDeps,
  params: { body: unknown; auditContext: string },
) {
  return await urbitFetch({
    auditContext: params.auditContext,
    baseUrl: deps.baseUrl,
    fetchImpl: deps.fetchImpl,
    init: {
      body: JSON.stringify(params.body),
      headers: {
        "Content-Type": "application/json",
        Cookie: deps.cookie,
      },
      method: "PUT",
    },
    lookupFn: deps.lookupFn,
    path: `/~/channel/${deps.channelId}`,
    ssrfPolicy: deps.ssrfPolicy,
    timeoutMs: 30_000,
  });
}

export async function pokeUrbitChannel(
  deps: UrbitChannelDeps,
  params: { app: string; mark: string; json: unknown; auditContext: string },
): Promise<number> {
  const pokeId = Date.now();
  const pokeData = {
    action: "poke",
    app: params.app,
    id: pokeId,
    json: params.json,
    mark: params.mark,
    ship: deps.ship,
  };

  const { response, release } = await putUrbitChannel(deps, {
    auditContext: params.auditContext,
    body: [pokeData],
  });

  try {
    if (!response.ok && response.status !== 204) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Poke failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`);
    }
    return pokeId;
  } finally {
    await release();
  }
}

export async function scryUrbitPath(
  deps: Pick<UrbitChannelDeps, "baseUrl" | "cookie" | "ssrfPolicy" | "lookupFn" | "fetchImpl">,
  params: { path: string; auditContext: string },
): Promise<unknown> {
  const scryPath = `/~/scry${params.path}`;
  const { response, release } = await urbitFetch({
    auditContext: params.auditContext,
    baseUrl: deps.baseUrl,
    fetchImpl: deps.fetchImpl,
    init: {
      headers: { Cookie: deps.cookie },
      method: "GET",
    },
    lookupFn: deps.lookupFn,
    path: scryPath,
    ssrfPolicy: deps.ssrfPolicy,
    timeoutMs: 30_000,
  });

  try {
    if (!response.ok) {
      throw new Error(`Scry failed: ${response.status} for path ${params.path}`);
    }
    return await response.json();
  } finally {
    await release();
  }
}

export async function createUrbitChannel(
  deps: UrbitChannelDeps,
  params: { body: unknown; auditContext: string },
): Promise<void> {
  const { response, release } = await putUrbitChannel(deps, params);

  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel creation", status: response.status });
    }
  } finally {
    await release();
  }
}

export async function wakeUrbitChannel(deps: UrbitChannelDeps): Promise<void> {
  const { response, release } = await putUrbitChannel(deps, {
    auditContext: "tlon-urbit-channel-wake",
    body: [
      {
        action: "poke",
        app: "hood",
        id: Date.now(),
        json: "Opening API channel",
        mark: "helm-hi",
        ship: deps.ship,
      },
    ],
  });

  try {
    if (!response.ok && response.status !== 204) {
      throw new UrbitHttpError({ operation: "Channel activation", status: response.status });
    }
  } finally {
    await release();
  }
}

export async function ensureUrbitChannelOpen(
  deps: UrbitChannelDeps,
  params: { createBody: unknown; createAuditContext: string },
): Promise<void> {
  await createUrbitChannel(deps, {
    auditContext: params.createAuditContext,
    body: params.createBody,
  });
  await wakeUrbitChannel(deps);
}
