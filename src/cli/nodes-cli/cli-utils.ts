import { defaultRuntime } from "../../runtime.js";
import { isRich, theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { unauthorizedHintForMessage } from "./rpc.js";

export function getNodesTheme() {
  const rich = isRich();
  const color = (fn: (value: string) => string) => (value: string) => (rich ? fn(value) : value);
  return {
    error: color(theme.error),
    heading: color(theme.heading),
    muted: color(theme.muted),
    ok: color(theme.success),
    rich,
    warn: color(theme.warn),
  };
}

export function runNodesCommand(label: string, action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    const { error, warn } = getNodesTheme();
    defaultRuntime.error(error(`nodes ${label} failed: ${message}`));
    const hint = unauthorizedHintForMessage(message);
    if (hint) {
      defaultRuntime.error(warn(hint));
    }
    defaultRuntime.exit(1);
  });
}
