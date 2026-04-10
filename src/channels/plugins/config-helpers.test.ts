import { describe, expect, it } from "vitest";
import { clearAccountEntryFields } from "./config-helpers.js";

describe("clearAccountEntryFields", () => {
  it("clears configured values and removes empty account entries", () => {
    const result = clearAccountEntryFields({
      accountId: "default",
      accounts: {
        default: {
          botToken: "abc123",
        },
      },
      fields: ["botToken"],
    });

    expect(result).toEqual({
      changed: true,
      cleared: true,
      nextAccounts: undefined,
    });
  });

  it("treats empty string values as not configured by default", () => {
    const result = clearAccountEntryFields({
      accountId: "default",
      accounts: {
        default: {
          botToken: "   ",
        },
      },
      fields: ["botToken"],
    });

    expect(result).toEqual({
      changed: true,
      cleared: false,
      nextAccounts: undefined,
    });
  });

  it("can mark cleared when fields are present even if values are empty", () => {
    const result = clearAccountEntryFields({
      accountId: "default",
      accounts: {
        default: {
          tokenFile: "",
        },
      },
      fields: ["tokenFile"],
      markClearedOnFieldPresence: true,
    });

    expect(result).toEqual({
      changed: true,
      cleared: true,
      nextAccounts: undefined,
    });
  });

  it("keeps other account fields intact", () => {
    const result = clearAccountEntryFields({
      accountId: "default",
      accounts: {
        backup: {
          botToken: "keep",
        },
        default: {
          botToken: "abc123",
          name: "Primary",
        },
      },
      fields: ["botToken"],
    });

    expect(result).toEqual({
      changed: true,
      cleared: true,
      nextAccounts: {
        backup: {
          botToken: "keep",
        },
        default: {
          name: "Primary",
        },
      },
    });
  });

  it("returns unchanged when account entry is missing", () => {
    const result = clearAccountEntryFields({
      accountId: "other",
      accounts: {
        default: {
          botToken: "abc123",
        },
      },
      fields: ["botToken"],
    });

    expect(result).toEqual({
      changed: false,
      cleared: false,
      nextAccounts: {
        default: {
          botToken: "abc123",
        },
      },
    });
  });
});
