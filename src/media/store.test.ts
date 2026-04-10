import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import { isPathWithinBase } from "../../test/helpers/paths.js";
import { type TempHomeEnv, createTempHomeEnv } from "../test-utils/temp-home.js";

describe("media store", () => {
  let store: typeof import("./store.js");
  let home = "";
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    ({ home } = tempHome);
    store = await import("./store.js");
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } catch {
      // Ignore cleanup failures in tests
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempStore<T>(
    fn: (store: typeof import("./store.js"), home: string) => Promise<T>,
  ): Promise<T> {
    return await fn(store, home);
  }

  async function expectOriginalFilenameCase(params: {
    filename: string;
    expected: string;
    basePath?: string;
  }) {
    await withTempStore(async (store) => {
      expect(
        store.extractOriginalFilename(`${params.basePath ?? "/path/to"}/${params.filename}`),
      ).toBe(params.expected);
    });
  }

  async function expectRetryAfterPrunedWriteCase(params: {
    segment: string;
    run: (store: typeof import("./store.js"), home: string) => Promise<{ path: string }>;
  }) {
    await withTempStore(async (store, home) => {
      const originalWriteFile = fs.writeFile.bind(fs);
      let injectedEnoent = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const [filePath] = args;
        if (
          !injectedEnoent &&
          typeof filePath === "string" &&
          filePath.includes(`${path.sep}${params.segment}${path.sep}`)
        ) {
          injectedEnoent = true;
          await fs.rm(path.dirname(filePath), { force: true, recursive: true });
          const err = new Error("missing dir") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return await originalWriteFile(...args);
      });

      const saved = await params.run(store, home);
      const savedStat = await fs.stat(saved.path);
      expect(injectedEnoent).toBe(true);
      expect(savedStat.isFile()).toBe(true);
    });
  }

  async function expectSavedOriginalFilenameCase(params: {
    originalFilename?: string;
    expectedIdPattern: RegExp;
    expectedExtractedFilename?: string;
    expectUuidOnly?: boolean;
    maxBaseNameLength?: number;
  }) {
    await withTempStore(async (store) => {
      const saved = await store.saveMediaBuffer(
        Buffer.from("test content"),
        "text/plain",
        "inbound",
        5 * 1024 * 1024,
        params.originalFilename,
      );

      expect(saved.id).toMatch(params.expectedIdPattern);
      if (params.expectedExtractedFilename) {
        expect(store.extractOriginalFilename(saved.path)).toBe(params.expectedExtractedFilename);
      }
      if (params.expectUuidOnly) {
        expect(saved.id).not.toContain("---");
      }
      if (params.maxBaseNameLength !== undefined) {
        const baseName = path.parse(saved.id).name.split("---")[0];
        expect(baseName.length).toBeLessThanOrEqual(params.maxBaseNameLength);
      }
    });
  }

  async function expectSavedSourceCase(params: {
    relativeSourcePath: string;
    contents: string | Buffer;
    expectedContentType?: string;
    expectedExtension?: string;
    mutateSource?: (filePath: string) => Promise<void>;
    assertSaved: (saved: Awaited<ReturnType<typeof store.saveMediaSource>>) => Promise<void> | void;
  }) {
    await withTempStore(async (store, home) => {
      const sourcePath = path.join(home, params.relativeSourcePath);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, params.contents);
      await params.mutateSource?.(sourcePath);
      const saved = await store.saveMediaSource(sourcePath);
      if (params.expectedContentType) {
        expect(saved.contentType).toBe(params.expectedContentType);
      }
      if (params.expectedExtension) {
        expect(path.extname(saved.path)).toBe(params.expectedExtension);
      }
      await params.assertSaved(saved);
    });
  }

  async function expectCleanedSavedSourceCase(params: {
    relativeSourcePath: string;
    contents: string | Buffer;
    expectedExtension: string;
    expectedSize: number;
  }) {
    await expectSavedSourceCase({
      assertSaved: async (saved) => {
        expect(saved.size).toBe(params.expectedSize);
        const savedStat = await fs.stat(saved.path);
        expect(savedStat.isFile()).toBe(true);
        const past = Date.now() - 10_000;
        await fs.utimes(saved.path, past / 1000, past / 1000);
        await store.cleanOldMedia(1);
        await expect(fs.stat(saved.path)).rejects.toThrow();
      },
      contents: params.contents,
      expectedExtension: params.expectedExtension,
      relativeSourcePath: params.relativeSourcePath,
    });
  }

  async function expectSavedBufferCase(params: {
    buffer: Buffer;
    contentType?: string;
    expectedContentType: string;
    expectedExtension: string;
    assertSaved?: (
      saved: Awaited<ReturnType<typeof store.saveMediaBuffer>>,
      buffer: Buffer,
    ) => Promise<void> | void;
  }) {
    await withTempStore(async (store) => {
      const saved = await store.saveMediaBuffer(params.buffer, params.contentType);
      expect(saved.contentType).toBe(params.expectedContentType);
      expect(saved.path.endsWith(params.expectedExtension)).toBe(true);
      await params.assertSaved?.(saved, params.buffer);
    });
  }

  async function expectRejectedSourceCase(params: {
    relativeSourcePath?: string;
    setupSource?: (home: string) => Promise<string>;
    expectedError: string | Record<string, unknown>;
  }) {
    await withTempStore(async (store, home) => {
      const sourcePath =
        params.setupSource !== undefined
          ? await params.setupSource(home)
          : path.join(home, params.relativeSourcePath ?? "");
      const rejection = expect(store.saveMediaSource(sourcePath)).rejects;
      if (typeof params.expectedError === "string") {
        await rejection.toThrow(params.expectedError);
        return;
      }
      await rejection.toMatchObject(params.expectedError);
    });
  }

  async function createSymlinkSource(home: string) {
    const target = path.join(home, "sensitive.txt");
    const source = path.join(
      home,
      `source-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    await fs.writeFile(target, "sensitive");
    await fs.rm(source, { force: true });
    await fs.symlink(target, source);
    return source;
  }

  async function expectCleanupBehaviorCase(params: {
    setup: (store: typeof import("./store.js")) => Promise<{
      removedFiles: string[];
      preservedFiles: string[];
      removedDirs?: string[];
      preservedDirs?: string[];
    }>;
    run: (store: typeof import("./store.js")) => Promise<void>;
  }) {
    await withTempStore(async (store) => {
      const state = await params.setup(store);
      await params.run(store);
      for (const removedFile of state.removedFiles) {
        await expect(fs.stat(removedFile)).rejects.toThrow();
      }
      for (const preservedFile of state.preservedFiles) {
        const stat = await fs.stat(preservedFile);
        expect(stat.isFile()).toBe(true);
      }
      for (const removedDir of state.removedDirs ?? []) {
        await expect(fs.stat(removedDir)).rejects.toThrow();
      }
      for (const preservedDir of state.preservedDirs ?? []) {
        const stat = await fs.stat(preservedDir);
        expect(stat.isDirectory()).toBe(true);
      }
    });
  }

  async function expectTempStoreCase(run: () => Promise<void>) {
    await run();
  }

  it.each([
    {
      name: "creates and returns media directory",
      run: async () => {
        await withTempStore(async (store, home) => {
          const dir = await store.ensureMediaDir();
          expect(isPathWithinBase(home, dir)).toBe(true);
          expect(path.normalize(dir)).toContain(`${path.sep}.openclaw${path.sep}media`);
          const stat = await fs.stat(dir);
          expect(stat.isDirectory()).toBe(true);
        });
      },
    },
    {
      name: "enforces the media size limit",
      run: async () => {
        await withTempStore(async (store) => {
          const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
          await expect(store.saveMediaBuffer(huge)).rejects.toThrow("Media exceeds 5MB limit");
        });
      },
    },
    {
      name: "retries buffer writes when cleanup prunes the target directory",
      run: async () => {
        await expectRetryAfterPrunedWriteCase({
          run: async (store) =>
            await store.saveMediaBuffer(Buffer.from("hello"), "text/plain", "race-buffer"),
          segment: "race-buffer",
        });
      },
    },
    {
      name: "retries local-source writes when cleanup prunes the target directory",
      run: async () => {
        await expectRetryAfterPrunedWriteCase({
          run: async (store, home) => {
            const srcFile = path.join(home, "tmp-src-race.txt");
            await fs.writeFile(srcFile, "local file");
            return await store.saveMediaSource(srcFile, undefined, "race-source");
          },
          segment: "race-source",
        });
      },
    },
    {
      name: "rejects directory sources with typed error code",
      run: async () => {
        await expectRejectedSourceCase({
          expectedError: { code: "not-file" },
          setupSource: async (home) => home,
        });
      },
    },
    {
      name: "cleans old media files in first-level subdirectories",
      run: async () => {
        await withTempStore(async (store) => {
          const saved = await store.saveMediaBuffer(Buffer.from("nested"), "text/plain", "inbound");
          const inboundDir = path.dirname(saved.path);
          const past = Date.now() - 10_000;
          await fs.utimes(saved.path, past / 1000, past / 1000);

          await store.cleanOldMedia(1);

          await expect(fs.stat(saved.path)).rejects.toThrow();
          const inboundStat = await fs.stat(inboundDir);
          expect(inboundStat.isDirectory()).toBe(true);
        });
      },
    },
  ] as const)("$name", async ({ run }) => {
    await expectTempStoreCase(run);
  });

  it.each([
    {
      assertSaved: async (
        saved: Awaited<ReturnType<typeof store.saveMediaBuffer>>,
        buffer: Buffer,
      ) => {
        const savedStat = await fs.stat(saved.path);
        expect(savedStat.size).toBe(buffer.length);
      },
      buffer: Buffer.from("hello"),
      contentType: "text/plain",
      expectedContentType: "text/plain",
      expectedExtension: ".txt",
      name: "saves text buffers with the expected size and extension",
    },
    {
      bufferFactory: async () =>
        await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#123456" },
        })
          .jpeg({ quality: 80 })
          .toBuffer(),
      contentType: "image/jpeg",
      expectedContentType: "image/jpeg",
      expectedExtension: ".jpg",
      name: "saves jpeg buffers with the detected extension",
    },
  ] as const)("$name", async (testCase) => {
    const buffer =
      "bufferFactory" in testCase && testCase.bufferFactory
        ? await testCase.bufferFactory()
        : testCase.buffer;
    await expectSavedBufferCase({
      buffer,
      contentType: testCase.contentType,
      expectedContentType: testCase.expectedContentType,
      expectedExtension: testCase.expectedExtension,
      ...("assertSaved" in testCase ? { assertSaved: testCase.assertSaved } : {}),
    });
  });

  it("copies local files and cleans old media", async () => {
    await expectCleanedSavedSourceCase({
      contents: "local file",
      expectedExtension: ".txt",
      expectedSize: 10,
      relativeSourcePath: "tmp-src.txt",
    });
  });

  it.runIf(process.platform !== "win32")("rejects symlink sources", async () => {
    await expectRejectedSourceCase({
      expectedError: "symlink",
      setupSource: createSymlinkSource,
    });
    await expectRejectedSourceCase({
      expectedError: { code: "invalid-path" },
      setupSource: createSymlinkSource,
    });
  });

  it.each([
    {
      name: "cleans old media files in nested subdirectories and preserves fresh siblings",
      run: async (store: typeof import("./store.js")) =>
        await store.cleanOldMedia(1000, { pruneEmptyDirs: true, recursive: true }),
      setup: async (store: typeof import("./store.js")) => {
        const oldNested = await store.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "images"),
        );
        const freshNested = await store.saveMediaBuffer(
          Buffer.from("fresh nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "docs"),
        );
        const oldFlat = await store.saveMediaBuffer(
          Buffer.from("old flat"),
          "text/plain",
          "inbound",
        );
        const past = Date.now() - 10_000;
        await fs.utimes(oldNested.path, past / 1000, past / 1000);
        await fs.utimes(oldFlat.path, past / 1000, past / 1000);
        return {
          preservedFiles: [freshNested.path],
          removedDirs: [path.dirname(oldNested.path)],
          removedFiles: [oldNested.path, oldFlat.path],
        };
      },
    },
    {
      name: "keeps nested remote-cache files during shallow cleanup",
      run: async (store: typeof import("./store.js")) => await store.cleanOldMedia(1000),
      setup: async (store: typeof import("./store.js")) => {
        const nested = await store.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "images"),
        );
        const past = Date.now() - 10_000;
        await fs.utimes(nested.path, past / 1000, past / 1000);
        return {
          preservedFiles: [nested.path],
          removedFiles: [],
        };
      },
    },
    {
      name: "prunes empty directory chains after recursive cleanup",
      run: async (store: typeof import("./store.js")) =>
        await store.cleanOldMedia(1000, { pruneEmptyDirs: true, recursive: true }),
      setup: async (store: typeof import("./store.js")) => {
        const nested = await store.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-prune", "images"),
        );
        const mediaDir = await store.ensureMediaDir();
        const sessionDir = path.dirname(path.dirname(nested.path));
        const remoteCacheDir = path.dirname(sessionDir);
        const past = Date.now() - 10_000;
        await fs.utimes(nested.path, past / 1000, past / 1000);
        return {
          preservedDirs: [remoteCacheDir, mediaDir],
          preservedFiles: [],
          removedDirs: [sessionDir],
          removedFiles: [nested.path],
        };
      },
    },
  ] as const)("$name", async ({ setup, run }) => {
    await expectCleanupBehaviorCase({ run, setup });
  });

  it.runIf(process.platform !== "win32")(
    "does not follow symlinked top-level directories during recursive cleanup",
    async () => {
      await withTempStore(async (store, home) => {
        const mediaDir = await store.ensureMediaDir();
        const outsideDir = path.join(home, "outside-media");
        const outsideFile = path.join(outsideDir, "old.txt");
        const symlinkPath = path.join(mediaDir, "linked-dir");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(outsideFile, "outside");
        const past = Date.now() - 10_000;
        await fs.utimes(outsideFile, past / 1000, past / 1000);
        await fs.symlink(outsideDir, symlinkPath);

        await store.cleanOldMedia(1000, { pruneEmptyDirs: true, recursive: true });

        const outsideStat = await fs.stat(outsideFile);
        const symlinkStat = await fs.lstat(symlinkPath);
        expect(outsideStat.isFile()).toBe(true);
        expect(symlinkStat.isSymbolicLink()).toBe(true);
      });
    },
  );

  it.each([
    {
      assertSaved: async () => {},
      contents: "not really an xlsx",
      expectedContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      expectedExtension: ".xlsx",
      name: "sets correct mime for xlsx by extension",
      relativeSourcePath: "sheet.xlsx",
    },
    {
      assertSaved: async (
        saved: Awaited<ReturnType<typeof store.saveMediaSource>>,
        contents: Buffer,
      ) => {
        const buf = await fs.readFile(saved.path);
        expect(buf.equals(contents)).toBe(true);
      },
      contentsFactory: async () =>
        await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#00ff00" },
        })
          .png()
          .toBuffer(),
      expectedContentType: "image/png",
      expectedExtension: ".png",
      name: "renames media based on detected mime even when extension is wrong",
      relativeSourcePath: "image-wrong.bin",
    },
    {
      assertSaved: async () => {},
      contentsFactory: async () => {
        const zip = new JSZip();
        zip.file(
          "[Content_Types].xml",
          '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        );
        zip.file("xl/workbook.xml", "<workbook/>");
        return await zip.generateAsync({ type: "nodebuffer" });
      },
      expectedContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      expectedExtension: ".xlsx",
      name: "sniffs xlsx mime for zip buffers and renames extension",
      relativeSourcePath: "sheet.bin",
    },
  ] as const)("$name", async (testCase) => {
    const contents =
      "contentsFactory" in testCase && testCase.contentsFactory
        ? await testCase.contentsFactory()
        : testCase.contents;
    await expectSavedSourceCase({
      assertSaved: async (saved) => {
        if ("assertSaved" in testCase) {
          await testCase.assertSaved(saved, contents as Buffer);
        }
      },
      contents,
      expectedContentType: testCase.expectedContentType,
      expectedExtension: testCase.expectedExtension,
      relativeSourcePath: testCase.relativeSourcePath,
    });
  });

  it("prefers header mime extension when sniffed mime lacks mapping", async () => {
    await withTempStore(async (_store, home) => {
      vi.doMock("./mime.js", async () => {
        const actual = await vi.importActual<typeof import("./mime.js")>("./mime.js");
        return {
          ...actual,
          detectMime: vi.fn(async () => "audio/opus"),
        };
      });

      try {
        const storeWithMock = await importFreshModule<typeof import("./store.js")>(
          import.meta.url,
          "./store.js?scope=sniffed-mime-header-extension",
        );
        const saved = await storeWithMock.saveMediaBuffer(
          Buffer.from("fake-audio"),
          "audio/ogg; codecs=opus",
        );
        expect(path.extname(saved.path)).toBe(".ogg");
        expect(saved.path.startsWith(home)).toBe(true);
      } finally {
        vi.doUnmock("./mime.js");
      }
    });
  });

  describe("extractOriginalFilename", () => {
    it.each([
      {
        expected: "report.pdf",
        filename: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        name: "extracts original filename from embedded pattern",
      },
      {
        basePath: "/media/inbound",
        expected: "Document.docx",
        filename: "Document---A1B2C3D4-E5F6-7890-ABCD-EF1234567890.docx",
        name: "handles uppercase UUID pattern",
      },
      {
        basePath: "/path",
        expected: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        filename: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        name: "falls back to basename for UUID-only filenames",
      },
      {
        expected: "regular.txt",
        filename: "regular.txt",
        name: "falls back to basename for regular filenames",
      },
      {
        expected: "foo---bar.txt",
        filename: "foo---bar.txt",
        name: "falls back to basename for invalid UUID suffixes",
      },
      {
        basePath: "/media",
        expected: "报告_2024.pdf",
        filename: "报告_2024---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        name: "preserves original name with special characters",
      },
    ] as const)("$name", async ({ filename, expected, basePath }) => {
      await expectOriginalFilenameCase({ basePath, expected, filename });
    });
  });

  describe("saveMediaBuffer with originalFilename", () => {
    it.each([
      {
        expectedExtractedFilename: "report.txt",
        expectedIdPattern: /^report---[a-f0-9-]{36}\.txt$/,
        name: "embeds original filename in stored path when provided",
        originalFilename: "report.txt",
      },
      {
        expectedIdPattern: /^my_file_test---[a-f0-9-]{36}\.txt$/,
        name: "sanitizes unsafe characters in original filename",
        originalFilename: "my<file>:test.txt",
      },
      {
        expectedIdPattern: /^a+---[a-f0-9-]{36}\.txt$/,
        maxBaseNameLength: 60,
        name: "truncates long original filenames",
        originalFilename: `${"a".repeat(100)}.txt`,
      },
      {
        expectUuidOnly: true,
        expectedIdPattern: /^[a-f0-9-]{36}\.txt$/,
        name: "falls back to UUID-only when originalFilename not provided",
      },
    ] as const)("$name", async (testCase) => {
      await expectSavedOriginalFilenameCase(testCase);
    });
  });
});
