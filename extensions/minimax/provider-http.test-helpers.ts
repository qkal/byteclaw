import type { resolveProviderHttpRequestConfig } from "openclaw/plugin-sdk/provider-http";
import { afterEach, vi } from "vitest";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];

const minimaxProviderHttpMocks = vi.hoisted(() => ({
  assertOkOrThrowHttpErrorMock: vi.fn(async () => {}),
  fetchWithTimeoutMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    allowPrivateNetwork: false,
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    dispatcherPolicy: undefined,
    headers: new Headers(params.defaultHeaders),
  })),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: minimaxProviderHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock,
  fetchWithTimeout: minimaxProviderHttpMocks.fetchWithTimeoutMock,
  postJsonRequest: minimaxProviderHttpMocks.postJsonRequestMock,
  resolveProviderHttpRequestConfig: minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock,
}));

export function getMinimaxProviderHttpMocks() {
  return minimaxProviderHttpMocks;
}

export function installMinimaxProviderHttpMockCleanup(): void {
  afterEach(() => {
    minimaxProviderHttpMocks.resolveApiKeyForProviderMock.mockClear();
    minimaxProviderHttpMocks.postJsonRequestMock.mockReset();
    minimaxProviderHttpMocks.fetchWithTimeoutMock.mockReset();
    minimaxProviderHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    minimaxProviderHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}

export function loadMinimaxMusicGenerationProviderModule() {
  return import("./music-generation-provider.js");
}

export function loadMinimaxVideoGenerationProviderModule() {
  return import("./video-generation-provider.js");
}
