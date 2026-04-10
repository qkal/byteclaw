import fs from "node:fs/promises";
import path from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { MAX_IMAGE_BYTES } from "../media/constants.js";
import {
  buildCliArgs,
  loadPromptRefImages,
  prepareCliPromptImagePayload,
  resolveCliRunQueueKey,
  writeCliImages,
  writeCliSystemPromptFile,
} from "./cli-runner/helpers.js";
import * as promptImageUtils from "./pi-embedded-runner/run/images.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
import * as toolImages from "./tool-images.js";

describe("loadPromptRefImages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty results when the prompt has no image refs", async () => {
    const loadImageFromRefSpy = vi.spyOn(promptImageUtils, "loadImageFromRef");
    const sanitizeImageBlocksSpy = vi.spyOn(toolImages, "sanitizeImageBlocks");

    await expect(
      loadPromptRefImages({
        prompt: "just text",
        workspaceDir: "/workspace",
      }),
    ).resolves.toEqual([]);

    expect(loadImageFromRefSpy).not.toHaveBeenCalled();
    expect(sanitizeImageBlocksSpy).not.toHaveBeenCalled();
  });

  it("passes the max-byte guardrail through load and sanitize", async () => {
    const loadedImage: ImageContent = {
      data: "c29tZS1pbWFnZQ==",
      mimeType: "image/png",
      type: "image",
    };
    const sanitizedImage: ImageContent = {
      data: "c2FuaXRpemVkLWltYWdl",
      mimeType: "image/jpeg",
      type: "image",
    };
    const sandbox = {
      bridge: {} as SandboxFsBridge,
      root: "/sandbox",
    };

    const loadImageFromRefSpy = vi
      .spyOn(promptImageUtils, "loadImageFromRef")
      .mockResolvedValueOnce(loadedImage);
    const sanitizeImageBlocksSpy = vi
      .spyOn(toolImages, "sanitizeImageBlocks")
      .mockResolvedValueOnce({ dropped: 0, images: [sanitizedImage] });

    const result = await loadPromptRefImages({
      prompt: "Look at /tmp/photo.png",
      sandbox,
      workspaceDir: "/workspace",
      workspaceOnly: true,
    });

    const [ref, workspaceDir, options] = loadImageFromRefSpy.mock.calls[0] ?? [];
    expect(ref).toMatchObject({ resolved: "/tmp/photo.png", type: "path" });
    expect(workspaceDir).toBe("/workspace");
    expect(options).toEqual({
      maxBytes: MAX_IMAGE_BYTES,
      sandbox,
      workspaceOnly: true,
    });
    expect(sanitizeImageBlocksSpy).toHaveBeenCalledWith([loadedImage], "prompt:images", {
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(result).toEqual([sanitizedImage]);
  });

  it("dedupes repeated refs and skips failed loads before sanitizing", async () => {
    const loadedImage: ImageContent = {
      data: "b25lLWltYWdl",
      mimeType: "image/png",
      type: "image",
    };

    const loadImageFromRefSpy = vi
      .spyOn(promptImageUtils, "loadImageFromRef")
      .mockResolvedValueOnce(loadedImage)
      .mockResolvedValueOnce(null);
    const sanitizeImageBlocksSpy = vi
      .spyOn(toolImages, "sanitizeImageBlocks")
      .mockResolvedValueOnce({ dropped: 0, images: [loadedImage] });

    const result = await loadPromptRefImages({
      prompt: "Compare /tmp/a.png with /tmp/a.png and /tmp/b.png",
      workspaceDir: "/workspace",
    });

    expect(loadImageFromRefSpy).toHaveBeenCalledTimes(2);
    expect(
      loadImageFromRefSpy.mock.calls.map(
        (call) => (call[0] as { resolved?: string } | undefined)?.resolved,
      ),
    ).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(sanitizeImageBlocksSpy).toHaveBeenCalledWith([loadedImage], "prompt:images", {
      maxBytes: MAX_IMAGE_BYTES,
    });
    expect(result).toEqual([loadedImage]);
  });
});

describe("buildCliArgs", () => {
  it("keeps passing model overrides on resumed CLI sessions", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "codex",
          modelArg: "--model",
        },
        baseArgs: ["exec", "resume", "thread-123"],
        modelId: "gpt-5.4",
        useResume: true,
      }),
    ).toEqual(["exec", "resume", "thread-123", "--model", "gpt-5.4"]);
  });

  it("strips the internal cache boundary from CLI system prompt args", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "claude",
          systemPromptArg: "--append-system-prompt",
        },
        baseArgs: ["-p"],
        modelId: "claude-sonnet-4-6",
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        useResume: false,
      }),
    ).toEqual(["-p", "--append-system-prompt", "Stable prefix\nDynamic suffix"]);
  });

  it("passes Codex system prompts via a model instructions file config override", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "codex",
          systemPromptFileConfigArg: "-c",
          systemPromptFileConfigKey: "model_instructions_file",
        },
        baseArgs: ["exec", "--json"],
        modelId: "gpt-5.4",
        systemPrompt: "Stable prefix",
        systemPromptFilePath: "/tmp/openclaw/system-prompt.md",
        useResume: false,
      }),
    ).toEqual(["exec", "--json", "-c", 'model_instructions_file="/tmp/openclaw/system-prompt.md"']);
  });

  it("replaces prompt placeholders before falling back to a trailing positional prompt", () => {
    expect(
      buildCliArgs({
        backend: {
          command: "gemini",
          modelArg: "--model",
        },
        baseArgs: ["--output-format", "json", "--prompt", "{prompt}"],
        modelId: "gemini-3.1-pro-preview",
        promptArg: "describe the image",
        useResume: false,
      }),
    ).toEqual([
      "--output-format",
      "json",
      "--prompt",
      "describe the image",
      "--model",
      "gemini-3.1-pro-preview",
    ]);
  });
});

describe("writeCliImages", () => {
  it("uses stable hashed file paths so repeated image hydration reuses the same path", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-write-images-"),
    );
    const image: ImageContent = {
      data: "c29tZS1pbWFnZQ==",
      mimeType: "image/png",
      type: "image",
    };

    const first = await writeCliImages({
      backend: { command: "codex" },
      images: [image],
      workspaceDir,
    });
    const second = await writeCliImages({
      backend: { command: "codex" },
      images: [image],
      workspaceDir,
    });

    try {
      expect(first.paths).toHaveLength(1);
      expect(second.paths).toEqual(first.paths);
      expect(first.paths[0]).toContain(`${resolvePreferredOpenClawTmpDir()}/openclaw-cli-images/`);
      expect(first.paths[0]).toMatch(/\.png$/);
      await expect(fs.readFile(first.paths[0])).resolves.toEqual(Buffer.from(image.data, "base64"));
    } finally {
      await fs.rm(first.paths[0], { force: true });
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("uses the shared media extension map for image formats beyond the tiny builtin list", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-write-heic-"),
    );
    const image: ImageContent = {
      data: "aGVpYy1pbWFnZQ==",
      mimeType: "image/heic",
      type: "image",
    };

    const written = await writeCliImages({
      backend: { command: "codex" },
      images: [image],
      workspaceDir,
    });

    try {
      expect(written.paths[0]).toMatch(/\.heic$/);
    } finally {
      await fs.rm(written.paths[0], { force: true });
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("hydrates prompt media refs into codex image args through the helper seams", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-"),
    );
    const sourceImage = path.join(tempDir, "bb-image.png");
    await fs.writeFile(
      sourceImage,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
          input: "arg",
        },
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        workspaceDir: tempDir,
      });
      const argv = buildCliArgs({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
        },
        baseArgs: ["exec", "--json"],
        imagePaths: prepared.imagePaths,
        modelId: "gpt-5.4",
        useResume: false,
      });

      const imageArgIndex = argv.indexOf("--image");
      expect(imageArgIndex).toBeGreaterThanOrEqual(0);
      expect(argv[imageArgIndex + 1]).toContain("openclaw-cli-images");
      expect(argv[imageArgIndex + 1]).not.toBe(sourceImage);

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("appends hydrated prompt media refs for stdin backends through the helper seams", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-generic-"),
    );
    const sourceImage = path.join(tempDir, "claude-image.png");
    await fs.writeFile(
      sourceImage,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
        "base64",
      ),
    );

    try {
      const prompt = `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`;
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "claude",
          input: "stdin",
        },
        prompt,
        workspaceDir: tempDir,
      });
      const promptWithImages = prepared.prompt;

      expect(promptWithImages).toContain("openclaw-cli-images");
      expect(promptWithImages).toContain(prepared.imagePaths?.[0] ?? "");
      expect(promptWithImages.trimEnd().endsWith(prepared.imagePaths?.[0] ?? "")).toBe(true);

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("appends Gemini prompt refs with @-prefixed image paths", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-prompt-image-gemini-"),
    );
    const explicitImage: ImageContent = {
      data: "c29tZS1leHBsaWNpdC1pbWFnZQ==",
      mimeType: "image/png",
      type: "image",
    };

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "gemini",
          imageArg: "@",
          imagePathScope: "workspace",
          input: "arg",
        },
        images: [explicitImage],
        prompt: "What is in this image?",
        workspaceDir: tempDir,
      });

      expect(prepared.prompt).toContain("\n\n@");
      expect(prepared.prompt).toContain(prepared.imagePaths?.[0] ?? "");
      expect(prepared.prompt.trimEnd().endsWith(`@${prepared.imagePaths?.[0] ?? ""}`)).toBe(true);
      expect(prepared.imagePaths?.[0]?.startsWith(path.join(tempDir, ".openclaw-cli-images"))).toBe(
        true,
      );

      const argv = buildCliArgs({
        backend: {
          command: "gemini",
          imageArg: "@",
          imagePathScope: "workspace",
        },
        baseArgs: ["--output-format", "json", "--prompt", "{prompt}"],
        imagePaths: prepared.imagePaths,
        modelId: "gemini-3.1-pro-preview",
        promptArg: prepared.prompt,
        useResume: false,
      });

      expect(argv).toEqual(["--output-format", "json", "--prompt", prepared.prompt]);

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("prefers explicit images over prompt refs through the helper seams", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-explicit-images-"),
    );
    const sourceImage = path.join(tempDir, "ignored-prompt-image.png");
    await fs.writeFile(
      sourceImage,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const explicitImage: ImageContent = {
      data: "c29tZS1leHBsaWNpdC1pbWFnZQ==",
      mimeType: "image/png",
      type: "image",
    };

    try {
      const prepared = await prepareCliPromptImagePayload({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
          input: "arg",
        },
        images: [explicitImage],
        prompt: `[media attached: ${sourceImage} (image/png)]\n\n<media:image>`,
        workspaceDir: tempDir,
      });
      const argv = buildCliArgs({
        backend: {
          command: "codex",
          imageArg: "--image",
          imageMode: "repeat",
        },
        baseArgs: ["exec", "--json"],
        imagePaths: prepared.imagePaths,
        modelId: "gpt-5.4",
        useResume: false,
      });

      expect(argv.filter((arg) => arg === "--image")).toHaveLength(1);
      expect(argv[argv.indexOf("--image") + 1]).toContain("openclaw-cli-images");
      await expect(fs.readFile(prepared.imagePaths?.[0] ?? "")).resolves.toEqual(
        Buffer.from(explicitImage.data, "base64"),
      );

      await prepared.cleanupImages?.();
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });
});

describe("writeCliSystemPromptFile", () => {
  it("writes stripped system prompts to a private temp file", async () => {
    const written = await writeCliSystemPromptFile({
      backend: {
        command: "codex",
        systemPromptFileConfigKey: "model_instructions_file",
      },
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
    });

    try {
      expect(written.filePath).toContain("openclaw-cli-system-prompt-");
      await expect(fs.readFile(written.filePath ?? "", "utf8")).resolves.toBe(
        "Stable prefix\nDynamic suffix",
      );
    } finally {
      await written.cleanup();
    }
    await expect(fs.access(written.filePath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("resolveCliRunQueueKey", () => {
  it("scopes Claude CLI serialization to the workspace for fresh runs", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        runId: "run-1",
        serialize: true,
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:workspace:/tmp/project-a");
  });

  it("scopes Claude CLI serialization to the resumed CLI session id", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        cliSessionId: "claude-session-123",
        runId: "run-2",
        serialize: true,
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:session:claude-session-123");
  });

  it("keeps non-Claude backends on the provider lane when serialized", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "codex-cli",
        cliSessionId: "thread-123",
        runId: "run-3",
        serialize: true,
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("codex-cli");
  });

  it("disables serialization when serialize=false", () => {
    expect(
      resolveCliRunQueueKey({
        backendId: "claude-cli",
        runId: "run-4",
        serialize: false,
        workspaceDir: "/tmp/project-a",
      }),
    ).toBe("claude-cli:run-4");
  });
});
