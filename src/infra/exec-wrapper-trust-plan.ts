import {
  MAX_DISPATCH_WRAPPER_DEPTH,
  resolveDispatchWrapperTrustPlan,
  unwrapKnownDispatchWrapperInvocation,
} from "./dispatch-wrapper-resolution.js";
import {
  extractShellWrapperInlineCommand,
  isShellWrapperExecutable,
  unwrapKnownShellMultiplexerInvocation,
} from "./shell-wrapper-resolution.js";

export interface ExecWrapperTrustPlan {
  argv: string[];
  policyArgv: string[];
  wrapperChain: string[];
  policyBlocked: boolean;
  blockedWrapper?: string;
  shellWrapperExecutable: boolean;
  shellInlineCommand: string | null;
}

function blockedExecWrapperTrustPlan(params: {
  argv: string[];
  policyArgv?: string[];
  wrapperChain: string[];
  blockedWrapper: string;
}): ExecWrapperTrustPlan {
  return {
    argv: params.argv,
    blockedWrapper: params.blockedWrapper,
    policyArgv: params.policyArgv ?? params.argv,
    policyBlocked: true,
    shellInlineCommand: null,
    shellWrapperExecutable: false,
    wrapperChain: params.wrapperChain,
  };
}

function finalizeExecWrapperTrustPlan(
  argv: string[],
  policyArgv: string[],
  wrapperChain: string[],
  policyBlocked: boolean,
  blockedWrapper?: string,
): ExecWrapperTrustPlan {
  const rawExecutable = argv[0]?.trim() ?? "";
  const shellWrapperExecutable =
    !policyBlocked && rawExecutable.length > 0 && isShellWrapperExecutable(rawExecutable);
  return {
    argv,
    blockedWrapper,
    policyArgv,
    policyBlocked,
    shellInlineCommand: shellWrapperExecutable ? extractShellWrapperInlineCommand(argv) : null,
    shellWrapperExecutable,
    wrapperChain,
  };
}

export function resolveExecWrapperTrustPlan(
  argv: string[],
  maxDepth = MAX_DISPATCH_WRAPPER_DEPTH,
): ExecWrapperTrustPlan {
  let current = argv;
  let policyArgv = argv;
  let sawShellMultiplexer = false;
  const wrapperChain: string[] = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const dispatchPlan = resolveDispatchWrapperTrustPlan(current, maxDepth - wrapperChain.length);
    if (dispatchPlan.policyBlocked) {
      return blockedExecWrapperTrustPlan({
        argv: dispatchPlan.argv,
        blockedWrapper: dispatchPlan.blockedWrapper ?? current[0] ?? "unknown",
        policyArgv: dispatchPlan.argv,
        wrapperChain,
      });
    }
    if (dispatchPlan.wrappers.length > 0) {
      wrapperChain.push(...dispatchPlan.wrappers);
      current = dispatchPlan.argv;
      if (!sawShellMultiplexer) {
        policyArgv = current;
      }
      if (wrapperChain.length >= maxDepth) {
        break;
      }
      continue;
    }

    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(current);
    if (shellMultiplexerUnwrap.kind === "blocked") {
      return blockedExecWrapperTrustPlan({
        argv: current,
        blockedWrapper: shellMultiplexerUnwrap.wrapper,
        policyArgv,
        wrapperChain,
      });
    }
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
      wrapperChain.push(shellMultiplexerUnwrap.wrapper);
      if (!sawShellMultiplexer) {
        // Preserve the real executable target for trust checks.
        policyArgv = current;
        sawShellMultiplexer = true;
      }
      current = shellMultiplexerUnwrap.argv;
      if (wrapperChain.length >= maxDepth) {
        break;
      }
      continue;
    }

    break;
  }

  if (wrapperChain.length >= maxDepth) {
    const dispatchOverflow = unwrapKnownDispatchWrapperInvocation(current);
    if (dispatchOverflow.kind === "blocked" || dispatchOverflow.kind === "unwrapped") {
      return blockedExecWrapperTrustPlan({
        argv: current,
        blockedWrapper: dispatchOverflow.wrapper,
        policyArgv,
        wrapperChain,
      });
    }
    const shellMultiplexerOverflow = unwrapKnownShellMultiplexerInvocation(current);
    if (
      shellMultiplexerOverflow.kind === "blocked" ||
      shellMultiplexerOverflow.kind === "unwrapped"
    ) {
      return blockedExecWrapperTrustPlan({
        argv: current,
        blockedWrapper: shellMultiplexerOverflow.wrapper,
        policyArgv,
        wrapperChain,
      });
    }
  }

  return finalizeExecWrapperTrustPlan(current, policyArgv, wrapperChain, false);
}
