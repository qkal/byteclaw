import { vi } from "vitest";

interface ModelAuthMockModule {
  resolveApiKeyForProvider: (...args: unknown[]) => unknown;
  requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => string;
}

export function createModelAuthMockModule(): ModelAuthMockModule {
  return {
    requireApiKey: (auth: { apiKey?: string; mode?: string }, provider: string) => {
      if (auth?.apiKey) {
        return auth.apiKey;
      }
      throw new Error(`No API key resolved for provider "${provider}" (auth mode: ${auth?.mode}).`);
    },
    resolveApiKeyForProvider: vi.fn() as (...args: unknown[]) => unknown,
  };
}
