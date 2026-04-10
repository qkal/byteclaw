import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { RunningChrome } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import type { BrowserServerState } from "./server-context.js";

export function makeBrowserProfile(
  overrides: Partial<ResolvedBrowserProfile> = {},
): ResolvedBrowserProfile {
  return {
    attachOnly: false,
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    cdpPort: 18_800,
    cdpUrl: "http://127.0.0.1:18800",
    color: "#FF4500",
    driver: "openclaw",
    name: "openclaw",
    ...overrides,
  };
}

export function makeBrowserServerState(params?: {
  profile?: ResolvedBrowserProfile;
  resolvedOverrides?: Partial<BrowserServerState["resolved"]>;
}): BrowserServerState {
  const profile = params?.profile ?? makeBrowserProfile();
  return {
    port: 0,
    profiles: new Map(),
    resolved: {
      attachOnly: false,
      cdpHost: profile.cdpHost,
      cdpIsLoopback: profile.cdpIsLoopback,
      cdpPortRangeEnd: 18_810,
      cdpPortRangeStart: 18_800,
      cdpProtocol: "http",
      color: profile.color,
      controlPort: 18_791,
      defaultProfile: profile.name,
      enabled: true,
      evaluateEnabled: false,
      extraArgs: [],
      headless: true,
      noSandbox: false,
      profiles: {
        [profile.name]: profile,
      },
      remoteCdpHandshakeTimeoutMs: 3000,
      remoteCdpTimeoutMs: 1500,
      ssrfPolicy: { allowPrivateNetwork: true },
      ...params?.resolvedOverrides,
    },
    server: null as any,
  };
}

export function mockLaunchedChrome(
  launchOpenClawChrome: { mockResolvedValue: (value: RunningChrome) => unknown },
  pid: number,
) {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  launchOpenClawChrome.mockResolvedValue({
    cdpPort: 18_800,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    pid,
    proc,
    startedAt: Date.now(),
    userDataDir: "/tmp/openclaw-test",
  });
}
