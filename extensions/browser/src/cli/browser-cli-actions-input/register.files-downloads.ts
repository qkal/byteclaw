import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { type BrowserParentOpts, callBrowserRequest } from "../browser-cli-shared.js";
import {
  DEFAULT_UPLOAD_DIR,
  danger,
  defaultRuntime,
  resolveExistingPathsWithinRoot,
  shortenHomePath,
} from "../core-api.js";
import { resolveBrowserActionContext } from "./shared.js";

async function normalizeUploadPaths(paths: string[]): Promise<string[]> {
  const result = await resolveExistingPathsWithinRoot({
    requestedPaths: paths,
    rootDir: DEFAULT_UPLOAD_DIR,
    scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.paths;
}

async function runBrowserPostAction<T>(params: {
  parent: BrowserParentOpts;
  profile: string | undefined;
  path: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  describeSuccess: (result: T) => string;
}): Promise<void> {
  try {
    const result = await callBrowserRequest<T>(
      params.parent,
      {
        body: params.body,
        method: "POST",
        path: params.path,
        query: params.profile ? { profile: params.profile } : undefined,
      },
      { timeoutMs: params.timeoutMs },
    );
    if (params.parent?.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    defaultRuntime.log(params.describeSuccess(result));
  } catch (error) {
    defaultRuntime.error(danger(String(error)));
    defaultRuntime.exit(1);
  }
}

export function registerBrowserFilesAndDownloadsCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const resolveTimeoutAndTarget = (opts: { timeoutMs?: unknown; targetId?: unknown }) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : undefined;
    const targetId = normalizeOptionalString(opts.targetId);
    return { targetId, timeoutMs };
  };

  const runDownloadCommand = async (
    cmd: Command,
    opts: { timeoutMs?: unknown; targetId?: unknown },
    request: { path: string; body: Record<string, unknown> },
  ) => {
    const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
    const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
    await runBrowserPostAction<{ download: { path: string } }>({
      body: {
        ...request.body,
        targetId,
        timeoutMs,
      },
      describeSuccess: (result) => `downloaded: ${shortenHomePath(result.download.path)}`,
      parent,
      path: request.path,
      profile,
      timeoutMs: timeoutMs ?? 20_000,
    });
  };

  browser
    .command("upload")
    .description("Arm file upload for the next file chooser")
    .argument(
      "<paths...>",
      "File paths to upload (must be within OpenClaw temp uploads dir, e.g. /tmp/openclaw/uploads/file.pdf)",
    )
    .option("--ref <ref>", "Ref id from snapshot to click after arming")
    .option("--input-ref <ref>", "Ref id for <input type=file> to set directly")
    .option("--element <selector>", "CSS selector for <input type=file>")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next file chooser (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (paths: string[], opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      const normalizedPaths = await normalizeUploadPaths(paths);
      const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
      await runBrowserPostAction({
        body: {
          element: normalizeOptionalString(opts.element),
          inputRef: normalizeOptionalString(opts.inputRef),
          paths: normalizedPaths,
          ref: normalizeOptionalString(opts.ref),
          targetId,
          timeoutMs,
        },
        describeSuccess: () => `upload armed for ${paths.length} file(s)`,
        parent,
        path: "/hooks/file-chooser",
        profile,
        timeoutMs: timeoutMs ?? 20_000,
      });
    });

  browser
    .command("waitfordownload")
    .description("Wait for the next download (and save it)")
    .argument(
      "[path]",
      "Save path within openclaw temp downloads dir (default: /tmp/openclaw/downloads/...; fallback: os.tmpdir()/openclaw/downloads/...)",
    )
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next download (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (outPath: string | undefined, opts, cmd) => {
      await runDownloadCommand(cmd, opts, {
        body: {
          path: normalizeOptionalString(outPath),
        },
        path: "/wait/download",
      });
    });

  browser
    .command("download")
    .description("Click a ref and save the resulting download")
    .argument("<ref>", "Ref id from snapshot to click")
    .argument(
      "<path>",
      "Save path within openclaw temp downloads dir (e.g. report.pdf or /tmp/openclaw/downloads/report.pdf)",
    )
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the download to start (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (ref: string, outPath: string, opts, cmd) => {
      await runDownloadCommand(cmd, opts, {
        body: {
          path: outPath,
          ref,
        },
        path: "/download",
      });
    });

  browser
    .command("dialog")
    .description("Arm the next modal dialog (alert/confirm/prompt)")
    .option("--accept", "Accept the dialog", false)
    .option("--dismiss", "Dismiss the dialog", false)
    .option("--prompt <text>", "Prompt response text")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next dialog (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      const accept = opts.accept ? true : (opts.dismiss ? false : undefined);
      if (accept === undefined) {
        defaultRuntime.error(danger("Specify --accept or --dismiss"));
        defaultRuntime.exit(1);
        return;
      }
      const { timeoutMs, targetId } = resolveTimeoutAndTarget(opts);
      await runBrowserPostAction({
        body: {
          accept,
          promptText: normalizeOptionalString(opts.prompt),
          targetId,
          timeoutMs,
        },
        describeSuccess: () => "dialog armed",
        parent,
        path: "/hooks/dialog",
        profile,
        timeoutMs: timeoutMs ?? 20_000,
      });
    });
}
