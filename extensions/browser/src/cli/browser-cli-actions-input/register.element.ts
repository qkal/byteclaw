import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { BrowserParentOpts } from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import {
  callBrowserAct,
  logBrowserActionResult,
  requireRef,
  resolveBrowserActionContext,
} from "./shared.js";

export function registerBrowserElementCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const runElementAction = async (params: {
    cmd: Command;
    body: Record<string, unknown>;
    successMessage: string | ((result: unknown) => string);
    timeoutMs?: number;
  }): Promise<void> => {
    const { parent, profile } = resolveBrowserActionContext(params.cmd, parentOpts);
    try {
      const result = await callBrowserAct({
        body: params.body,
        parent,
        profile,
        timeoutMs: params.timeoutMs,
      });
      const successMessage =
        typeof params.successMessage === "function"
          ? params.successMessage(result)
          : params.successMessage;
      logBrowserActionResult(parent, result, successMessage);
    } catch (error) {
      defaultRuntime.error(danger(String(error)));
      defaultRuntime.exit(1);
    }
  };

  browser
    .command("click")
    .description("Click an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--double", "Double click", false)
    .option("--button <left|right|middle>", "Mouse button to use")
    .option("--modifiers <list>", "Comma-separated modifiers (Shift,Alt,Meta)")
    .action(async (ref: string | undefined, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      const modifiers = opts.modifiers
        ? String(opts.modifiers)
            .split(",")
            .map((v: string) => v.trim())
            .filter(Boolean)
        : undefined;
      await runElementAction({
        body: {
          button: normalizeOptionalString(opts.button),
          doubleClick: Boolean(opts.double),
          kind: "click",
          modifiers,
          ref: refValue,
          targetId: normalizeOptionalString(opts.targetId),
        },
        cmd,
        successMessage: (result) => {
          const {url} = (result as { url?: unknown });
          const suffix = typeof url === "string" && url ? ` on ${url}` : "";
          return `clicked ref ${refValue}${suffix}`;
        },
      });
    });

  browser
    .command("type")
    .description("Type into an element by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<text>", "Text to type")
    .option("--submit", "Press Enter after typing", false)
    .option("--slowly", "Type slowly (human-like)", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string | undefined, text: string, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      await runElementAction({
        body: {
          kind: "type",
          ref: refValue,
          slowly: Boolean(opts.slowly),
          submit: Boolean(opts.submit),
          targetId: normalizeOptionalString(opts.targetId),
          text,
        },
        cmd,
        successMessage: `typed into ref ${refValue}`,
      });
    });

  browser
    .command("press")
    .description("Press a key")
    .argument("<key>", "Key to press (e.g. Enter)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (key: string, opts, cmd) => {
      await runElementAction({
        body: { key, kind: "press", targetId: normalizeOptionalString(opts.targetId) },
        cmd,
        successMessage: `pressed ${key}`,
      });
    });

  browser
    .command("hover")
    .description("Hover an element by ai ref")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, opts, cmd) => {
      await runElementAction({
        body: { kind: "hover", ref, targetId: normalizeOptionalString(opts.targetId) },
        cmd,
        successMessage: `hovered ref ${ref}`,
      });
    });

  browser
    .command("scrollintoview")
    .description("Scroll an element into view by ref from snapshot")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--timeout-ms <ms>", "How long to wait for scroll (default: 20000)", (v: string) =>
      Number(v),
    )
    .action(async (ref: string | undefined, opts, cmd) => {
      const refValue = requireRef(ref);
      if (!refValue) {
        return;
      }
      const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
      await runElementAction({
        body: {
          kind: "scrollIntoView",
          ref: refValue,
          targetId: normalizeOptionalString(opts.targetId),
          timeoutMs,
        },
        cmd,
        successMessage: `scrolled into view: ${refValue}`,
        timeoutMs,
      });
    });

  browser
    .command("drag")
    .description("Drag from one ref to another")
    .argument("<startRef>", "Start ref id")
    .argument("<endRef>", "End ref id")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (startRef: string, endRef: string, opts, cmd) => {
      await runElementAction({
        body: {
          endRef,
          kind: "drag",
          startRef,
          targetId: normalizeOptionalString(opts.targetId),
        },
        cmd,
        successMessage: `dragged ${startRef} → ${endRef}`,
      });
    });

  browser
    .command("select")
    .description("Select option(s) in a select element")
    .argument("<ref>", "Ref id from snapshot")
    .argument("<values...>", "Option values to select")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, values: string[], opts, cmd) => {
      await runElementAction({
        body: {
          kind: "select",
          ref,
          targetId: normalizeOptionalString(opts.targetId),
          values,
        },
        cmd,
        successMessage: `selected ${values.join(", ")}`,
      });
    });
}
