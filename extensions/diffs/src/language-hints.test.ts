import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  filterSupportedLanguageHints,
  normalizeDiffViewerPayloadLanguages,
} from "./language-hints.js";

describe("filterSupportedLanguageHints", () => {
  it("keeps supported languages", async () => {
    await expect(filterSupportedLanguageHints(["typescript", "text"])).resolves.toEqual([
      "typescript",
      "text",
    ]);
  });

  it("drops invalid languages and falls back to text", async () => {
    await expect(filterSupportedLanguageHints(["not-a-real-language"])).resolves.toEqual(["text"]);
  });

  it("keeps valid languages when invalid hints are mixed in", async () => {
    await expect(
      filterSupportedLanguageHints(["typescript", "not-a-real-language"]),
    ).resolves.toEqual(["typescript"]);
  });
});

describe("normalizeDiffViewerPayloadLanguages", () => {
  it("rewrites stale patch payload language overrides to plain text", async () => {
    await expect(
      normalizeDiffViewerPayloadLanguages({
        fileDiff: {
          lang: "not-a-real-language" as never,
          name: "foo.txt",
        } as unknown as FileDiffMetadata,
        langs: ["not-a-real-language" as never],
        options: {
          backgroundEnabled: true,
          diffIndicators: "bars",
          diffStyle: "unified",
          disableLineNumbers: false,
          expandUnchanged: false,
          overflow: "wrap",
          theme: {
            dark: "pierre-dark",
            light: "pierre-light",
          },
          themeType: "dark",
          unsafeCSS: "",
        },
        prerenderedHTML: "<div>diff</div>",
      }),
    ).resolves.toMatchObject({
      fileDiff: {
        lang: "text",
      },
      langs: ["text"],
    });
  });

  it("keeps valid hydrated languages and only downgrades invalid sides", async () => {
    await expect(
      normalizeDiffViewerPayloadLanguages({
        langs: ["typescript", "not-a-real-language" as never],
        newFile: {
          contents: "after",
          lang: "typescript",
          name: "after.ts",
        },
        oldFile: {
          contents: "before",
          lang: "not-a-real-language" as never,
          name: "before.unknown",
        },
        options: {
          backgroundEnabled: false,
          diffIndicators: "classic",
          diffStyle: "split",
          disableLineNumbers: true,
          expandUnchanged: true,
          overflow: "scroll",
          theme: {
            dark: "pierre-dark",
            light: "pierre-light",
          },
          themeType: "light",
          unsafeCSS: "",
        },
        prerenderedHTML: "<div>diff</div>",
      }),
    ).resolves.toMatchObject({
      langs: ["typescript", "text"],
      newFile: {
        lang: "typescript",
      },
      oldFile: {
        lang: "text",
      },
    });
  });

  it("rewrites blank explicit language overrides to plain text", async () => {
    await expect(
      normalizeDiffViewerPayloadLanguages({
        langs: ["   " as never],
        newFile: {
          contents: "after",
          name: "after.txt",
        },
        oldFile: {
          contents: "before",
          lang: "   " as never,
          name: "before.unknown",
        },
        options: {
          backgroundEnabled: true,
          diffIndicators: "bars",
          diffStyle: "unified",
          disableLineNumbers: false,
          expandUnchanged: false,
          overflow: "wrap",
          theme: {
            dark: "pierre-dark",
            light: "pierre-light",
          },
          themeType: "dark",
          unsafeCSS: "",
        },
        prerenderedHTML: "<div>diff</div>",
      }),
    ).resolves.toMatchObject({
      langs: ["text"],
      oldFile: {
        lang: "text",
      },
    });
  });

  it("does not inject text when a valid file language is the only supported hint", async () => {
    await expect(
      normalizeDiffViewerPayloadLanguages({
        langs: [],
        newFile: {
          contents: "after",
          lang: "typescript",
          name: "after.ts",
        },
        oldFile: {
          contents: "before",
          lang: "typescript",
          name: "before.ts",
        },
        options: {
          backgroundEnabled: true,
          diffIndicators: "bars",
          diffStyle: "unified",
          disableLineNumbers: false,
          expandUnchanged: false,
          overflow: "wrap",
          theme: {
            dark: "pierre-dark",
            light: "pierre-light",
          },
          themeType: "dark",
          unsafeCSS: "",
        },
        prerenderedHTML: "<div>diff</div>",
      }),
    ).resolves.toMatchObject({
      langs: ["typescript"],
    });
  });
});
