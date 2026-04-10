import { vi } from "vitest";
import { withFetchPreconnect } from "../../test-support.js";
import type { BrowserServerState } from "./server-context.js";
import { createBrowserRouteContext } from "./server-context.js";

export const originalFetch = globalThis.fetch;

export function makeState(
  profile: "remote" | "openclaw",
): BrowserServerState & { profiles: Map<string, { lastTargetId?: string | null }> } {
  return {
    port: 0,
    profiles: new Map(),
    resolved: {
      attachOnly: false,
      cdpHost: profile === "remote" ? "browserless.example" : "127.0.0.1",
      cdpIsLoopback: profile !== "remote",
      cdpPortRangeEnd: 18_899,
      cdpPortRangeStart: 18_800,
      cdpProtocol: profile === "remote" ? "https" : "http",
      color: "#FF4500",
      controlPort: 18_791,
      defaultProfile: profile,
      enabled: true,
      evaluateEnabled: false,
      extraArgs: [],
      headless: true,
      noSandbox: false,
      profiles: {
        openclaw: { cdpPort: 18_800, color: "#FF4500" },
        remote: {
          cdpPort: 443,
          cdpUrl: "https://browserless.example/chrome?token=abc",
          color: "#00AA00",
        },
      },
      remoteCdpHandshakeTimeoutMs: 3000,
      remoteCdpTimeoutMs: 1500,
      ssrfPolicy: { allowPrivateNetwork: true },
    },
    server: null as unknown as BrowserServerState["server"],
  };
}

export function makeUnexpectedFetchMock() {
  return vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
}

export function createRemoteRouteHarness(fetchMock?: (url: unknown) => Promise<Response>) {
  const activeFetchMock = fetchMock ?? makeUnexpectedFetchMock();
  global.fetch = withFetchPreconnect(activeFetchMock);
  const state = makeState("remote");
  const ctx = createBrowserRouteContext({ getState: () => state });
  return { fetchMock: activeFetchMock, remote: ctx.forProfile("remote"), state };
}

export function createSequentialPageLister<T>(responses: T[]) {
  return async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("no more responses");
    }
    return next;
  };
}

interface JsonListEntry {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: "page";
}

export function createJsonListFetchMock(entries: JsonListEntry[]) {
  return async (url: unknown) => {
    const u = String(url);
    if (!u.includes("/json/list")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return {
      json: async () => entries,
      ok: true,
    } as unknown as Response;
  };
}

function makeManagedTab(id: string, ordinal: number): JsonListEntry {
  return {
    id,
    title: String(ordinal),
    type: "page",
    url: `http://127.0.0.1:300${ordinal}`,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  };
}

export function makeManagedTabsWithNew(params?: { newFirst?: boolean }): JsonListEntry[] {
  const oldTabs = Array.from({ length: 8 }, (_, index) =>
    makeManagedTab(`OLD${index + 1}`, index + 1),
  );
  const newTab = makeManagedTab("NEW", 9);
  return params?.newFirst ? [newTab, ...oldTabs] : [...oldTabs, newTab];
}
