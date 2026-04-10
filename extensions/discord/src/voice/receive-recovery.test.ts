import { describe, expect, it, vi } from "vitest";
import {
  analyzeVoiceReceiveError,
  createVoiceReceiveRecoveryState,
  enableDaveReceivePassthrough,
  noteVoiceDecryptFailure,
} from "./receive-recovery.js";

describe("voice receive recovery", () => {
  it("treats passthrough-disabled decrypt errors as decrypt failures", () => {
    expect(
      analyzeVoiceReceiveError(
        new Error("Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)"),
      ),
    ).toMatchObject({
      countsAsDecryptFailure: true,
      shouldAttemptPassthrough: true,
    });
  });

  it("gates recovery after repeated decrypt failures in the same window", () => {
    const state = createVoiceReceiveRecoveryState();

    expect(noteVoiceDecryptFailure(state, 1000)).toEqual({
      firstFailure: true,
      shouldRecover: false,
    });
    expect(noteVoiceDecryptFailure(state, 2000)).toEqual({
      firstFailure: false,
      shouldRecover: false,
    });
    expect(noteVoiceDecryptFailure(state, 3000)).toEqual({
      firstFailure: false,
      shouldRecover: true,
    });
  });

  it("enables passthrough only for ready DAVE sessions", () => {
    const setPassthroughMode = vi.fn();
    const onVerbose = vi.fn();
    const onWarn = vi.fn();

    expect(
      enableDaveReceivePassthrough({
        expirySeconds: 15,
        onVerbose,
        onWarn,
        reason: "test",
        sdk: {
          NetworkingStatusCode: { Ready: "networking-ready", Resuming: "networking-resuming" },
          VoiceConnectionStatus: { Ready: "ready" },
        },
        target: {
          channelId: "c1",
          connection: {
            state: {
              networking: {
                state: {
                  code: "networking-ready",
                  dave: {
                    session: {
                      setPassthroughMode,
                    },
                  },
                },
              },
              status: "ready",
            },
          },
          guildId: "g1",
        },
      }),
    ).toBe(true);

    expect(setPassthroughMode).toHaveBeenCalledWith(true, 15);
    expect(onVerbose).toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });
});
