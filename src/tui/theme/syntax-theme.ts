import chalk from "chalk";

type HighlightTheme = Record<string, (text: string) => string>;

/**
 * Syntax highlighting theme for code blocks.
 * Uses chalk functions to style different token types.
 */
export function createSyntaxTheme(
  fallback: (text: string) => string,
  light = false,
): HighlightTheme {
  if (light) {
    return {
      addition: chalk.hex("#098658"),
      attr: chalk.hex("#C50000"),
      attribute: chalk.hex("#C50000"),
      built_in: chalk.hex("#267F99"),
      bullet: chalk.hex("#795E26"),
      class: chalk.hex("#267F99"),
      code: chalk.hex("#A31515"),
      comment: chalk.hex("#008000"),
      default: fallback,
      deletion: chalk.hex("#A31515"),
      doctag: chalk.hex("#008000"),
      emphasis: chalk.italic,
      formula: chalk.hex("#AF00DB"),
      function: chalk.hex("#795E26"),
      keyword: chalk.hex("#AF00DB"),
      link: chalk.hex("#267F99"),
      literal: chalk.hex("#0000FF"),
      meta: chalk.hex("#001080"),
      "meta-keyword": chalk.hex("#AF00DB"),
      "meta-string": chalk.hex("#A31515"),
      name: chalk.hex("#001080"),
      number: chalk.hex("#098658"),
      params: chalk.hex("#001080"),
      quote: chalk.hex("#008000"),
      regexp: chalk.hex("#811F3F"),
      section: chalk.hex("#795E26"),
      "selector-attr": chalk.hex("#800000"),
      "selector-class": chalk.hex("#800000"),
      "selector-id": chalk.hex("#800000"),
      "selector-pseudo": chalk.hex("#800000"),
      "selector-tag": chalk.hex("#800000"),
      string: chalk.hex("#A31515"),
      strong: chalk.bold,
      symbol: chalk.hex("#098658"),
      tag: chalk.hex("#800000"),
      "template-tag": chalk.hex("#AF00DB"),
      "template-variable": chalk.hex("#001080"),
      title: chalk.hex("#795E26"),
      type: chalk.hex("#267F99"),
      variable: chalk.hex("#001080"),
    };
  }

  return {
    keyword: chalk.hex("#C586C0"), // Purple - if, const, function, etc.
    built_in: chalk.hex("#4EC9B0"), // Teal - console, Math, etc.
    type: chalk.hex("#4EC9B0"), // Teal - types
    literal: chalk.hex("#569CD6"), // Blue - true, false, null
    number: chalk.hex("#B5CEA8"), // Green - numbers
    string: chalk.hex("#CE9178"), // Orange - strings
    regexp: chalk.hex("#D16969"), // Red - regex
    symbol: chalk.hex("#B5CEA8"), // Green - symbols
    class: chalk.hex("#4EC9B0"), // Teal - class names
    function: chalk.hex("#DCDCAA"), // Yellow - function names
    title: chalk.hex("#DCDCAA"), // Yellow - titles/names
    params: chalk.hex("#9CDCFE"), // Light blue - parameters
    comment: chalk.hex("#6A9955"), // Green - comments
    doctag: chalk.hex("#608B4E"), // Darker green - jsdoc tags
    meta: chalk.hex("#9CDCFE"), // Light blue - meta/preprocessor
    "meta-keyword": chalk.hex("#C586C0"), // Purple
    "meta-string": chalk.hex("#CE9178"), // Orange
    section: chalk.hex("#DCDCAA"), // Yellow - sections
    tag: chalk.hex("#569CD6"), // Blue - HTML/XML tags
    name: chalk.hex("#9CDCFE"), // Light blue - tag names
    attr: chalk.hex("#9CDCFE"), // Light blue - attributes
    attribute: chalk.hex("#9CDCFE"), // Light blue - attributes
    variable: chalk.hex("#9CDCFE"), // Light blue - variables
    bullet: chalk.hex("#D7BA7D"), // Gold - list bullets in markdown
    code: chalk.hex("#CE9178"), // Orange - inline code
    emphasis: chalk.italic, // Italic
    strong: chalk.bold, // Bold
    formula: chalk.hex("#C586C0"), // Purple - math
    link: chalk.hex("#4EC9B0"), // Teal - links
    quote: chalk.hex("#6A9955"), // Green - quotes
    addition: chalk.hex("#B5CEA8"), // Green - diff additions
    deletion: chalk.hex("#F44747"), // Red - diff deletions
    "selector-tag": chalk.hex("#D7BA7D"), // Gold - CSS selectors
    "selector-id": chalk.hex("#D7BA7D"), // Gold
    "selector-class": chalk.hex("#D7BA7D"), // Gold
    "selector-attr": chalk.hex("#D7BA7D"), // Gold
    "selector-pseudo": chalk.hex("#D7BA7D"), // Gold
    "template-tag": chalk.hex("#C586C0"), // Purple
    "template-variable": chalk.hex("#9CDCFE"), // Light blue
    default: fallback, // Fallback to code color
  };
}
