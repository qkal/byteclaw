import { describe, expect, it } from "vitest";
import { stripAnsi, visibleWidth } from "../../terminal/ansi.js";
import { SearchableSelectList, type SearchableSelectListTheme } from "./searchable-select-list.js";

const mockTheme: SearchableSelectListTheme = {
  description: (t) => `(${t})`,
  matchHighlight: (t) => `*${t}*`,
  noMatch: (t) => `!${t}!`,
  scrollInfo: (t) => `~${t}~`,
  searchInput: (t) => `|${t}|`,
  searchPrompt: (t) => `>${t}<`,
  selectedPrefix: (t) => `[${t}]`,
  selectedText: (t) => `**${t}**`,
};

const ansiHighlightTheme: SearchableSelectListTheme = {
  description: (t) => t,
  matchHighlight: (t) => `\u001b[31m${t}\u001b[0m`,
  noMatch: (t) => t,
  scrollInfo: (t) => t,
  searchInput: (t) => t,
  searchPrompt: (t) => t,
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
};

const testItems = [
  {
    description: "Claude 3 Opus",
    label: "anthropic/claude-3-opus",
    value: "anthropic/claude-3-opus",
  },
  {
    description: "Claude 3 Sonnet",
    label: "anthropic/claude-3-sonnet",
    value: "anthropic/claude-3-sonnet",
  },
  { description: "GPT-4", label: "openai/gpt-4", value: "openai/gpt-4" },
  { description: "GPT-4 Turbo", label: "openai/gpt-4-turbo", value: "openai/gpt-4-turbo" },
  { description: "Gemini Pro", label: "google/gemini-pro", value: "google/gemini-pro" },
];

describe("SearchableSelectList", () => {
  function typeInput(list: SearchableSelectList, text: string) {
    for (const ch of text) {
      list.handleInput(ch);
    }
  }

  function expectSelectedValueForQuery(
    list: SearchableSelectList,
    query: string,
    expectedValue: string,
  ) {
    typeInput(list, query);
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe(expectedValue);
  }

  function expectNoMatchesForQuery(list: SearchableSelectList, query: string) {
    typeInput(list, query);
    const output = list.render(80);
    expect(output.some((line) => line.includes("No matches"))).toBe(true);
  }

  function expectDescriptionVisibilityAtWidth(width: number, shouldContainDescription: boolean) {
    const items = [
      { description: "desc", label: "one", value: "one" },
      { description: "desc", label: "two", value: "two" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);
    // Ensure first row is non-selected so description styling path is exercised.
    list.setSelectedIndex(1);
    const output = list.render(width).join("\n");
    if (shouldContainDescription) {
      expect(output).toContain("(desc)");
    } else {
      expect(output).not.toContain("(desc)");
    }
  }

  it("renders all items when no filter is applied", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    const output = list.render(80);

    // Should have search prompt line, spacer, and items
    expect(output.length).toBeGreaterThanOrEqual(3);
    expect(output[0]).toContain("search");
  });

  it("does not truncate long labels on wide terminals when description is present", () => {
    const tail = "__TAIL__";
    const longLabel = `session-${"x".repeat(40)}${tail}`; // > 30 chars; tail would be lost before PR
    const items = [{ description: "desc", label: longLabel, value: longLabel }];
    const list = new SearchableSelectList(items, 5, mockTheme);

    const output = list.render(120).join("\n");
    expect(output).toContain(tail);
  });

  it("does not show description layout at width 40 (boundary)", () => {
    expectDescriptionVisibilityAtWidth(40, false);
  });

  it("shows description layout at width 41 (boundary)", () => {
    expectDescriptionVisibilityAtWidth(41, true);
  });

  it("keeps ANSI-highlighted description rows within terminal width", () => {
    const label = `provider/${"x".repeat(80)}`;
    const items = [
      { description: "Some description text that should not overflow", label, value: label },
      { description: "Other description", label: "other", value: "other" },
    ];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);
    list.setSelectedIndex(1); // Make first row non-selected so description styling is applied

    typeInput(list, "provider");

    const width = 80;
    const output = list.render(width);
    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps model-search rows within width when filtering by m", () => {
    const items = [
      { description: "MiniMax M2", label: "minimax-cn/MiniMax-M2", value: "minimax-cn/MiniMax-M2" },
      {
        description: "MiniMax M2.1",
        label: "minimax-cn/MiniMax-M2.1",
        value: "minimax-cn/MiniMax-M2.1",
      },
      {
        description: "Codestral",
        label: "mistral/codestral-latest",
        value: "mistral/codestral-latest",
      },
      {
        description: "Devstral Medium",
        label: "mistral/devstral-medium-latest",
        value: "mistral/devstral-medium-latest",
      },
    ];
    const list = new SearchableSelectList(items, 9, ansiHighlightTheme);
    typeInput(list, "m");

    const width = 209;
    for (const line of list.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("ignores ANSI escape codes in search matching", () => {
    const items = [
      { description: "Styled label", label: "\u001b[32mopenai/gpt-4\u001b[0m", value: "styled" },
      { description: "Plain label", label: "plain-item", value: "plain" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectNoMatchesForQuery(list, "32m");
  });

  it("does not corrupt ANSI sequences when highlighting multiple tokens", () => {
    const items = [{ label: "gpt-model", value: "gpt-model" }];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);

    typeInput(list, "gpt m");

    const renderedLine = list.render(80).find((line) => stripAnsi(line).includes("gpt-model"));
    expect(renderedLine).toBeDefined();
    const highlightOpens = renderedLine ? renderedLine.split("\u001b[31m").length - 1 : 0;
    expect(highlightOpens).toBe(2);
  });

  it("filters items when typing", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Simulate typing "gemini" - unique enough to narrow down
    typeInput(list, "gemini");

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("google/gemini-pro");
  });

  it("prioritizes exact substring matches over fuzzy matches", () => {
    // Add items where one has early exact match, others are fuzzy or late matches
    const items = [
      { description: "Routes to best", label: "openrouter/auto", value: "openrouter/auto" },
      { description: "Direct opus model", label: "opus-direct", value: "opus-direct" },
      {
        description: "Claude 3 Opus",
        label: "anthropic/claude-3-opus",
        value: "anthropic/claude-3-opus",
      },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    // Type "opus" - should match "opus-direct" first (earliest exact substring)
    typeInput(list, "opus");

    // First result should be "opus-direct" where "opus" appears at position 0
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("opus-direct");
  });

  it("keeps exact label matches ahead of description matches", () => {
    const longPrefix = "x".repeat(250);
    const items = [
      { description: "late exact match", label: `${longPrefix}opus`, value: "late-label" },
      { description: "opus in description", label: "provider/other", value: "desc-first" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectSelectedValueForQuery(list, "opus", "late-label");
  });

  it("exact label match beats description match", () => {
    const items = [
      {
        description: "This mentions opus in description",
        label: "provider/other",
        value: "provider/other",
      },
      { description: "Something else", label: "provider/opus-model", value: "provider/opus-model" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "opus");

    // Label match should win over description match
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("provider/opus-model");
  });

  it("orders description matches by earliest index", () => {
    const items = [
      { description: "prefix opus value", label: "first", value: "first" },
      { description: "opus suffix value", label: "second", value: "second" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectSelectedValueForQuery(list, "opus", "second");
  });

  it("filters items with fuzzy matching", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Simulate typing "gpt" which should match openai/gpt-4 models
    typeInput(list, "gpt");

    const selected = list.getSelectedItem();
    expect(selected?.value).toContain("gpt");
  });

  it("preserves fuzzy ranking when only fuzzy matches exist", () => {
    const items = [
      { description: "Worse fuzzy match", label: "xg---4", value: "xg---4" },
      { description: "Better fuzzy match", label: "gpt-4", value: "gpt-4" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "g4");

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("gpt-4");
  });

  it("highlights matches in rendered output", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    typeInput(list, "gpt");

    const output = list.render(80).join("\n");
    expect(output).toContain("*gpt*");
  });

  it("shows no match message when filter yields no results", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    expectNoMatchesForQuery(list, "xyz");
  });

  it("navigates with arrow keys", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Initially first item is selected
    expect(list.getSelectedItem()?.value).toBe("anthropic/claude-3-opus");

    // Press down arrow (escape sequence for down arrow)
    list.handleInput("\x1b[B");

    expect(list.getSelectedItem()?.value).toBe("anthropic/claude-3-sonnet");
  });

  it("types j and k into search input instead of intercepting as vim navigation", () => {
    const items = [
      { label: "alpha", value: "alpha" },
      { label: "kilo", value: "kilo" },
      { label: "juliet", value: "juliet" },
    ];

    const jList = new SearchableSelectList(items, 5, mockTheme);
    jList.handleInput("j");
    expect(jList.getSelectedItem()?.value).toBe("juliet");
    expect(stripAnsi(jList.render(80)[0] ?? "")).toContain("j");

    const kList = new SearchableSelectList(items, 5, mockTheme);
    kList.handleInput("k");
    expect(kList.getSelectedItem()?.value).toBe("kilo");
    expect(stripAnsi(kList.render(80)[0] ?? "")).toContain("k");
  });

  it("calls onSelect when enter is pressed", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let selectedValue: string | undefined;

    list.onSelect = (item) => {
      selectedValue = item.value;
    };

    // Press enter
    list.handleInput("\r");

    expect(selectedValue).toBe("anthropic/claude-3-opus");
  });

  it("calls onCancel when escape is pressed", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let cancelled = false;

    list.onCancel = () => {
      cancelled = true;
    };

    // Press escape
    list.handleInput("\x1b");

    expect(cancelled).toBe(true);
  });
});
