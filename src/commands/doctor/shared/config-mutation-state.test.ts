import { describe, expect, it } from "vitest";
import { applyDoctorConfigMutation } from "./config-mutation-state.js";

describe("doctor config mutation state", () => {
  it("updates candidate and fix hints in preview mode", () => {
    const next = applyDoctorConfigMutation({
      fixHint: 'Run "openclaw doctor --fix" to apply these changes.',
      mutation: {
        changes: ["enabled signal"],
        config: { channels: { signal: { enabled: true } } },
      },
      shouldRepair: false,
      state: {
        candidate: { channels: {} },
        cfg: { channels: {} },
        fixHints: [],
        pendingChanges: false,
      },
    });

    expect(next).toEqual({
      candidate: { channels: { signal: { enabled: true } } },
      cfg: { channels: {} },
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      pendingChanges: true,
    });
  });

  it("updates cfg directly in repair mode", () => {
    const next = applyDoctorConfigMutation({
      fixHint: 'Run "openclaw doctor --fix" to apply these changes.',
      mutation: {
        changes: ["enabled signal"],
        config: { channels: { signal: { enabled: true } } },
      },
      shouldRepair: true,
      state: {
        candidate: { channels: {} },
        cfg: { channels: {} },
        fixHints: [],
        pendingChanges: false,
      },
    });

    expect(next).toEqual({
      candidate: { channels: { signal: { enabled: true } } },
      cfg: { channels: { signal: { enabled: true } } },
      fixHints: [],
      pendingChanges: true,
    });
  });

  it("stays unchanged when there are no changes", () => {
    const state = {
      candidate: { channels: {} },
      cfg: { channels: {} },
      fixHints: [],
      pendingChanges: false,
    };

    expect(
      applyDoctorConfigMutation({
        mutation: { changes: [], config: { channels: { signal: { enabled: true } } } },
        shouldRepair: false,
        state,
      }),
    ).toBe(state);
  });
});
