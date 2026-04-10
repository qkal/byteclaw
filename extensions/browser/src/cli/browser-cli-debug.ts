import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { runCommandWithRuntime } from "../core-api.js";
import { type BrowserParentOpts, callBrowserRequest } from "./browser-cli-shared.js";
import { danger, defaultRuntime, shortenHomePath } from "./core-api.js";

const BROWSER_DEBUG_TIMEOUT_MS = 20_000;

type BrowserRequestParams = Parameters<typeof callBrowserRequest>[1];

interface DebugContext {
  parent: BrowserParentOpts;
  profile?: string;
}

function runBrowserDebug(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

async function withDebugContext(
  cmd: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  action: (context: DebugContext) => Promise<void>,
) {
  const parent = parentOpts(cmd);
  await runBrowserDebug(() =>
    action({
      parent,
      profile: parent.browserProfile,
    }),
  );
}

function printJsonResult(parent: BrowserParentOpts, result: unknown): boolean {
  if (!parent.json) {
    return false;
  }
  defaultRuntime.writeJson(result);
  return true;
}

async function callDebugRequest<T>(
  parent: BrowserParentOpts,
  params: BrowserRequestParams,
): Promise<T> {
  return callBrowserRequest<T>(parent, params, { timeoutMs: BROWSER_DEBUG_TIMEOUT_MS });
}

function resolveProfileQuery(profile?: string) {
  return profile ? { profile } : undefined;
}

function resolveDebugQuery(params: {
  targetId?: unknown;
  clear?: unknown;
  profile?: string;
  filter?: unknown;
}) {
  return {
    clear: Boolean(params.clear),
    filter: normalizeOptionalString(params.filter),
    profile: params.profile,
    targetId: normalizeOptionalString(params.targetId),
  };
}

export function registerBrowserDebugCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("highlight")
    .description("Highlight an element by ref")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, opts, cmd) => {
      await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
        const result = await callDebugRequest(parent, {
          body: {
            ref: ref.trim(),
            targetId: normalizeOptionalString(opts.targetId),
          },
          method: "POST",
          path: "/highlight",
          query: resolveProfileQuery(profile),
        });
        if (printJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log(`highlighted ${ref.trim()}`);
      });
    });

  browser
    .command("errors")
    .description("Get recent page errors")
    .option("--clear", "Clear stored errors after reading", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
        const result = await callDebugRequest<{
          errors: { timestamp: string; name?: string; message: string }[];
        }>(parent, {
          method: "GET",
          path: "/errors",
          query: resolveDebugQuery({
            clear: opts.clear,
            profile,
            targetId: opts.targetId,
          }),
        });
        if (printJsonResult(parent, result)) {
          return;
        }
        if (!result.errors.length) {
          defaultRuntime.log("No page errors.");
          return;
        }
        defaultRuntime.log(
          result.errors
            .map((e) => `${e.timestamp} ${e.name ? `${e.name}: ` : ""}${e.message}`)
            .join("\n"),
        );
      });
    });

  browser
    .command("requests")
    .description("Get recent network requests (best-effort)")
    .option("--filter <text>", "Only show URLs that contain this substring")
    .option("--clear", "Clear stored requests after reading", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
        const result = await callDebugRequest<{
          requests: {
            timestamp: string;
            method: string;
            status?: number;
            ok?: boolean;
            url: string;
            failureText?: string;
          }[];
        }>(parent, {
          method: "GET",
          path: "/requests",
          query: resolveDebugQuery({
            clear: opts.clear,
            filter: opts.filter,
            profile,
            targetId: opts.targetId,
          }),
        });
        if (printJsonResult(parent, result)) {
          return;
        }
        if (!result.requests.length) {
          defaultRuntime.log("No requests recorded.");
          return;
        }
        defaultRuntime.log(
          result.requests
            .map((r) => {
              const status = typeof r.status === "number" ? ` ${r.status}` : "";
              const ok = r.ok === true ? " ok" : r.ok === false ? " fail" : "";
              const fail = r.failureText ? ` (${r.failureText})` : "";
              return `${r.timestamp} ${r.method}${status}${ok} ${r.url}${fail}`;
            })
            .join("\n"),
        );
      });
    });

  const trace = browser.command("trace").description("Record a Playwright trace");

  trace
    .command("start")
    .description("Start trace recording")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--no-screenshots", "Disable screenshots")
    .option("--no-snapshots", "Disable snapshots")
    .option("--sources", "Include sources (bigger traces)", false)
    .action(async (opts, cmd) => {
      await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
        const result = await callDebugRequest(parent, {
          body: {
            screenshots: Boolean(opts.screenshots),
            snapshots: Boolean(opts.snapshots),
            sources: Boolean(opts.sources),
            targetId: normalizeOptionalString(opts.targetId),
          },
          method: "POST",
          path: "/trace/start",
          query: resolveProfileQuery(profile),
        });
        if (printJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log("trace started");
      });
    });

  trace
    .command("stop")
    .description("Stop trace recording and write a .zip")
    .option(
      "--out <path>",
      "Output path within openclaw temp dir (e.g. trace.zip or /tmp/openclaw/trace.zip)",
    )
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      await withDebugContext(cmd, parentOpts, async ({ parent, profile }) => {
        const result = await callDebugRequest<{ path: string }>(parent, {
          body: {
            path: normalizeOptionalString(opts.out),
            targetId: normalizeOptionalString(opts.targetId),
          },
          method: "POST",
          path: "/trace/stop",
          query: resolveProfileQuery(profile),
        });
        if (printJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log(`TRACE:${shortenHomePath(result.path)}`);
      });
    });
}
