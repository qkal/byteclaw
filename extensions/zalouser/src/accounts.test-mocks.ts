import { vi } from "vitest";
import { createDefaultResolvedZalouserAccount } from "./test-helpers.js";

vi.mock("./accounts.js", () => ({
  checkZcaAuthenticated: async () => false,
  getZcaUserInfo: async () => null,
  listEnabledZalouserAccounts: async () => [createDefaultResolvedZalouserAccount()],
  listZalouserAccountIds: () => ["default"],
  resolveDefaultZalouserAccountId: () => "default",
  resolveZalouserAccount: async () => createDefaultResolvedZalouserAccount(),
  resolveZalouserAccountSync: () => createDefaultResolvedZalouserAccount(),
}));
