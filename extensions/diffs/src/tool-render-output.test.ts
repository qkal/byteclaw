import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi } from "../api.js";
import type { DiffScreenshotter } from "./browser.js";
import { DEFAULT_DIFFS_TOOL_DEFAULTS } from "./config.js";
import { createDiffStoreHarness } from "./test-helpers.js";

const { renderDiffDocumentMock } = vi.hoisted(() => ({
  renderDiffDocumentMock: vi.fn(),
}));

vi.mock("./render.js", () => ({
  renderDiffDocument: renderDiffDocumentMock,
}));

describe("diffs tool rendered output guards", () => {
  let createDiffsTool: typeof import("./tool.js").createDiffsTool;
  let cleanupRootDir: () => Promise<void>;
  let store: Awaited<ReturnType<typeof createDiffStoreHarness>>["store"];

  beforeAll(async () => {
    ({ createDiffsTool } = await import("./tool.js"));
  });

  beforeEach(async () => {
    renderDiffDocumentMock.mockReset();
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness(
      "openclaw-diffs-tool-render-output-",
    ));
  });

  afterEach(async () => {
    await cleanupRootDir();
  });

  it("accepts empty string image html for file output", async () => {
    renderDiffDocumentMock.mockResolvedValue({
      fileCount: 1,
      imageHtml: "",
      inputKind: "before_after",
      title: "Text diff",
    });

    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toBe("");
      },
    });

    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter,
      store,
    });

    const result = await tool.execute?.("tool-empty-image-html", {
      after: "two\n",
      before: "one\n",
      mode: "file",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect((result?.details as Record<string, unknown>).filePath).toEqual(expect.any(String));
  });
});

function createApi(): OpenClawPluginApi {
  return createTestPluginApi({
    config: {
      gateway: {
        bind: "loopback",
        port: 18_789,
      },
    },
    description: "Diffs",
    id: "diffs",
    name: "Diffs",
    runtime: {} as OpenClawPluginApi["runtime"],
    source: "test",
  });
}

function createPngScreenshotter(
  params: {
    assertHtml?: (html: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({ html, outputPath }: { html: string; outputPath: string }) => {
      params.assertHtml?.(html);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("png"));
      return outputPath;
    },
  );
  return {
    screenshotHtml,
  };
}
