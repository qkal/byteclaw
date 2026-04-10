import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import {
  type LogTransportRecord,
  registerLogTransport,
  resetLogger,
  setLoggerOverride,
} from "../logger.js";

export function createWarnLogCapture(prefix: string) {
  const records: LogTransportRecord[] = [];
  setLoggerOverride({
    consoleLevel: "silent",
    file: path.join(resolvePreferredOpenClawTmpDir(), `${prefix}-${process.pid}-${Date.now()}.log`),
    level: "warn",
  });
  const unregister = registerLogTransport((record) => {
    records.push(record);
  });
  return {
    cleanup() {
      unregister();
      setLoggerOverride(null);
      resetLogger();
    },
    findText(needle: string): string | undefined {
      return records
        .flatMap((record) => Object.values(record))
        .filter((value): value is string => typeof value === "string")
        .find((value) => value.includes(needle));
    },
  };
}
