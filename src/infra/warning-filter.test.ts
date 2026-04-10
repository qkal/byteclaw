import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessWarningFilter, shouldIgnoreWarning } from "./warning-filter.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");
const baseEmitWarning = process.emitWarning.bind(process);

function resetWarningFilterInstallState(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  delete globalState[warningFilterKey];
  process.emitWarning = baseEmitWarning;
}

async function flushWarnings(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("warning filter", () => {
  beforeEach(() => {
    resetWarningFilterInstallState();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    resetWarningFilterInstallState();
    vi.restoreAllMocks();
  });

  it("suppresses known deprecation and experimental warning signatures", () => {
    const ignoredWarnings = [
      {
        code: "DEP0040",
        message: "The punycode module is deprecated.",
        name: "DeprecationWarning",
      },
      {
        code: "DEP0060",
        message: "The `util._extend` API is deprecated.",
        name: "DeprecationWarning",
      },
      {
        message: "SQLite is an experimental feature and might change at any time",
        name: "ExperimentalWarning",
      },
    ];

    for (const warning of ignoredWarnings) {
      expect(shouldIgnoreWarning(warning)).toBe(true);
    }
  });

  it("keeps unknown warnings visible", () => {
    const visibleWarnings = [
      {
        code: "DEP9999",
        message: "Totally new warning",
        name: "DeprecationWarning",
      },
      {
        message: "Different experimental warning",
        name: "ExperimentalWarning",
      },
      {
        code: "DEP0040",
        message: "Different deprecated module",
        name: "DeprecationWarning",
      },
    ];

    for (const warning of visibleWarnings) {
      expect(shouldIgnoreWarning(warning)).toBe(false);
    }
  });

  it("installs once and suppresses known warnings at emit time", async () => {
    const seenWarnings: { code?: string; name: string; message: string }[] = [];
    const onWarning = (warning: Error & { code?: string }) => {
      seenWarnings.push({
        code: warning.code,
        message: warning.message,
        name: warning.name,
      });
    };

    process.on("warning", onWarning);
    try {
      installProcessWarningFilter();
      installProcessWarningFilter();
      installProcessWarningFilter();
      const emitWarning = (...args: unknown[]) =>
        (process.emitWarning as unknown as (...warningArgs: unknown[]) => void)(...args);

      emitWarning(
        "The `util._extend` API is deprecated. Please use Object.assign() instead.",
        "DeprecationWarning",
        "DEP0060",
      );
      emitWarning("The `util._extend` API is deprecated. Please use Object.assign() instead.", {
        code: "DEP0060",
        type: "DeprecationWarning",
      });
      emitWarning(
        Object.assign(new Error("The punycode module is deprecated."), {
          code: "DEP0040",
          name: "DeprecationWarning",
        }),
      );
      emitWarning(new Error("SQLite is an experimental feature and might change at any time"), {
        type: "ExperimentalWarning",
      });
      await flushWarnings();
      expect(seenWarnings.find((warning) => warning.code === "DEP0060")).toBeUndefined();
      expect(seenWarnings.find((warning) => warning.code === "DEP0040")).toBeUndefined();
      expect(
        seenWarnings.find((warning) =>
          warning.message.includes("SQLite is an experimental feature"),
        ),
      ).toBeUndefined();

      emitWarning("Visible warning", { code: "OPENCLAW_TEST_WARNING", type: "Warning" });
      emitWarning(
        Object.assign(new Error("The punycode module is deprecated."), {
          code: "DEP0040",
          name: "DeprecationWarning",
        }),
        { code: "OPENCLAW_VISIBLE_OVERRIDE", type: "Warning" },
      );
      await flushWarnings();
      expect(
        seenWarnings.find((warning) => warning.code === "OPENCLAW_TEST_WARNING"),
      ).toBeDefined();
      expect(
        seenWarnings.find((warning) => warning.message === "The punycode module is deprecated."),
      ).toBeDefined();
    } finally {
      process.off("warning", onWarning);
    }
  });
});
