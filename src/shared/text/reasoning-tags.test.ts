import { describe, expect, it } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  function expectStrippedCase(params: {
    input: string | null;
    expected: string | null;
    opts?: Parameters<typeof stripReasoningTagsFromText>[1];
  }) {
    expect(stripReasoningTagsFromText(params.input as unknown as string, params.opts)).toBe(
      params.expected,
    );
  }

  function expectPreservedReasoningTagCodeExample(input: string) {
    expect(stripReasoningTagsFromText(input)).toBe(input);
  }

  function expectReasoningCodeCase(params: { input: string; expected?: string }) {
    if (params.expected === undefined) {
      expectPreservedReasoningTagCodeExample(params.input);
      return;
    }
    expectStrippedCase({
      expected: params.expected,
      input: params.input,
    });
  }

  describe("basic functionality", () => {
    it.each([
      {
        expected: "Hello, this is a normal message.",
        input: "Hello, this is a normal message.",
        name: "returns text unchanged when no reasoning tags present",
      },
      {
        expected: "Hello  world!",
        input: "Hello <think>internal reasoning</think> world!",
        name: "strips proper think tags",
      },
      {
        expected: "Before  after",
        input: "Before <thinking>some thought</thinking> after",
        name: "strips thinking tags",
      },
      { expected: "A  B", input: "A <thought>hmm</thought> B", name: "strips thought tags" },
      {
        expected: "X  Y",
        input: "X <antthinking>internal</antthinking> Y",
        name: "strips antthinking tags",
      },
      {
        expected: "Before  after",
        input: "Before <antml:thinking>secret</antml:thinking> after",
        name: "strips antml namespaced thinking tags",
      },
      {
        expected: "AB",
        input: "<think>first</think>A<think>second</think>B",
        name: "strips multiple reasoning blocks",
      },
    ] as const)("$name", (testCase) => {
      expectStrippedCase(testCase);
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it.each([
      {
        input: "Use the tag like this:\n```\n<think>reasoning</think>\n```\nThat's it!",
        name: "preserves plain code example",
      },
      {
        input: "The `<think>` tag is used for reasoning. Don't forget the closing `</think>` tag.",
        name: "preserves inline literal think tag documentation",
      },
      {
        input: "Example:\n```xml\n<think>\n  <thought>nested</thought>\n</think>\n```\nDone!",
        name: "preserves xml fenced examples",
      },
      {
        input: "Use `<think>` to open and `</think>` to close.",
        name: "preserves plain literal opening and closing tags",
      },
      {
        input: "Example:\n```\n<think>reasoning</think>\n```",
        name: "preserves fenced think example",
      },
      {
        input: "Use `<final>` for final answers in code: ```\n<final>42</final>\n```",
        name: "preserves final tags inside code examples",
      },
      {
        input: "First `<think>` then ```\n<thinking>block</thinking>\n``` then `<thought>`",
        name: "preserves mixed literal think tags and code blocks",
      },
      {
        expected: "Visible text with `<think>` example.",
        input: "<think>hidden</think>Visible text with `<think>` example.",
        name: "strips real tags while preserving literal think examples",
      },
      {
        expected: "```\n<think>code</think>\n```\nvisible",
        input: "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
        name: "strips real tags after fenced code block",
      },
    ] as const)("$name", ({ input, expected }) => {
      expectReasoningCodeCase({ expected, input });
    });
  });

  describe("edge cases", () => {
    it.each([
      {
        expected: "Here is how to use <think tags in your code",
        input: "Here is how to use <think tags in your code",
      },
      {
        expected: "You can start with <think and then close with",
        input: "You can start with <think and then close with </think>",
      },
      {
        expected: "A  B",
        input: "A < think >content< /think > B",
      },
      {
        expected: "",
        input: "",
      },
      {
        expected: null,
        input: null as unknown as string,
      },
    ] as const)("handles malformed/null-ish input %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it.each([
      {
        expected: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
        input: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
      },
      {
        expected: "Example:\n~~~js\n<think>code</think>\n~~~",
        input: "Example:\n~~~js\n<think>code</think>\n~~~",
      },
      {
        expected: "Use ``code`` with  text",
        input: "Use ``code`` with <think>hidden</think> text",
      },
      {
        expected: "Before\n```\ncode\n```\nAfter with",
        input: "Before\n```\ncode\n```\nAfter with <think>hidden</think>",
      },
      {
        expected: "```\n<think>not protected\n~~~\n</think>text",
        input: "```\n<think>not protected\n~~~\n</think>text",
      },
      {
        expected: "Start `unclosed  end",
        input: "Start `unclosed <think>hidden</think> end",
      },
    ] as const)("handles fenced/inline code edge behavior: %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it.each([
      {
        expected: "still outervisible",
        input: "<think>outer <think>inner</think> still outer</think>visible",
      },
      {
        expected: "A1B2C",
        input: "A<final>1</final>B<final>2</final>C",
      },
      {
        expected: "`<final>` in code, visible outside",
        input: "`<final>` in code, <final>visible</final> outside",
      },
      {
        expected: "A visible B",
        input: "A <FINAL data-x='1'>visible</Final> B",
      },
    ] as const)("handles nested/final tag behavior: %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it.each([
      {
        expected: "你好  世界",
        input: "你好 <think>思考 🤔</think> 世界",
      },
      {
        expected: "A  B",
        input: "A <think id='test' class=\"foo\">hidden</think> B",
      },
      {
        expected: "A   B",
        input: "A <THINK>hidden</THINK> <Thinking>also hidden</Thinking> B",
      },
      {
        expected: "A  B",
        input: "A <ANTML:THINKING hidden='1'>secret</ANTML:THINKING> B",
      },
    ] as const)("handles unicode/attributes/case-insensitive names: %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it("handles long content and pathological backtick patterns efficiently", () => {
      const longContent = "x".repeat(10_000);
      expect(stripReasoningTagsFromText(`<think>${longContent}</think>visible`)).toBe("visible");

      const pathological = "`".repeat(100) + "<think>test</think>" + "`".repeat(100);
      const start = Date.now();
      stripReasoningTagsFromText(pathological);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("strict vs preserve mode", () => {
    it.each([
      {
        expected: "Before",
        input: "Before <think>unclosed content after",
        name: "applies strict mode to unclosed tags",
        opts: { mode: "strict" as const },
      },
      {
        expected: "Before unclosed content after",
        input: "Before <think>unclosed content after",
        name: "applies preserve mode to unclosed tags",
        opts: { mode: "preserve" as const },
      },
      {
        expected: "A  B",
        input: "A <think>hidden</think> B",
        name: "still strips fully closed reasoning blocks in preserve mode",
        opts: { mode: "preserve" as const },
      },
    ] as const)("$name", (testCase) => {
      expectStrippedCase(testCase);
    });
  });

  describe("trim options", () => {
    it.each([
      {
        expected: "result",
        input: "  <think>x</think>  result  <think>y</think>  ",
        name: "applies default trim strategy",
        opts: undefined,
      },
      {
        expected: "    result  ",
        input: "  <think>x</think>  result  ",
        name: "supports trim=none",
        opts: { trim: "none" as const },
      },
      {
        expected: "result  ",
        input: "  <think>x</think>  result  ",
        name: "supports trim=start",
        opts: { trim: "start" as const },
      },
    ] as const)("$name", (testCase) => {
      expectStrippedCase(testCase);
    });
  });

  it.each([
    { expected: "A 1 B", input: "A <final>1</final> B" },
    { expected: "C 2 D", input: "C <final>2</final> D" },
    { expected: "E  F", input: "E <think>x</think> F" },
  ] as const)("does not leak regex state across repeated calls: %j", (testCase) => {
    expectStrippedCase(testCase);
  });
});
