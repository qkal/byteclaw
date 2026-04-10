import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import type { DiffScreenshotter } from "./browser.js";
import { DEFAULT_DIFFS_TOOL_DEFAULTS } from "./config.js";
import type { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness } from "./test-helpers.js";
import { createDiffsTool } from "./tool.js";
import type { DiffRenderOptions } from "./types.js";

describe("diffs tool", () => {
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness("openclaw-diffs-tool-"));
  });

  afterEach(async () => {
    await cleanupRootDir();
  });

  it("returns a viewer URL in view mode", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
    });

    const result = await tool.execute?.("tool-1", {
      after: "two\n",
      before: "one\n",
      mode: "view",
      path: "README.md",
    });

    const text = readTextContent(result, 0);
    expect(text).toContain("http://127.0.0.1:18789/plugins/diffs/view/");
    expect((result?.details as Record<string, unknown>).viewerUrl).toBeDefined();
  });

  it("uses configured viewerBaseUrl when tool input omits baseUrl", async () => {
    const tool = createDiffsTool({
      api: createApi({
        viewerBaseUrl: "https://example.com/openclaw/",
      }),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
      viewerBaseUrl: "https://example.com/openclaw",
    });

    const result = await tool.execute?.("tool-viewer-config", {
      after: "two\n",
      before: "one\n",
      mode: "view",
      path: "README.md",
    });

    expect(readTextContent(result, 0)).toContain(
      "https://example.com/openclaw/plugins/diffs/view/",
    );
    expect((result?.details as Record<string, unknown>).viewerUrl).toEqual(
      expect.stringContaining("https://example.com/openclaw/plugins/diffs/view/"),
    );
  });

  it("prefers per-call baseUrl over configured viewerBaseUrl", async () => {
    const tool = createDiffsTool({
      api: createApi({
        viewerBaseUrl: "https://example.com/openclaw",
      }),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
      viewerBaseUrl: "https://example.com/openclaw",
    });

    const result = await tool.execute?.("tool-viewer-override", {
      after: "two\n",
      baseUrl: "https://preview.example.com/review",
      before: "one\n",
      mode: "view",
      path: "README.md",
    });

    expect(readTextContent(result, 0)).toContain(
      "https://preview.example.com/review/plugins/diffs/view/",
    );
    expect((result?.details as Record<string, unknown>).viewerUrl).toEqual(
      expect.stringContaining("https://preview.example.com/review/plugins/diffs/view/"),
    );
  });

  it("does not expose reserved format in the tool schema", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
    });

    const parameters = tool.parameters as { properties?: Record<string, unknown> };
    expect(parameters.properties).toBeDefined();
    expect(parameters.properties).not.toHaveProperty("format");
  });

  it("returns an image artifact in image mode", async () => {
    const cleanupSpy = vi.spyOn(store, "scheduleCleanup");
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("../../assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image).toMatchObject({
          format: "png",
          maxWidth: 960,
          qualityPreset: "standard",
          scale: 2,
        });
      },
    });

    const tool = createToolWithScreenshotter(store, screenshotter);

    const result = await tool.execute?.("tool-2", {
      after: "two\n",
      before: "one\n",
      mode: "image",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PNG generated at:");
    expect(readTextContent(result, 0)).toContain("Use the `message` tool");
    expect(result?.content).toHaveLength(1);
    expect((result?.details as Record<string, unknown>).filePath).toBeDefined();
    expect((result?.details as Record<string, unknown>).imagePath).toBeDefined();
    expect((result?.details as Record<string, unknown>).format).toBe("png");
    expect((result?.details as Record<string, unknown>).fileQuality).toBe("standard");
    expect((result?.details as Record<string, unknown>).imageQuality).toBe("standard");
    expect((result?.details as Record<string, unknown>).fileScale).toBe(2);
    expect((result?.details as Record<string, unknown>).imageScale).toBe(2);
    expect((result?.details as Record<string, unknown>).fileMaxWidth).toBe(960);
    expect((result?.details as Record<string, unknown>).imageMaxWidth).toBe(960);
    expect((result?.details as Record<string, unknown>).viewerUrl).toBeUndefined();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("renders PDF output when fileFormat is pdf", async () => {
    const screenshotter = createPdfScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.pdf$/);
      },
    });

    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter,
      store,
    });

    const result = await tool.execute?.("tool-2b", {
      after: "two\n",
      before: "one\n",
      fileFormat: "pdf",
      mode: "image",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PDF generated at:");
    expect((result?.details as Record<string, unknown>).format).toBe("pdf");
    expect((result?.details as Record<string, unknown>).filePath).toMatch(/preview\.pdf$/);
  });

  it("accepts mode=file as an alias for file artifact rendering", async () => {
    const screenshotter = createPngScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.png$/);
      },
    });

    const tool = createToolWithScreenshotter(store, screenshotter);

    const result = await tool.execute?.("tool-2c", {
      after: "two\n",
      before: "one\n",
      mode: "file",
    });

    expectArtifactOnlyFileResult(screenshotter, result);
    expect((result?.details as Record<string, unknown>).artifactId).toEqual(expect.any(String));
    expect((result?.details as Record<string, unknown>).expiresAt).toEqual(expect.any(String));
  });

  it("honors ttlSeconds for artifact-only file output", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    try {
      const screenshotter = createPngScreenshotter();
      const tool = createToolWithScreenshotter(store, screenshotter);

      const result = await tool.execute?.("tool-2c-ttl", {
        after: "two\n",
        before: "one\n",
        mode: "file",
        ttlSeconds: 1,
      });
      const filePath = (result?.details as Record<string, unknown>).filePath as string;
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      vi.setSystemTime(new Date(now.getTime() + 2000));
      await store.cleanupExpired();
      await expect(fs.stat(filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts image* tool options for backward compatibility", async () => {
    const screenshotter = createPngScreenshotter({
      assertImage: (image) => {
        expect(image).toMatchObject({
          maxWidth: 1100,
          qualityPreset: "hq",
          scale: 2.4,
        });
      },
    });

    const tool = createToolWithScreenshotter(store, screenshotter);

    const result = await tool.execute?.("tool-2legacy", {
      after: "two\n",
      before: "one\n",
      imageMaxWidth: 1100,
      imageQuality: "hq",
      imageScale: 2.4,
      mode: "file",
    });

    expect((result?.details as Record<string, unknown>).fileQuality).toBe("hq");
    expect((result?.details as Record<string, unknown>).fileScale).toBe(2.4);
    expect((result?.details as Record<string, unknown>).fileMaxWidth).toBe(1100);
  });

  it("accepts deprecated format alias for fileFormat", async () => {
    const screenshotter = createPdfScreenshotter();

    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter,
      store,
    });

    const result = await tool.execute?.("tool-2format", {
      after: "two\n",
      before: "one\n",
      format: "pdf",
      mode: "file",
    });

    expect((result?.details as Record<string, unknown>).fileFormat).toBe("pdf");
    expect((result?.details as Record<string, unknown>).filePath).toMatch(/preview\.pdf$/);
  });

  it("honors defaults.mode=file when mode is omitted", async () => {
    const screenshotter = createPngScreenshotter();
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      mode: "file",
    });

    const result = await tool.execute?.("tool-2d", {
      after: "two\n",
      before: "one\n",
    });

    expectArtifactOnlyFileResult(screenshotter, result);
  });

  it("falls back to view output when both mode cannot render an image", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter: {
        screenshotHtml: vi.fn(async () => {
          throw new Error("browser missing");
        }),
      },
      store,
    });

    const result = await tool.execute?.("tool-3", {
      after: "two\n",
      before: "one\n",
      mode: "both",
    });

    expect(result?.content).toHaveLength(1);
    expect(readTextContent(result, 0)).toContain("File rendering failed");
    expect((result?.details as Record<string, unknown>).fileError).toBe("browser missing");
    expect((result?.details as Record<string, unknown>).imageError).toBe("browser missing");
  });

  it("rejects invalid base URLs as tool input errors", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
    });

    await expect(
      tool.execute?.("tool-4", {
        after: "two\n",
        baseUrl: "javascript:alert(1)",
        before: "one\n",
        mode: "view",
      }),
    ).rejects.toThrow("Invalid baseUrl");
  });

  it("rejects oversized patch payloads", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
    });

    await expect(
      tool.execute?.("tool-oversize-patch", {
        mode: "view",
        patch: "x".repeat(2_100_000),
      }),
    ).rejects.toThrow("patch exceeds maximum size");
  });

  it("rejects oversized before/after payloads", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      store,
    });

    const large = "x".repeat(600_000);
    await expect(
      tool.execute?.("tool-oversize-before", {
        after: "ok",
        before: large,
        mode: "view",
      }),
    ).rejects.toThrow("before exceeds maximum size");
  });

  it("uses configured defaults when tool params omit them", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      context: {
        agentAccountId: "default",
        agentId: "main",
        messageChannel: "discord",
        sessionId: "session-123",
      },
      defaults: {
        ...DEFAULT_DIFFS_TOOL_DEFAULTS,
        background: false,
        fontFamily: "JetBrains Mono",
        fontSize: 17,
        layout: "split",
        mode: "view",
        theme: "light",
        wordWrap: false,
      },
      store,
    });

    const result = await tool.execute?.("tool-5", {
      after: "two\n",
      before: "one\n",
      path: "README.md",
    });

    expect(readTextContent(result, 0)).toContain("Diff viewer ready.");
    expect((result?.details as Record<string, unknown>).mode).toBe("view");
    expect((result?.details as Record<string, unknown>).context).toEqual({
      agentAccountId: "default",
      agentId: "main",
      messageChannel: "discord",
      sessionId: "session-123",
    });

    const viewerPath = String((result?.details as Record<string, unknown>).viewerPath);
    const [id] = viewerPath.split("/").filter(Boolean).slice(-2);
    const html = await store.readHtml(id);
    expect(html).toContain('body data-theme="light"');
    expect(html).toContain("--diffs-font-size: 17px;");
    expect(html).toContain("JetBrains Mono");
  });

  it("prefers explicit tool params over configured defaults", async () => {
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("../../assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image).toMatchObject({
          format: "png",
          maxWidth: 1320,
          qualityPreset: "print",
          scale: 2.75,
        });
      },
    });
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      fileMaxWidth: 1180,
      fileQuality: "hq",
      fileScale: 2.2,
      layout: "split",
      mode: "view",
      theme: "light",
    });

    const result = await tool.execute?.("tool-6", {
      after: "two\n",
      before: "one\n",
      fileMaxWidth: 1320,
      fileQuality: "print",
      fileScale: 2.75,
      layout: "unified",
      mode: "both",
      theme: "dark",
    });

    expect((result?.details as Record<string, unknown>).mode).toBe("both");
    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect((result?.details as Record<string, unknown>).format).toBe("png");
    expect((result?.details as Record<string, unknown>).fileQuality).toBe("print");
    expect((result?.details as Record<string, unknown>).fileScale).toBe(2.75);
    expect((result?.details as Record<string, unknown>).fileMaxWidth).toBe(1320);
    const viewerPath = String((result?.details as Record<string, unknown>).viewerPath);
    const [id] = viewerPath.split("/").filter(Boolean).slice(-2);
    const html = await store.readHtml(id);
    expect(html).toContain('body data-theme="dark"');
  });

  it("routes tool context into artifact details for file mode", async () => {
    const screenshotter = createPngScreenshotter();
    const tool = createToolWithScreenshotter(store, screenshotter, DEFAULT_DIFFS_TOOL_DEFAULTS, {
      agentAccountId: "work",
      agentId: "reviewer",
      messageChannel: "telegram",
      sessionId: "session-456",
    });

    const result = await tool.execute?.("tool-context-file", {
      after: "two\n",
      before: "one\n",
      mode: "file",
    });

    expect((result?.details as Record<string, unknown>).context).toEqual({
      agentAccountId: "work",
      agentId: "reviewer",
      messageChannel: "telegram",
      sessionId: "session-456",
    });
  });
});

function createApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
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
    pluginConfig,
    runtime: {} as OpenClawPluginApi["runtime"],
    source: "test",
  });
}

function createToolWithScreenshotter(
  store: DiffArtifactStore,
  screenshotter: DiffScreenshotter,
  defaults = DEFAULT_DIFFS_TOOL_DEFAULTS,
  context: OpenClawPluginToolContext | undefined = {
    agentAccountId: "default",
    agentId: "main",
    messageChannel: "discord",
    sessionId: "session-123",
  },
) {
  return createDiffsTool({
    api: createApi(),
    context,
    defaults,
    screenshotter,
    store,
  });
}

function expectArtifactOnlyFileResult(
  screenshotter: DiffScreenshotter,
  result: { details?: unknown } | null | undefined,
) {
  expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
  expect((result?.details as Record<string, unknown>).mode).toBe("file");
  expect((result?.details as Record<string, unknown>).viewerUrl).toBeUndefined();
}

function createPngScreenshotter(
  params: {
    assertHtml?: (html: string) => void;
    assertImage?: (image: DiffRenderOptions["image"]) => void;
    assertOutputPath?: (outputPath: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({
      html,
      outputPath,
      image,
    }: {
      html: string;
      outputPath: string;
      image: DiffRenderOptions["image"];
    }) => {
      params.assertHtml?.(html);
      params.assertImage?.(image);
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("png"));
      return outputPath;
    },
  );
  return {
    screenshotHtml,
  };
}

function createPdfScreenshotter(
  params: {
    assertOutputPath?: (outputPath: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({ outputPath, image }: { outputPath: string; image: DiffRenderOptions["image"] }) => {
      expect(image.format).toBe("pdf");
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("%PDF-1.7"));
      return outputPath;
    },
  );
  return { screenshotHtml };
}

function readTextContent(result: unknown, index: number): string {
  const content = (result as { content?: { type?: string; text?: string }[] } | undefined)
    ?.content;
  const entry = content?.[index];
  return entry?.type === "text" ? (entry.text ?? "") : "";
}
