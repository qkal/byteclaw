import { describe, expect, it, vi } from "vitest";
import { finalizeDoctorConfigFlow } from "./finalize-config-flow.js";

describe("doctor finalize config flow", () => {
  it("writes the candidate when preview changes are confirmed", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      candidate: { channels: { signal: { enabled: true } } },
      cfg: { channels: {} },
      confirm: async () => true,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      note,
      pendingChanges: true,
      shouldRepair: false,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("emits fix hints when preview changes are declined", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      candidate: { channels: { signal: { enabled: true } } },
      cfg: { channels: {} },
      confirm: async () => false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      note,
      pendingChanges: true,
      shouldRepair: false,
    });

    expect(result).toEqual({
      cfg: { channels: {} },
      shouldWriteConfig: false,
    });
    expect(note).toHaveBeenCalledWith(
      'Run "openclaw doctor --fix" to apply these changes.',
      "Doctor",
    );
  });

  it("writes automatically in repair mode when changes exist", async () => {
    const result = await finalizeDoctorConfigFlow({
      candidate: { channels: { signal: { enabled: false } } },
      cfg: { channels: { signal: { enabled: true } } },
      confirm: async () => true,
      fixHints: [],
      note: vi.fn(),
      pendingChanges: true,
      shouldRepair: true,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
    });
  });
});
