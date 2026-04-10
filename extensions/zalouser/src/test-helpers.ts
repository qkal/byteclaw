import type { RuntimeEnv } from "../runtime-api.js";
import type { ResolvedZalouserAccount } from "./types.js";

export function createZalouserRuntimeEnv(): RuntimeEnv {
  return {
    error: () => {},
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
    log: () => {},
  };
}

export function createDefaultResolvedZalouserAccount(
  overrides: Partial<ResolvedZalouserAccount> = {},
): ResolvedZalouserAccount {
  return {
    accountId: "default",
    authenticated: true,
    config: {},
    enabled: true,
    name: "test",
    profile: "default",
    ...overrides,
  };
}
