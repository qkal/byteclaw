import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { runBrowserResizeWithOutput } from "../browser-cli-resize.js";
import { type BrowserParentOpts, callBrowserRequest } from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import { requireRef, resolveBrowserActionContext } from "./shared.js";

export function registerBrowserNavigationCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("navigate")
    .description("Navigate the current tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (url: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserRequest<{ url?: string }>(
          parent,
          {
            body: {
              targetId: normalizeOptionalString(opts.targetId),
              url,
            },
            method: "POST",
            path: "/navigate",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 20_000 },
        );
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log(`navigated to ${result.url ?? url}`);
      } catch (error) {
        defaultRuntime.error(danger(String(error)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("resize")
    .description("Resize the viewport")
    .argument("<width>", "Viewport width", (v: string) => Number(v))
    .argument("<height>", "Viewport height", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (width: number, height: number, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        await runBrowserResizeWithOutput({
          height,
          parent,
          profile,
          successMessage: `resized to ${width}x${height}`,
          targetId: opts.targetId,
          timeoutMs: 20_000,
          width,
        });
      } catch (error) {
        defaultRuntime.error(danger(String(error)));
        defaultRuntime.exit(1);
      }
    });

  // Keep `requireRef` reachable; shared utilities are intended for other modules too.
  void requireRef;
}
