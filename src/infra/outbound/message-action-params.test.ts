import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  resolveAttachmentMediaPolicy,
} from "./message-action-params.js";

const cfg = {} as OpenClawConfig;
const maybeIt = process.platform === "win32" ? it.skip : it;

describe("message action media helpers", () => {
  it("prefers sandbox media policy when sandbox roots are non-blank", () => {
    expect(
      resolveAttachmentMediaPolicy({
        mediaLocalRoots: ["/tmp/a"],
        sandboxRoot: "  /tmp/workspace  ",
      }),
    ).toEqual({
      mode: "sandbox",
      sandboxRoot: "/tmp/workspace",
    });
    expect(
      resolveAttachmentMediaPolicy({
        mediaLocalRoots: ["/tmp/a"],
        sandboxRoot: "   ",
      }),
    ).toEqual({
      mediaAccess: {
        localRoots: ["/tmp/a"],
      },
      mode: "host",
    });
  });

  maybeIt("normalizes sandbox media lists and dedupes resolved workspace paths", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-list-"));
    try {
      await expect(
        normalizeSandboxMediaList({
          values: [" data:text/plain;base64,QQ== "],
        }),
      ).rejects.toThrow(/data:/i);
      await expect(
        normalizeSandboxMediaList({
          sandboxRoot: ` ${sandboxRoot} `,
          values: [" file:///workspace/assets/photo.png ", "/workspace/assets/photo.png", " "],
        }),
      ).resolves.toEqual([path.join(sandboxRoot, "assets", "photo.png")]);
    } finally {
      await fs.rm(sandboxRoot, { force: true, recursive: true });
    }
  });

  maybeIt("normalizes mediaUrl and fileUrl sandbox media params", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-alias-"));
    try {
      const args: Record<string, unknown> = {
        fileUrl: "/workspace/docs/report.pdf",
        mediaUrl: " file:///workspace/assets/photo.png ",
      };

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy: {
          mode: "sandbox",
          sandboxRoot: ` ${sandboxRoot} `,
        },
      });

      expect(args).toMatchObject({
        fileUrl: path.join(sandboxRoot, "docs", "report.pdf"),
        mediaUrl: path.join(sandboxRoot, "assets", "photo.png"),
      });
    } finally {
      await fs.rm(sandboxRoot, { force: true, recursive: true });
    }
  });

  maybeIt(
    "keeps remote HTTP mediaUrl and fileUrl aliases unchanged under sandbox normalization",
    async () => {
      const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-remote-alias-"));
      try {
        const args: Record<string, unknown> = {
          fileUrl: "https://example.com/docs/report.pdf?sig=2",
          mediaUrl: "https://example.com/assets/photo.png?sig=1",
        };

        await normalizeSandboxMediaParams({
          args,
          mediaPolicy: {
            mode: "sandbox",
            sandboxRoot,
          },
        });

        expect(args).toMatchObject({
          fileUrl: "https://example.com/docs/report.pdf?sig=2",
          mediaUrl: "https://example.com/assets/photo.png?sig=1",
        });
      } finally {
        await fs.rm(sandboxRoot, { force: true, recursive: true });
      }
    },
  );

  it("uses mediaUrl and fileUrl aliases when inferring attachment filenames", async () => {
    const mediaArgs: Record<string, unknown> = {
      mediaUrl: "https://example.com/pic.png",
    };
    await hydrateAttachmentParamsForAction({
      action: "sendAttachment",
      args: mediaArgs,
      cfg,
      channel: "slack",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(mediaArgs.filename).toBe("pic.png");

    const fileArgs: Record<string, unknown> = {
      fileUrl: "https://example.com/docs/report.pdf",
    };
    await hydrateAttachmentParamsForAction({
      action: "sendAttachment",
      args: fileArgs,
      cfg,
      channel: "slack",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });
    expect(fileArgs.filename).toBe("report.pdf");
  });

  it("falls back to extension-based attachment names for remote-host file URLs", async () => {
    const args: Record<string, unknown> = {
      media: "file://attacker/share/photo.png",
    };

    await hydrateAttachmentParamsForAction({
      action: "sendAttachment",
      args,
      cfg,
      channel: "slack",
      dryRun: true,
      mediaPolicy: { mode: "host" },
    });

    expect(args.filename).toBe("attachment");
  });
});

describe("message action sandbox media hydration", () => {
  maybeIt("rejects symlink retarget escapes after sandbox media normalization", async () => {
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-sandbox-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "msg-params-outside-"));
    try {
      const insideDir = path.join(sandboxRoot, "inside");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "note.txt"), "INSIDE_SECRET", "utf8");
      await fs.writeFile(path.join(outsideRoot, "note.txt"), "OUTSIDE_SECRET", "utf8");

      const slotLink = path.join(sandboxRoot, "slot");
      await fs.symlink(insideDir, slotLink);

      const args: Record<string, unknown> = {
        media: "slot/note.txt",
      };
      const mediaPolicy = {
        mode: "sandbox",
        sandboxRoot,
      } as const;

      await normalizeSandboxMediaParams({
        args,
        mediaPolicy,
      });

      await fs.rm(slotLink, { force: true, recursive: true });
      await fs.symlink(outsideRoot, slotLink);

      await expect(
        hydrateAttachmentParamsForAction({
          action: "sendAttachment",
          args,
          cfg,
          channel: "slack",
          mediaPolicy,
        }),
      ).rejects.toThrow(/outside workspace root|outside/i);
    } finally {
      await fs.rm(sandboxRoot, { force: true, recursive: true });
      await fs.rm(outsideRoot, { force: true, recursive: true });
    }
  });
});
