import { afterEach, describe, expect, it, vi } from "vitest";

const clearActiveProgressLine = vi.hoisted(() => vi.fn());

vi.mock("./progress-line.js", () => ({
  clearActiveProgressLine,
}));

import { restoreTerminalState } from "./restore.js";

function configureTerminalIO(params: {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  isPaused?: () => boolean;
}) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: params.stdinIsTTY });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: params.stdoutIsTTY });
  (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = params.setRawMode;
  (process.stdin as { resume?: () => void }).resume = params.resume;
  (process.stdin as { isPaused?: () => boolean }).isPaused = params.isPaused;
}

function setupPausedTTYStdin() {
  const setRawMode = vi.fn();
  const resume = vi.fn();
  const isPaused = vi.fn(() => true);
  configureTerminalIO({
    isPaused,
    resume,
    setRawMode,
    stdinIsTTY: true,
    stdoutIsTTY: false,
  });
  return { resume, setRawMode };
}

describe("restoreTerminalState", () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalSetRawMode = (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode;
  const originalResume = (process.stdin as { resume?: () => void }).resume;
  const originalIsPaused = (process.stdin as { isPaused?: () => boolean }).isPaused;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTTY,
    });
    (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = originalSetRawMode;
    (process.stdin as { resume?: () => void }).resume = originalResume;
    (process.stdin as { isPaused?: () => boolean }).isPaused = originalIsPaused;
  });

  it("does not resume paused stdin by default", () => {
    const { setRawMode, resume } = setupPausedTTYStdin();

    restoreTerminalState("test");

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes paused stdin when resumeStdin is true", () => {
    const { setRawMode, resume } = setupPausedTTYStdin();

    restoreTerminalState("test", { resumeStdinIfPaused: true });

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not touch stdin when stdin is not a TTY", () => {
    const setRawMode = vi.fn();
    const resume = vi.fn();
    const isPaused = vi.fn(() => true);

    configureTerminalIO({
      isPaused,
      resume,
      setRawMode,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    restoreTerminalState("test", { resumeStdinIfPaused: true });

    expect(setRawMode).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("writes kitty and modifyOtherKeys reset sequences to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    configureTerminalIO({
      stdinIsTTY: false,
      stdoutIsTTY: true,
    });

    restoreTerminalState("test");

    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("\x1b[<u");
    expect(output).toContain("\x1b[>4;0m");
  });
});
