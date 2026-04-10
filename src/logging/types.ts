import type { LogLevel } from "./levels.js";

export type ConsoleStyle = "pretty" | "compact" | "json";

export interface LoggerSettings {
  level?: LogLevel;
  file?: string;
  maxFileBytes?: number;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
}
