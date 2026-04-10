import type { Mock } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import {
  normalizeBlueBubblesAccountsMap,
  normalizeBlueBubblesPrivateNetworkAliases,
  resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig,
  resolveBlueBubblesPrivateNetworkConfigValue as resolveBlueBubblesPrivateNetworkConfigValueFromConfig,
} from "./accounts-normalization.js";
import { _setFetchGuardForTesting } from "./types.js";

export const BLUE_BUBBLES_PRIVATE_API_STATUS = {
  disabled: false,
  enabled: true,
  unknown: null,
} as const;

interface BlueBubblesPrivateApiStatusMock {
  mockReturnValue: (value: boolean | null) => unknown;
  mockReturnValueOnce: (value: boolean | null) => unknown;
}

export function mockBlueBubblesPrivateApiStatus(
  mock: Pick<BlueBubblesPrivateApiStatusMock, "mockReturnValue">,
  value: boolean | null,
) {
  mock.mockReturnValue(value);
}

export function mockBlueBubblesPrivateApiStatusOnce(
  mock: Pick<BlueBubblesPrivateApiStatusMock, "mockReturnValueOnce">,
  value: boolean | null,
) {
  mock.mockReturnValueOnce(value);
}

export function resolveBlueBubblesAccountFromConfig(params: {
  cfg?: { channels?: { bluebubbles?: Record<string, unknown> } };
  accountId?: string;
}) {
  const baseConfig =
    normalizeBlueBubblesPrivateNetworkAliases(params.cfg?.channels?.bluebubbles ?? {}) ?? {};
  const accounts = normalizeBlueBubblesAccountsMap(
    baseConfig.accounts as Record<string, Record<string, unknown> | undefined> | undefined,
  );
  const accountId = params.accountId ?? "default";
  const accountConfig =
    normalizeBlueBubblesPrivateNetworkAliases(accounts?.[accountId] ?? {}) ?? {};
  const config: Record<string, unknown> = {
    ...baseConfig,
    ...accountConfig,
    network:
      typeof baseConfig.network === "object" &&
      baseConfig.network &&
      !Array.isArray(baseConfig.network) &&
      typeof accountConfig.network === "object" &&
      accountConfig.network &&
      !Array.isArray(accountConfig.network)
        ? {
            ...(baseConfig.network as Record<string, unknown>),
            ...(accountConfig.network as Record<string, unknown>),
          }
        : (accountConfig.network ?? baseConfig.network),
  };
  return {
    accountId,
    config,
    configured: Boolean(config.serverUrl && config.password),
    enabled: config.enabled !== false,
  };
}

export function createBlueBubblesAccountsMockModule() {
  return {
    resolveBlueBubblesAccount: vi.fn(resolveBlueBubblesAccountFromConfig),
    resolveBlueBubblesEffectiveAllowPrivateNetwork: vi.fn(
      resolveBlueBubblesEffectiveAllowPrivateNetworkFromConfig,
    ),
    resolveBlueBubblesPrivateNetworkConfigValue: vi.fn(
      resolveBlueBubblesPrivateNetworkConfigValueFromConfig,
    ),
  };
}

interface BlueBubblesProbeMockModule {
  getCachedBlueBubblesPrivateApiStatus: Mock<() => boolean | null>;
  isBlueBubblesPrivateApiStatusEnabled: Mock<(status: boolean | null) => boolean>;
}

export function createBlueBubblesProbeMockModule(): BlueBubblesProbeMockModule {
  return {
    getCachedBlueBubblesPrivateApiStatus: vi
      .fn()
      .mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown),
    isBlueBubblesPrivateApiStatusEnabled: vi.fn((status: boolean | null) => status === true),
  };
}

export function installBlueBubblesFetchTestHooks(params: {
  mockFetch: ReturnType<typeof vi.fn>;
  privateApiStatusMock: {
    mockReset?: () => unknown;
    mockClear?: () => unknown;
    mockReturnValue: (value: boolean | null) => unknown;
  };
}) {
  const setFetchGuardPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();
  beforeEach(() => {
    vi.stubGlobal("fetch", params.mockFetch);
    // Replace the SSRF guard with a passthrough that delegates to the mocked global.fetch,
    // Wrapping the result in a real Response so callers can call .arrayBuffer() on it.
    setFetchGuardPassthrough();
    params.mockFetch.mockReset();
    params.privateApiStatusMock.mockReset?.();
    params.privateApiStatusMock.mockClear?.();
    params.privateApiStatusMock.mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown);
  });

  afterEach(() => {
    _setFetchGuardForTesting(null);
    vi.unstubAllGlobals();
  });
}

export function createBlueBubblesFetchGuardPassthroughInstaller() {
  return (capturePolicy?: (policy: unknown) => void) => {
    _setFetchGuardForTesting(async (params) => {
      capturePolicy?.(params.policy);
      const raw = await globalThis.fetch(params.url, params.init);
      let body: ArrayBuffer;
      if (typeof raw.arrayBuffer === "function") {
        body = await raw.arrayBuffer();
      } else {
        const text =
          typeof (raw as { text?: () => Promise<string> }).text === "function"
            ? await (raw as { text: () => Promise<string> }).text()
            : typeof (raw as { json?: () => Promise<unknown> }).json === "function"
              ? JSON.stringify(await (raw as { json: () => Promise<unknown> }).json())
              : "";
        body = new TextEncoder().encode(text).buffer;
      }
      return {
        finalUrl: params.url,
        release: async () => {},
        response: new Response(body, {
          headers: (raw as { headers?: HeadersInit }).headers,
          status: (raw as { status?: number }).status ?? 200,
        }),
      };
    });
  };
}
