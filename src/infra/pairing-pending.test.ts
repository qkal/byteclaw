import { describe, expect, it, vi } from "vitest";
import { rejectPendingPairingRequest } from "./pairing-pending.js";

describe("rejectPendingPairingRequest", () => {
  it("returns null and skips persistence when the request is missing", async () => {
    const persistState = vi.fn();

    await expect(
      rejectPendingPairingRequest({
        getId: (pending: { id: string }) => pending.id,
        idKey: "deviceId",
        loadState: async () => ({ pendingById: {} }),
        persistState,
        requestId: "missing",
      }),
    ).resolves.toBeNull();

    expect(persistState).not.toHaveBeenCalled();
  });

  it("removes the request, persists, and returns the dynamic id key", async () => {
    const state: { pendingById: Record<string, { accountId: string }> } = {
      pendingById: {
        keep: { accountId: "keep-me" },
        reject: { accountId: "acct-42" },
      },
    };
    const persistState = vi.fn(async () => undefined);

    await expect(
      rejectPendingPairingRequest({
        getId: (pending: { accountId: string }) => pending.accountId,
        idKey: "accountId",
        loadState: async () => state,
        persistState,
        requestId: "reject",
      }),
    ).resolves.toEqual({
      accountId: "acct-42",
      requestId: "reject",
    });

    expect(state.pendingById).toEqual({
      keep: { accountId: "keep-me" },
    });
    expect(persistState).toHaveBeenCalledWith(state);
  });
});
