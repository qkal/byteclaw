import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeExecutableToken } from "./exec-wrapper-resolution.js";

export interface InterpreterInlineEvalHit {
  executable: string;
  normalizedExecutable: string;
  flag: string;
  argv: string[];
}

interface PrefixFlagSpec {
  label: string;
  prefix: string;
}

interface InterpreterFlagSpec {
  names: readonly string[];
  exactFlags: ReadonlySet<string>;
  rawExactFlags?: ReadonlyMap<string, string>;
  rawPrefixFlags?: readonly PrefixFlagSpec[];
  prefixFlags?: readonly PrefixFlagSpec[];
  scanPastDoubleDash?: boolean;
}

interface PositionalInterpreterSpec {
  names: readonly string[];
  fileFlags?: ReadonlySet<string>;
  fileFlagPrefixes?: readonly string[];
  exactValueFlags?: ReadonlySet<string>;
  exactOptionalValueFlags?: ReadonlySet<string>;
  prefixValueFlags?: readonly string[];
  flag: "<command>" | "<program>";
}

const FLAG_INTERPRETER_INLINE_EVAL_SPECS: readonly InterpreterFlagSpec[] = [
  { exactFlags: new Set(["-c"]), names: ["python", "python2", "python3", "pypy", "pypy3"] },
  {
    exactFlags: new Set(["-e", "--eval", "-p", "--print"]),
    names: ["node", "nodejs", "bun", "deno"],
  },
  {
    exactFlags: new Set(["-e", "--source"]),
    names: ["awk", "gawk", "mawk", "nawk"],
    prefixFlags: [{ label: "--source", prefix: "--source=" }],
  },
  { exactFlags: new Set(["-e"]), names: ["ruby"] },
  { exactFlags: new Set(["-e", "-E"]), names: ["perl"] },
  { exactFlags: new Set(["-r"]), names: ["php"] },
  { exactFlags: new Set(["-e"]), names: ["lua"] },
  { exactFlags: new Set(["-e"]), names: ["osascript"] },
  {
    exactFlags: new Set(["-exec", "-execdir", "-ok", "-okdir"]),
    names: ["find"],
    scanPastDoubleDash: true,
  },
  {
    exactFlags: new Set(["-f", "--file", "--makefile", "--eval"]),
    names: ["make", "gmake"],
    prefixFlags: [
      { label: "-f", prefix: "-f" },
      { label: "--file", prefix: "--file=" },
      { label: "--makefile", prefix: "--makefile=" },
      { label: "--eval", prefix: "--eval=" },
    ],
    rawExactFlags: new Map([["-E", "-E"]]),
    rawPrefixFlags: [{ label: "-E", prefix: "-E" }],
  },
  {
    exactFlags: new Set(),
    names: ["sed", "gsed"],
    rawExactFlags: new Map([["-e", "-e"]]),
    rawPrefixFlags: [{ label: "-e", prefix: "-e" }],
  },
];

const POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS: readonly PositionalInterpreterSpec[] = [
  {
    exactValueFlags: new Set([
      "-f",
      "--file",
      "-F",
      "--field-separator",
      "-v",
      "--assign",
      "-i",
      "--include",
      "-l",
      "--load",
      "-W",
    ]),
    fileFlagPrefixes: ["-f", "--file="],
    fileFlags: new Set(["-f", "--file"]),
    flag: "<program>",
    names: ["awk", "gawk", "mawk", "nawk"],
    prefixValueFlags: ["-F", "--field-separator=", "-v", "--assign=", "--include=", "--load="],
  },
  {
    exactOptionalValueFlags: new Set(["--eof", "--replace"]),
    exactValueFlags: new Set([
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-E",
      "-I",
      "-L",
      "--max-lines",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
    ]),
    flag: "<command>",
    names: ["xargs"],
    prefixValueFlags: [
      "-a",
      "--arg-file=",
      "-d",
      "--delimiter=",
      "-E",
      "--eof=",
      "-I",
      "--replace=",
      "-i",
      "-L",
      "--max-lines=",
      "-l",
      "-n",
      "--max-args=",
      "-P",
      "--max-procs=",
      "-s",
      "--max-chars=",
    ],
  },
  {
    exactOptionalValueFlags: new Set(["-i", "--in-place"]),
    exactValueFlags: new Set(["-f", "--file", "-l", "--line-length"]),
    fileFlagPrefixes: ["-f", "--file="],
    fileFlags: new Set(["-f", "--file"]),
    flag: "<program>",
    names: ["sed", "gsed"],
    prefixValueFlags: ["-f", "--file=", "--in-place=", "--line-length="],
  },
];

const INTERPRETER_ALLOWLIST_NAMES = new Set(
  FLAG_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names).concat(
    POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names),
  ),
);

function findInterpreterSpec(executable: string): InterpreterFlagSpec | null {
  const normalized = normalizeExecutableToken(executable);
  for (const spec of FLAG_INTERPRETER_INLINE_EVAL_SPECS) {
    if (spec.names.includes(normalized)) {
      return spec;
    }
  }
  return null;
}

function findPositionalInterpreterSpec(executable: string): PositionalInterpreterSpec | null {
  const normalized = normalizeExecutableToken(executable);
  for (const spec of POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS) {
    if (spec.names.includes(normalized)) {
      return spec;
    }
  }
  return null;
}

function createInlineEvalHit(
  executable: string,
  argv: string[],
  flag: string,
): InterpreterInlineEvalHit {
  return {
    argv,
    executable,
    flag,
    normalizedExecutable: normalizeExecutableToken(executable),
  };
}

export function detectInterpreterInlineEvalArgv(
  argv: string[] | undefined | null,
): InterpreterInlineEvalHit | null {
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }
  const executable = argv[0]?.trim();
  if (!executable) {
    return null;
  }
  const spec = findInterpreterSpec(executable);
  if (spec) {
    for (let idx = 1; idx < argv.length; idx += 1) {
      const token = argv[idx]?.trim();
      if (!token) {
        continue;
      }
      if (token === "--") {
        if (spec.scanPastDoubleDash) {
          continue;
        }
        break;
      }
      const rawExactFlag = spec.rawExactFlags?.get(token);
      if (rawExactFlag) {
        return createInlineEvalHit(executable, argv, rawExactFlag);
      }
      const rawPrefixFlag = spec.rawPrefixFlags?.find(
        ({ prefix }) => token.startsWith(prefix) && token.length > prefix.length,
      );
      if (rawPrefixFlag) {
        return createInlineEvalHit(executable, argv, rawPrefixFlag.label);
      }
      const lower = normalizeLowercaseStringOrEmpty(token);
      if (spec.exactFlags.has(lower)) {
        return createInlineEvalHit(executable, argv, lower);
      }
      const prefixFlag = spec.prefixFlags?.find(
        ({ prefix }) => lower.startsWith(prefix) && lower.length > prefix.length,
      );
      if (prefixFlag) {
        return createInlineEvalHit(executable, argv, prefixFlag.label);
      }
    }
  }

  const positionalSpec = findPositionalInterpreterSpec(executable);
  if (!positionalSpec) {
    return null;
  }

  // These tools can execute user-provided programs once the first non-option token is reached.
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = argv[idx]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      const nextToken = argv[idx + 1]?.trim();
      if (!nextToken) {
        return null;
      }
      return createInlineEvalHit(executable, argv, positionalSpec.flag);
    }
    if (positionalSpec.fileFlags?.has(token)) {
      return null;
    }
    if (
      positionalSpec.fileFlagPrefixes?.some(
        (prefix) => token.startsWith(prefix) && token.length > prefix.length,
      )
    ) {
      return null;
    }
    if (positionalSpec.exactValueFlags?.has(token)) {
      idx += 1;
      continue;
    }
    if (positionalSpec.exactOptionalValueFlags?.has(token)) {
      continue;
    }
    if (
      positionalSpec.prefixValueFlags?.some(
        (prefix) => token.startsWith(prefix) && token.length > prefix.length,
      )
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return createInlineEvalHit(executable, argv, positionalSpec.flag);
  }
  return null;
}

export function describeInterpreterInlineEval(hit: InterpreterInlineEvalHit): string {
  if (hit.flag === "<command>") {
    return `${hit.normalizedExecutable} inline command`;
  }
  if (hit.flag === "<program>") {
    return `${hit.normalizedExecutable} inline program`;
  }
  return `${hit.normalizedExecutable} ${hit.flag}`;
}

export function isInterpreterLikeAllowlistPattern(pattern: string | undefined | null): boolean {
  const trimmed = normalizeLowercaseStringOrEmpty(pattern);
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeExecutableToken(trimmed);
  if (INTERPRETER_ALLOWLIST_NAMES.has(normalized)) {
    return true;
  }
  const basename = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
  const withoutExe = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
  const strippedWildcards = withoutExe.replace(/[*?[\]{}()]/g, "");
  return INTERPRETER_ALLOWLIST_NAMES.has(strippedWildcards);
}
