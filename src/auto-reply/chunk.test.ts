import { describe, expect, it, vi } from "vitest";
import * as fences from "../markdown/fences.js";
import { hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "./chunk.js";

function expectFencesBalanced(chunks: string[]) {
  for (const chunk of chunks) {
    expect(hasBalancedFences(chunk)).toBe(true);
  }
}

function expectChunkLengths(chunks: string[], expectedLengths: number[]) {
  expect(chunks).toHaveLength(expectedLengths.length);
  expectedLengths.forEach((length, index) => {
    expect(chunks[index]?.length).toBe(length);
  });
}

function expectNormalizedChunkJoin(chunks: string[], text: string) {
  expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
}

function expectChunkTextCase(params: {
  text: string;
  limit: number;
  assert: (chunks: string[], text: string) => void;
}) {
  const chunks = chunkText(params.text, params.limit);
  params.assert(chunks, params.text);
}

function expectChunkSpecialCase(run: () => void) {
  run();
}

interface ChunkCase {
  name: string;
  text: string;
  limit: number;
  expected: string[];
}

function runChunkCases(chunker: (text: string, limit: number) => string[], cases: ChunkCase[]) {
  it.each(cases)("$name", ({ text, limit, expected }) => {
    expect(chunker(text, limit)).toEqual(expected);
  });
}

function expectChunkModeCase(params: {
  chunker: (text: string, limit: number, mode: "length" | "newline") => string[];
  text: string;
  limit: number;
  mode: "length" | "newline";
  expected: readonly string[];
  name?: string;
}) {
  expect(params.chunker(params.text, params.limit, params.mode), params.name).toEqual(
    params.expected,
  );
}

function expectMarkdownFenceSplitCases(
  cases: readonly {
    name: string;
    text: string;
    limit: number;
    expectedPrefix: string;
    expectedSuffix: string;
  }[],
) {
  cases.forEach(({ name, text, limit, expectedPrefix, expectedSuffix }) => {
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length, name).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length, name).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith(expectedPrefix), name).toBe(true);
      expect(chunk.trimEnd().endsWith(expectedSuffix), name).toBe(true);
    }
    expectFencesBalanced(chunks);
  });
}

function expectNoEmptyFencedChunks(text: string, limit: number) {
  const chunks = chunkMarkdownText(text, limit);
  for (const chunk of chunks) {
    const nonFenceLines = chunk
      .split("\n")
      .filter((line) => !/^( {0,3})(`{3,}|~{3,})(.*)$/.test(line));
    expect(nonFenceLines.join("\n").trim()).not.toBe("");
  }
}

function expectFenceParseOccursOnce(text: string, limit: number) {
  const parseSpy = vi.spyOn(fences, "parseFenceSpans");
  const chunks = chunkMarkdownText(text, limit);

  expect(chunks.length).toBeGreaterThan(2);
  expect(parseSpy).toHaveBeenCalledTimes(1);
  parseSpy.mockRestore();
}

const parentheticalCases: ChunkCase[] = [
  {
    expected: ["Heads up now", "(Though now I'm curious)ok"],
    limit: 35,
    name: "keeps parenthetical phrases together",
    text: "Heads up now (Though now I'm curious)ok",
  },
  {
    expected: ["Hello (outer (inner) end)", "world"],
    limit: 26,
    name: "handles nested parentheses",
    text: "Hello (outer (inner) end) world",
  },
  {
    expected: ["Hello)", "world (ok)"],
    limit: 12,
    name: "ignores unmatched closing parentheses",
    text: "Hello) world (ok)",
  },
];

const newlineModeFenceCases = (() => {
  const fence = "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";
  const longFence = `\`\`\`js\n${"const a = 1;\n".repeat(20)}\`\`\``;
  return [
    {
      expected: ["```js\nconst a = 1;\nconst b = 2;\n```\nAfter"],
      limit: 1000,
      name: "keeps single-newline fence+paragraph together",
      text: "```js\nconst a = 1;\nconst b = 2;\n```\nAfter",
    },
    {
      expected: [fence],
      limit: 1000,
      name: "keeps blank lines inside fence together",
      text: fence,
    },
    {
      expected: [fence, "After"],
      limit: 1000,
      name: "splits between fence and following paragraph",
      text: `${fence}\n\nAfter`,
    },
    {
      expected: chunkMarkdownText(longFence, 40),
      limit: 40,
      name: "defers long markdown blocks to markdown chunker",
      text: longFence,
    },
  ] as const;
})();

describe("chunkText", () => {
  it.each([
    {
      assert: (chunks: string[], text: string) => {
        expect(chunks).toEqual([text]);
      },
      limit: 1600,
      name: "keeps multi-line text in one chunk when under limit",
      text: "Line one\n\nLine two\n\nLine three",
    },
    {
      assert: (chunks: string[], text: string) => {
        expectChunkLengths(chunks, [60, 40]);
        expect(chunks.join("")).toBe(text);
      },
      limit: 60,
      name: "splits only when text exceeds the limit",
      text: "a".repeat(20).repeat(5),
    },
    {
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["paragraph one line", "paragraph two starts here and continues"]);
      },
      limit: 40,
      name: "prefers breaking at a newline before the limit",
      text: "paragraph one line\n\nparagraph two starts here and continues",
    },
    {
      assert: (chunks: string[], text: string) => {
        expect(chunks[0]?.length).toBeLessThanOrEqual(30);
        expect(chunks[1]?.length).toBeLessThanOrEqual(30);
        expectNormalizedChunkJoin(chunks, text);
      },
      limit: 30,
      name: "otherwise breaks at the last whitespace under the limit",
      text: "This is a message that should break nicely near a word boundary.",
    },
    {
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["Supercalif", "ragilistic", "expialidoc", "ious"]);
      },
      limit: 10,
      name: "falls back to a hard break when no whitespace is present",
      text: "Supercalifragilisticexpialidocious",
    },
  ] as const)("$name", ({ text, limit, assert }) => {
    expectChunkTextCase({ assert, limit, text });
  });

  runChunkCases(chunkText, [parentheticalCases[0]]);
});

describe("resolveTextChunkLimit", () => {
  it.each([
    ...(["whatsapp", "telegram", "slack", "signal", "imessage", "discord"] as const).map(
      (provider) => ({
        accountId: undefined,
        cfg: undefined,
        expected: 4000,
        name: `uses default limit for ${provider}`,
        options: undefined,
        provider,
      }),
    ),
    {
      accountId: undefined,
      cfg: undefined,
      expected: 2000,
      name: "uses fallback limit override when provided",
      options: { fallbackLimit: 2000 },
      provider: "discord" as const,
    },
    {
      accountId: undefined,
      cfg: { channels: { telegram: { textChunkLimit: 1234 } } },
      expected: 1234,
      name: "supports provider overrides for telegram",
      options: undefined,
      provider: "telegram" as const,
    },
    {
      accountId: undefined,
      cfg: { channels: { telegram: { textChunkLimit: 1234 } } },
      expected: 4000,
      name: "falls back when provider override does not match",
      options: undefined,
      provider: "whatsapp" as const,
    },
    {
      accountId: "primary",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: { textChunkLimit: 1234 },
              primary: { textChunkLimit: 777 },
            },
            textChunkLimit: 2000,
          },
        },
      },
      expected: 777,
      name: "prefers account overrides when provided",
      options: undefined,
      provider: "telegram" as const,
    },
    {
      accountId: "default",
      cfg: {
        channels: {
          telegram: {
            accounts: {
              default: { textChunkLimit: 1234 },
              primary: { textChunkLimit: 777 },
            },
            textChunkLimit: 2000,
          },
        },
      },
      expected: 1234,
      name: "uses default account override when requested",
      options: undefined,
      provider: "telegram" as const,
    },
    {
      accountId: undefined,
      cfg: {
        channels: {
          discord: { textChunkLimit: 111 },
          slack: { textChunkLimit: 222 },
        },
      },
      expected: 111,
      name: "uses the matching provider override for discord",
      options: undefined,
      provider: "discord" as const,
    },
    {
      accountId: undefined,
      cfg: {
        channels: {
          discord: { textChunkLimit: 111 },
          slack: { textChunkLimit: 222 },
        },
      },
      expected: 222,
      name: "uses the matching provider override for slack",
      options: undefined,
      provider: "slack" as const,
    },
    {
      accountId: undefined,
      cfg: {
        channels: {
          discord: { textChunkLimit: 111 },
          slack: { textChunkLimit: 222 },
        },
      },
      expected: 4000,
      name: "falls back when multi-provider override does not match",
      options: undefined,
      provider: "telegram" as const,
    },
  ] as const)("$name", ({ cfg, provider, accountId, options, expected }) => {
    expect(resolveTextChunkLimit(cfg as never, provider, accountId, options)).toBe(expected);
  });
});

describe("chunkMarkdownText", () => {
  it.each([
    {
      name: "keeps fenced blocks intact when a safe break exists",
      run: () => {
        const prefix = "p".repeat(60);
        const fence = "```bash\nline1\nline2\n```";
        const suffix = "s".repeat(60);
        const text = `${prefix}\n\n${fence}\n\n${suffix}`;

        const chunks = chunkMarkdownText(text, 40);
        expect(chunks.some((chunk) => chunk.trimEnd() === fence)).toBe(true);
        expectFencesBalanced(chunks);
      },
    },
    {
      name: "handles multiple fence marker styles when splitting inside fences",
      run: () =>
        expectMarkdownFenceSplitCases([
          {
            expectedPrefix: "```txt\n",
            expectedSuffix: "```",
            limit: 120,
            name: "backtick fence",
            text: `\`\`\`txt\n${"a".repeat(500)}\n\`\`\``,
          },
          {
            expectedPrefix: "~~~sh\n",
            expectedSuffix: "~~~",
            limit: 140,
            name: "tilde fence",
            text: `~~~sh\n${"x".repeat(600)}\n~~~`,
          },
          {
            expectedPrefix: "````md\n",
            expectedSuffix: "````",
            limit: 140,
            name: "long backtick fence",
            text: `\`\`\`\`md\n${"y".repeat(600)}\n\`\`\`\``,
          },
          {
            expectedPrefix: "  ```js\n",
            expectedSuffix: "  ```",
            limit: 160,
            name: "indented fence",
            text: `  \`\`\`js\n  ${"z".repeat(600)}\n  \`\`\``,
          },
        ]),
    },
  ] as const)("$name", ({ run }) => {
    expectChunkSpecialCase(run);
  });

  runChunkCases(chunkMarkdownText, parentheticalCases);

  it.each([
    {
      name: "never produces an empty fenced chunk when splitting",
      run: () => {
        expectNoEmptyFencedChunks(`\`\`\`txt\n${"a".repeat(300)}\n\`\`\``, 60);
      },
    },
    {
      name: "hard-breaks when a parenthetical exceeds the limit",
      run: () => {
        const text = `(${"a".repeat(80)})`;
        const chunks = chunkMarkdownText(text, 20);
        expect(chunks[0]?.length).toBe(20);
        expect(chunks.join("")).toBe(text);
      },
    },
    {
      name: "parses fence spans once for long fenced payloads",
      run: () => {
        expectFenceParseOccursOnce(`\`\`\`txt\n${"line\n".repeat(600)}\`\`\``, 80);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectChunkSpecialCase(run);
  });
});

describe("chunkByNewline", () => {
  it.each([
    {
      expected: ["Line one", "Line two", "Line three"],
      limit: 1000,
      name: "splits text on newlines",
      text: "Line one\nLine two\nLine three",
    },
    {
      expected: ["Line one", "\n\nLine two", "\nLine three"],
      limit: 1000,
      name: "preserves blank lines by folding into the next chunk",
      text: "Line one\n\n\nLine two\n\nLine three",
    },
    {
      expected: ["Line one", "Line two"],
      limit: 1000,
      name: "trims whitespace from lines",
      text: "  Line one  \n  Line two  ",
    },
    {
      expected: ["\n\nLine one", "Line two"],
      limit: 1000,
      name: "preserves leading blank lines on the first chunk",
      text: "\n\nLine one\nLine two",
    },
    {
      expected: ["Line one\n\n"],
      limit: 1000,
      name: "preserves trailing blank lines on the last chunk",
      text: "Line one\n\n",
    },
    {
      expected: ["  indented line  ", "Next"],
      limit: 1000,
      name: "keeps whitespace when trimLines is false",
      options: { trimLines: false },
      text: "  indented line  \nNext",
    },
  ] as const)("$name", ({ text, limit, options, expected }) => {
    expect(chunkByNewline(text, limit, options)).toEqual(expected);
  });

  it.each([
    {
      name: "falls back to length-based for long lines",
      run: () => {
        const text = "Short line\n" + "a".repeat(50) + "\nAnother short";
        const chunks = chunkByNewline(text, 20);
        expect(chunks[0]).toBe("Short line");
        expectChunkLengths(chunks.slice(1, 4), [20, 20, 10]);
        expect(chunks[4]).toBe("Another short");
      },
    },
    {
      name: "does not split long lines when splitLongLines is false",
      run: () => {
        const text = "a".repeat(50);
        expect(chunkByNewline(text, 20, { splitLongLines: false })).toEqual([text]);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectChunkSpecialCase(run);
  });

  it.each(["", "   \n\n   "] as const)("returns empty array for input %j", (text) => {
    expect(chunkByNewline(text, 100)).toEqual([]);
  });
});

describe("chunkTextWithMode", () => {
  it.each([
    {
      expected: ["Line one\nLine two"],
      mode: "length" as const,
      name: "length mode",
      text: "Line one\nLine two",
    },
    {
      expected: ["Line one\nLine two"],
      mode: "newline" as const,
      name: "newline mode (single paragraph)",
      text: "Line one\nLine two",
    },
    {
      expected: ["Para one", "Para two"],
      mode: "newline" as const,
      name: "newline mode (blank-line split)",
      text: "Para one\n\nPara two",
    },
  ] as const)(
    "applies mode-specific chunking behavior: $name",
    ({ text, mode, expected, name }) => {
      expectChunkModeCase({
        chunker: chunkTextWithMode,
        expected,
        limit: 1000,
        mode,
        name,
        text,
      });
    },
  );
});

describe("chunkMarkdownTextWithMode", () => {
  it.each([
    {
      expected: chunkMarkdownText("Line one\nLine two", 1000),
      mode: "length" as const,
      name: "length mode uses markdown-aware chunker",
      text: "Line one\nLine two",
    },
    {
      expected: ["Line one\nLine two"],
      mode: "newline" as const,
      name: "newline mode keeps single paragraph",
      text: "Line one\nLine two",
    },
    {
      expected: ["Para one", "Para two"],
      mode: "newline" as const,
      name: "newline mode splits by blank line",
      text: "Para one\n\nPara two",
    },
  ] as const)("applies markdown/newline mode behavior: $name", ({ text, mode, expected, name }) => {
    expectChunkModeCase({
      chunker: chunkMarkdownTextWithMode,
      expected,
      limit: 1000,
      mode,
      name,
      text,
    });
  });

  it.each(newlineModeFenceCases)(
    "handles newline mode fence splitting rules: $name",
    ({ text, limit, expected, name }) => {
      expect(chunkMarkdownTextWithMode(text, limit, "newline"), name).toEqual(expected);
    },
  );
});

describe("resolveChunkMode", () => {
  const providerCfg = { channels: { slack: { chunkMode: "newline" as const } } };
  const accountCfg = {
    channels: {
      slack: {
        accounts: {
          primary: { chunkMode: "newline" as const },
        },
        chunkMode: "length" as const,
      },
    },
  };

  it.each([
    { accountId: undefined, cfg: undefined, expected: "length", provider: "telegram" },
    { accountId: undefined, cfg: {}, expected: "length", provider: "discord" },
    { accountId: undefined, cfg: undefined, expected: "length", provider: "bluebubbles" },
    { accountId: undefined, cfg: providerCfg, expected: "length", provider: "__internal__" },
    { accountId: undefined, cfg: providerCfg, expected: "newline", provider: "slack" },
    { accountId: undefined, cfg: providerCfg, expected: "length", provider: "discord" },
    { accountId: "primary", cfg: accountCfg, expected: "newline", provider: "slack" },
    { accountId: "other", cfg: accountCfg, expected: "length", provider: "slack" },
  ] as const)(
    "resolves default/provider/account/internal chunk mode for $provider $accountId",
    ({ cfg, provider, accountId, expected }) => {
      expect(resolveChunkMode(cfg as never, provider, accountId)).toBe(expected);
    },
  );
});
