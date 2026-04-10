import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";

export const MAX_DISPATCH_WRAPPER_DEPTH = 4;

const ENV_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-c",
  "--chdir",
  "-s",
  "--split-string",
  "--default-signal",
  "--ignore-signal",
  "--block-signal",
]);
const ENV_INLINE_VALUE_PREFIXES = [
  "-u",
  "-c",
  "-s",
  "--unset=",
  "--chdir=",
  "--split-string=",
  "--default-signal=",
  "--ignore-signal=",
  "--block-signal=",
] as const;
const ENV_FLAG_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null"]);
const NICE_OPTIONS_WITH_VALUE = new Set(["-n", "--adjustment", "--priority"]);
const CAFFEINATE_OPTIONS_WITH_VALUE = new Set(["-t", "-w"]);
const STDBUF_OPTIONS_WITH_VALUE = new Set(["-i", "--input", "-o", "--output", "-e", "--error"]);
const TIME_FLAG_OPTIONS = new Set([
  "-a",
  "--append",
  "-h",
  "--help",
  "-l",
  "-p",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-V",
  "--version",
]);
const TIME_OPTIONS_WITH_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const BSD_SCRIPT_FLAG_OPTIONS = new Set(["-a", "-d", "-k", "-p", "-q", "-r"]);
const BSD_SCRIPT_OPTIONS_WITH_VALUE = new Set(["-F", "-t"]);
const SANDBOX_EXEC_OPTIONS_WITH_VALUE = new Set(["-f", "-p", "-d"]);
const TIMEOUT_FLAG_OPTIONS = new Set(["--foreground", "--preserve-status", "-v", "--verbose"]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"]);
const XCRUN_FLAG_OPTIONS = new Set([
  "-k",
  "--kill-cache",
  "-l",
  "--log",
  "-n",
  "--no-cache",
  "-r",
  "--run",
  "-v",
  "--verbose",
]);

function isArchSelectorToken(token: string): boolean {
  return /^-[A-Za-z0-9_]+$/.test(token);
}

function isKnownArchSelectorToken(token: string): boolean {
  return (
    token === "-arm64" ||
    token === "-arm64e" ||
    token === "-i386" ||
    token === "-x86_64" ||
    token === "-x86_64h"
  );
}

function isKnownArchNameToken(token: string): boolean {
  return isKnownArchSelectorToken(`-${token}`);
}

type WrapperScanDirective = "continue" | "consume-next" | "stop" | "invalid";

function withWindowsExeAliases(names: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const name of names) {
    expanded.add(name);
    expanded.add(`${name}.exe`);
  }
  return [...expanded];
}

export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function hasEnvInlineValuePrefix(lower: string): boolean {
  for (const prefix of ENV_INLINE_VALUE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function scanWrapperInvocation(
  argv: string[],
  params: {
    separators?: ReadonlySet<string>;
    onToken: (token: string, lowerToken: string) => WrapperScanDirective;
    adjustCommandIndex?: (commandIndex: number, argv: string[]) => number | null;
  },
): string[] | null {
  let idx = 1;
  let expectsOptionValue = false;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (expectsOptionValue) {
      expectsOptionValue = false;
      idx += 1;
      continue;
    }
    if (params.separators?.has(token)) {
      idx += 1;
      break;
    }
    const directive = params.onToken(token, normalizeLowercaseStringOrEmpty(token));
    if (directive === "stop") {
      break;
    }
    if (directive === "invalid") {
      return null;
    }
    if (directive === "consume-next") {
      expectsOptionValue = true;
    }
    idx += 1;
  }
  if (expectsOptionValue) {
    return null;
  }
  const commandIndex = params.adjustCommandIndex ? params.adjustCommandIndex(idx, argv) : idx;
  if (commandIndex === null || commandIndex >= argv.length) {
    return null;
  }
  return argv.slice(commandIndex);
}

export function unwrapEnvInvocation(argv: string[]): string[] | null {
  return scanWrapperInvocation(argv, {
    onToken: (token, lower) => {
      if (isEnvAssignment(token)) {
        return "continue";
      }
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      const [flag] = lower.split("=", 2);
      if (ENV_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      if (hasEnvInlineValuePrefix(lower)) {
        return "continue";
      }
      return "invalid";
    },
    separators: new Set(["--", "-"]),
  });
}

function envInvocationUsesModifiers(argv: string[]): boolean {
  let idx = 1;
  let expectsOptionValue = false;
  while (idx < argv.length) {
    const token = argv[idx]?.trim() ?? "";
    if (!token) {
      idx += 1;
      continue;
    }
    if (expectsOptionValue) {
      return true;
    }
    if (token === "--" || token === "-") {
      idx += 1;
      break;
    }
    if (isEnvAssignment(token)) {
      return true;
    }
    if (!token.startsWith("-") || token === "-") {
      break;
    }
    const lower = normalizeLowercaseStringOrEmpty(token);
    const [flag] = lower.split("=", 2);
    if (ENV_FLAG_OPTIONS.has(flag)) {
      return true;
    }
    if (ENV_OPTIONS_WITH_VALUE.has(flag)) {
      if (lower.includes("=")) {
        return true;
      }
      expectsOptionValue = true;
      idx += 1;
      continue;
    }
    if (hasEnvInlineValuePrefix(lower)) {
      return true;
    }
    return true;
  }

  return false;
}

function unwrapDashOptionInvocation(
  argv: string[],
  params: {
    onFlag: (flag: string, lowerToken: string) => WrapperScanDirective;
    adjustCommandIndex?: (commandIndex: number, argv: string[]) => number | null;
  },
): string[] | null {
  return scanWrapperInvocation(argv, {
    adjustCommandIndex: params.adjustCommandIndex,
    onToken: (token, lower) => {
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      const [flag] = lower.split("=", 2);
      return params.onFlag(flag, lower);
    },
    separators: new Set(["--"]),
  });
}

function unwrapNiceInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (/^-\d+$/.test(lower)) {
        return "continue";
      }
      if (NICE_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") || lower !== flag ? "continue" : "consume-next";
      }
      if (lower.startsWith("-n") && lower.length > 2) {
        return "continue";
      }
      return "invalid";
    },
  });
}

function unwrapCaffeinateInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (flag === "-d" || flag === "-i" || flag === "-m" || flag === "-s" || flag === "-u") {
        return "continue";
      }
      if (CAFFEINATE_OPTIONS_WITH_VALUE.has(flag)) {
        return lower !== flag || lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
  });
}

function unwrapNohupInvocation(argv: string[]): string[] | null {
  return scanWrapperInvocation(argv, {
    onToken: (token, lower) => {
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      return lower === "--help" || lower === "--version" ? "continue" : "invalid";
    },
    separators: new Set(["--"]),
  });
}

function unwrapSandboxExecInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (SANDBOX_EXEC_OPTIONS_WITH_VALUE.has(flag)) {
        return lower !== flag || lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
  });
}

function unwrapStdbufInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (!STDBUF_OPTIONS_WITH_VALUE.has(flag)) {
        return "invalid";
      }
      return lower.includes("=") ? "continue" : "consume-next";
    },
  });
}

function unwrapTimeInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    onFlag: (flag, lower) => {
      if (TIME_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (TIME_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
  });
}

function supportsScriptPositionalCommand(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "freebsd";
}

function unwrapScriptInvocation(argv: string[]): string[] | null {
  if (!supportsScriptPositionalCommand()) {
    return null;
  }
  return scanWrapperInvocation(argv, {
    adjustCommandIndex: (commandIndex, currentArgv) => {
      let sawTranscript = false;
      for (let idx = commandIndex; idx < currentArgv.length; idx += 1) {
        const token = currentArgv[idx]?.trim() ?? "";
        if (!token) {
          continue;
        }
        if (!sawTranscript) {
          sawTranscript = true;
          continue;
        }
        return idx;
      }
      return null;
    },
    onToken: (token, lower) => {
      if (!lower.startsWith("-") || lower === "-") {
        return "stop";
      }
      const [flag] = token.split("=", 2);
      if (BSD_SCRIPT_OPTIONS_WITH_VALUE.has(flag)) {
        return token.includes("=") ? "continue" : "consume-next";
      }
      if (BSD_SCRIPT_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      return "invalid";
    },
    separators: new Set(["--"]),
  });
}

function unwrapTimeoutInvocation(argv: string[]): string[] | null {
  return unwrapDashOptionInvocation(argv, {
    adjustCommandIndex: (commandIndex, currentArgv) => {
      const wrappedCommandIndex = commandIndex + 1;
      return wrappedCommandIndex < currentArgv.length ? wrappedCommandIndex : null;
    },
    onFlag: (flag, lower) => {
      if (TIMEOUT_FLAG_OPTIONS.has(flag)) {
        return "continue";
      }
      if (TIMEOUT_OPTIONS_WITH_VALUE.has(flag)) {
        return lower.includes("=") ? "continue" : "consume-next";
      }
      return "invalid";
    },
  });
}

function unwrapArchInvocation(argv: string[]): string[] | null {
  let expectsArchName = false;
  return scanWrapperInvocation(argv, {
    onToken: (token, lower) => {
      if (expectsArchName) {
        expectsArchName = false;
        return isKnownArchNameToken(lower) ? "continue" : "invalid";
      }
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      if (lower === "-32" || lower === "-64") {
        return "continue";
      }
      if (lower === "-arch") {
        expectsArchName = true;
        return "continue";
      }
      // `arch` can also mutate the launched environment, which is not transparent.
      if (lower === "-c" || lower === "-d" || lower === "-e" || lower === "-h") {
        return "invalid";
      }
      return isArchSelectorToken(token) && isKnownArchSelectorToken(lower) ? "continue" : "invalid";
    },
  });
}

function supportsArchDispatchWrapper(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

function supportsXcrunDispatchWrapper(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

function unwrapXcrunInvocation(argv: string[]): string[] | null {
  return scanWrapperInvocation(argv, {
    onToken: (token, lower) => {
      if (!token.startsWith("-") || token === "-") {
        return "stop";
      }
      if (XCRUN_FLAG_OPTIONS.has(lower)) {
        return "continue";
      }
      return "invalid";
    },
  });
}

interface DispatchWrapperSpec {
  name: string;
  unwrap?: (argv: string[], platform?: NodeJS.Platform) => string[] | null;
  transparentUsage?: boolean | ((argv: string[], platform?: NodeJS.Platform) => boolean);
}

const DISPATCH_WRAPPER_SPECS: readonly DispatchWrapperSpec[] = [
  {
    name: "arch",
    transparentUsage: (_argv, platform) => supportsArchDispatchWrapper(platform),
    unwrap: (argv, platform) =>
      supportsArchDispatchWrapper(platform) ? unwrapArchInvocation(argv) : null,
  },
  { name: "caffeinate", transparentUsage: true, unwrap: unwrapCaffeinateInvocation },
  { name: "chrt" },
  { name: "doas" },
  {
    name: "env",
    transparentUsage: (argv) => !envInvocationUsesModifiers(argv),
    unwrap: unwrapEnvInvocation,
  },
  { name: "ionice" },
  { name: "nice", transparentUsage: true, unwrap: unwrapNiceInvocation },
  { name: "nohup", transparentUsage: true, unwrap: unwrapNohupInvocation },
  { name: "sandbox-exec", transparentUsage: true, unwrap: unwrapSandboxExecInvocation },
  { name: "script", transparentUsage: true, unwrap: unwrapScriptInvocation },
  { name: "setsid" },
  { name: "stdbuf", transparentUsage: true, unwrap: unwrapStdbufInvocation },
  { name: "sudo" },
  { name: "taskset" },
  { name: "time", transparentUsage: true, unwrap: unwrapTimeInvocation },
  { name: "timeout", transparentUsage: true, unwrap: unwrapTimeoutInvocation },
  {
    name: "xcrun",
    transparentUsage: (_argv, platform) => supportsXcrunDispatchWrapper(platform),
    unwrap: (argv, platform) =>
      supportsXcrunDispatchWrapper(platform) ? unwrapXcrunInvocation(argv) : null,
  },
];

const DISPATCH_WRAPPER_SPEC_BY_NAME = new Map(
  DISPATCH_WRAPPER_SPECS.map((spec) => [spec.name, spec] as const),
);

export const DISPATCH_WRAPPER_EXECUTABLES = new Set(
  withWindowsExeAliases(DISPATCH_WRAPPER_SPECS.map((spec) => spec.name)),
);

export type DispatchWrapperUnwrapResult =
  | { kind: "not-wrapper" }
  | { kind: "blocked"; wrapper: string }
  | { kind: "unwrapped"; wrapper: string; argv: string[] };

export interface DispatchWrapperTrustPlan {
  argv: string[];
  wrappers: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
}

function blockDispatchWrapper(wrapper: string): DispatchWrapperUnwrapResult {
  return { kind: "blocked", wrapper };
}

function unwrapDispatchWrapper(
  wrapper: string,
  unwrapped: string[] | null,
): DispatchWrapperUnwrapResult {
  return unwrapped
    ? { argv: unwrapped, kind: "unwrapped", wrapper }
    : blockDispatchWrapper(wrapper);
}

export function isDispatchWrapperExecutable(token: string): boolean {
  return DISPATCH_WRAPPER_SPEC_BY_NAME.has(normalizeExecutableToken(token));
}

export function unwrapKnownDispatchWrapperInvocation(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): DispatchWrapperUnwrapResult {
  const token0 = argv[0]?.trim();
  if (!token0) {
    return { kind: "not-wrapper" };
  }
  const wrapper = normalizeExecutableToken(token0);
  const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
  if (!spec) {
    return { kind: "not-wrapper" };
  }
  return spec.unwrap
    ? unwrapDispatchWrapper(wrapper, spec.unwrap(argv, platform))
    : blockDispatchWrapper(wrapper);
}

export function unwrapDispatchWrappersForResolution(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const plan = resolveDispatchWrapperTrustPlan(argv, maxDepth, platform);
  return plan.argv;
}

function isSemanticDispatchWrapperUsage(
  wrapper: string,
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const spec = DISPATCH_WRAPPER_SPEC_BY_NAME.get(wrapper);
  if (!spec?.unwrap) {
    return true;
  }
  const {transparentUsage} = spec;
  if (typeof transparentUsage === "function") {
    return !transparentUsage(argv, platform);
  }
  return transparentUsage !== true;
}

function blockedDispatchWrapperPlan(params: {
  argv: string[];
  wrappers: string[];
  blockedWrapper: string;
}): DispatchWrapperTrustPlan {
  return {
    argv: params.argv,
    blockedWrapper: params.blockedWrapper,
    policyBlocked: true,
    wrappers: params.wrappers,
  };
}

export function resolveDispatchWrapperTrustPlan(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
  platform: NodeJS.Platform = process.platform,
): DispatchWrapperTrustPlan {
  let current = argv;
  const wrappers: string[] = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const unwrap = unwrapKnownDispatchWrapperInvocation(current, platform);
    if (unwrap.kind === "blocked") {
      return blockedDispatchWrapperPlan({
        argv: current,
        blockedWrapper: unwrap.wrapper,
        wrappers,
      });
    }
    if (unwrap.kind !== "unwrapped" || unwrap.argv.length === 0) {
      break;
    }
    wrappers.push(unwrap.wrapper);
    if (isSemanticDispatchWrapperUsage(unwrap.wrapper, current, platform)) {
      return blockedDispatchWrapperPlan({
        argv: current,
        blockedWrapper: unwrap.wrapper,
        wrappers,
      });
    }
    current = unwrap.argv;
  }
  if (wrappers.length >= maxDepth) {
    const overflow = unwrapKnownDispatchWrapperInvocation(current, platform);
    if (overflow.kind === "blocked" || overflow.kind === "unwrapped") {
      return blockedDispatchWrapperPlan({
        argv: current,
        blockedWrapper: overflow.wrapper,
        wrappers,
      });
    }
  }
  return { argv: current, policyBlocked: false, wrappers };
}

export function hasDispatchEnvManipulation(argv: string[]): boolean {
  const unwrap = unwrapKnownDispatchWrapperInvocation(argv);
  return (
    unwrap.kind === "unwrapped" && unwrap.wrapper === "env" && envInvocationUsesModifiers(argv)
  );
}
