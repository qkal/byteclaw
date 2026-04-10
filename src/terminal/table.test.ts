import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "./ansi.js";
import { wrapNoteMessage } from "./note.js";
import { renderTable } from "./table.js";

describe("renderTable", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("prefers shrinking flex columns to avoid wrapping non-flex labels", () => {
    const out = renderTable({
      columns: [
        { header: "Item", key: "Item", minWidth: 10 },
        { flex: true, header: "Value", key: "Value", minWidth: 24 },
      ],
      rows: [{ Item: "Dashboard", Value: "http://127.0.0.1:18789/" }],
      width: 40,
    });

    expect(out).toContain("Dashboard");
    expect(out).toMatch(/│ Dashboard\s+│/);
  });

  it("expands flex columns to fill available width", () => {
    const width = 60;
    const out = renderTable({
      columns: [
        { header: "Item", key: "Item", minWidth: 10 },
        { flex: true, header: "Value", key: "Value", minWidth: 24 },
      ],
      rows: [{ Item: "OS", Value: "macos 26.2 (arm64)" }],
      width,
    });

    const firstLine = out.trimEnd().split("\n")[0] ?? "";
    expect(visibleWidth(firstLine)).toBe(width);
  });

  it("wraps ANSI-colored cells without corrupting escape sequences", () => {
    const out = renderTable({
      columns: [
        { header: "K", key: "K", minWidth: 3 },
        { flex: true, header: "V", key: "V", minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `\x1b[33m${"a".repeat(120)}\x1b[0m`,
        },
      ],
      width: 36,
    });

    const ansiToken = new RegExp(String.raw`\u001b\[[0-9;]*m|\u001b\]8;;.*?\u001b\\`, "gs");
    let escapeIndex = out.indexOf("\u001b");
    while (escapeIndex >= 0) {
      ansiToken.lastIndex = escapeIndex;
      const match = ansiToken.exec(out);
      expect(match?.index).toBe(escapeIndex);
      escapeIndex = out.indexOf("\u001b", escapeIndex + 1);
    }
  });

  it("resets ANSI styling on wrapped lines", () => {
    const reset = "\x1b[0m";
    const out = renderTable({
      columns: [
        { header: "K", key: "K", minWidth: 3 },
        { flex: true, header: "V", key: "V", minWidth: 10 },
      ],
      rows: [
        {
          K: "X",
          V: `\x1b[31m${"a".repeat(80)}${reset}`,
        },
      ],
      width: 24,
    });

    const lines = out.split("\n").filter((line) => line.includes("a"));
    for (const line of lines) {
      const resetIndex = line.lastIndexOf(reset);
      const lastSep = line.lastIndexOf("│");
      expect(resetIndex).toBeGreaterThan(-1);
      expect(lastSep).toBeGreaterThan(resetIndex);
    }
  });

  it("trims leading spaces on wrapped ANSI-colored continuation lines", () => {
    const out = renderTable({
      columns: [
        { header: "Status", key: "Status", minWidth: 10 },
        { flex: true, header: "Skill", key: "Skill", minWidth: 18 },
        { flex: true, header: "Description", key: "Description", minWidth: 24 },
        { header: "Source", key: "Source", minWidth: 10 },
      ],
      rows: [
        {
          Description:
            `\x1b[2mGet current weather and forecasts via wttr.in or Open-Meteo. ` +
            `Use when: user asks about weather, temperature, or forecasts for any location.` +
            `\x1b[0m`,
          Skill: "🌤️ weather",
          Source: "openclaw-bundled",
          Status: "✓ ready",
        },
      ],
      width: 113,
    });

    const lines = out
      .trimEnd()
      .split("\n")
      .filter((line) => line.includes("Use when"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("\u001b[2mUse when");
    expect(lines[0]).not.toContain("│  Use when");
    expect(lines[0]).not.toContain("│ \x1b[2m Use when");
  });

  it("respects explicit newlines in cell values", () => {
    const out = renderTable({
      columns: [
        { header: "A", key: "A", minWidth: 6 },
        { flex: true, header: "B", key: "B", minWidth: 10 },
      ],
      rows: [{ A: "row", B: "line1\nline2" }],
      width: 48,
    });

    const lines = out.trimEnd().split("\n");
    const line1Index = lines.findIndex((line) => line.includes("line1"));
    const line2Index = lines.findIndex((line) => line.includes("line2"));
    expect(line1Index).toBeGreaterThan(-1);
    expect(line2Index).toBe(line1Index + 1);
  });

  it("keeps table borders aligned when cells contain wide emoji graphemes", () => {
    const width = 72;
    const out = renderTable({
      columns: [
        { header: "Status", key: "Status", minWidth: 10 },
        { header: "Skill", key: "Skill", minWidth: 18 },
        { flex: true, header: "Description", key: "Description", minWidth: 18 },
        { header: "Source", key: "Source", minWidth: 10 },
      ],
      rows: [
        {
          Description: "Capture screenshots from macOS windows and keep table wrapping stable.",
          Skill: "📸 peekaboo",
          Source: "openclaw-bundled",
          Status: "✗ missing",
        },
      ],
      width,
    });

    for (const line of out.trimEnd().split("\n")) {
      expect(visibleWidth(line)).toBe(width);
    }
  });

  it("consumes unsupported escape sequences without hanging", () => {
    const out = renderTable({
      columns: [
        { header: "K", key: "K", minWidth: 6 },
        { flex: true, header: "V", key: "V", minWidth: 12 },
      ],
      rows: [{ K: "row", V: "before \x1b[2J after" }],
      width: 48,
    });

    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("falls back to ASCII borders on legacy Windows consoles", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.stubEnv("WT_SESSION", "");
    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("TERM", "vt100");

    const out = renderTable({
      columns: [
        { header: "A", key: "A", minWidth: 6 },
        { flex: true, header: "B", key: "B", minWidth: 10 },
      ],
      rows: [{ A: "row", B: "value" }],
    });

    expect(out).toContain("+");
    expect(out).not.toContain("┌");
  });

  it("keeps unicode borders on modern Windows terminals", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.stubEnv("WT_SESSION", "1");
    vi.stubEnv("TERM", "");
    vi.stubEnv("TERM_PROGRAM", "");

    const out = renderTable({
      columns: [
        { header: "A", key: "A", minWidth: 6 },
        { flex: true, header: "B", key: "B", minWidth: 10 },
      ],
      rows: [{ A: "row", B: "value" }],
    });

    expect(out).toContain("┌");
    expect(out).not.toContain("+");
  });
});

describe("wrapNoteMessage", () => {
  it("preserves long filesystem paths without inserting spaces/newlines", () => {
    const input =
      "/Users/user/Documents/Github/impact-signals-pipeline/with/really/long/segments/file.txt";
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 22 });

    expect(wrapped).toBe(input);
  });

  it("preserves long urls without inserting spaces/newlines", () => {
    const input =
      "https://example.com/this/is/a/very/long/url/segment/that/should/not/be/split/for-copy";
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 24 });

    expect(wrapped).toBe(input);
  });

  it("preserves long file-like underscore tokens for copy safety", () => {
    const input = "administrators_authorized_keys_with_extra_suffix";
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 14 });

    expect(wrapped).toBe(input);
  });

  it("still chunks generic long opaque tokens to avoid pathological line width", () => {
    const input = "x".repeat(70);
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 20 });

    expect(wrapped).toContain("\n");
    expect(wrapped.replace(/\n/g, "")).toBe(input);
  });

  it("wraps bullet lines while preserving bullet indentation", () => {
    const input = "- one two three four five six seven eight nine ten";
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 18 });
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith("- ")).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
  });

  it("preserves long Windows paths without inserting spaces/newlines", () => {
    // No spaces: wrapNoteMessage splits on whitespace, so a "Program Files" style path would wrap.
    const input = String.raw`C:\\State\\OpenClaw\\bin\\openclaw.exe`;
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 10 });
    expect(wrapped).toBe(input);
  });

  it("preserves UNC paths without inserting spaces/newlines", () => {
    const input = String.raw`\\\\server\\share\\some\\really\\long\\path\\file.txt`;
    const wrapped = wrapNoteMessage(input, { columns: 80, maxWidth: 12 });
    expect(wrapped).toBe(input);
  });
});
