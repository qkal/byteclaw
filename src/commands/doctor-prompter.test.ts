import { afterEach, describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

const confirmMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@clack/prompts", () => ({
  confirm: (options: unknown) => confirmMock(options),
  select: (options: unknown) => selectMock(options),
}));

function setNonInteractiveTerminal() {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
}

function createRepairPrompter(params?: { force?: boolean }) {
  setNonInteractiveTerminal();
  return createDoctorPrompter({
    options: {
      nonInteractive: true,
      repair: true,
      ...(params?.force ? { force: true } : {}),
    },
    runtime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    },
  });
}

describe("createDoctorPrompter", () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;

  afterEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTTY,
    });
    if (originalUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = originalUpdateInProgress;
    }
  });

  it("auto-accepts repairs in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirm({
        initialValue: false,
        message: "Apply general repair?",
      }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmAutoFix({
        initialValue: false,
        message: "Repair gateway service config?",
      }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmRuntimeRepair({
        initialValue: false,
        message: "Repair launch agent bootstrap?",
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("requires --force for aggressive repairs in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirmAggressiveAutoFix({
        initialValue: true,
        message: "Overwrite gateway service config?",
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("keeps skip-in-non-interactive prompts disabled during update-mode repairs", async () => {
    process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    const prompter = createRepairPrompter();

    await expect(
      prompter.confirmAutoFix({
        initialValue: false,
        message: "Repair gateway service config?",
      }),
    ).resolves.toBe(true);
    await expect(
      prompter.confirmRuntimeRepair({
        initialValue: true,
        message: "Restart gateway service now?",
      }),
    ).resolves.toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("auto-accepts aggressive repairs only with --force in non-interactive fix mode", async () => {
    const prompter = createRepairPrompter({ force: true });

    await expect(
      prompter.confirmAggressiveAutoFix({
        initialValue: false,
        message: "Overwrite gateway service config?",
      }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
