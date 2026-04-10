import type { ErrorShape } from "./protocol/index.js";

export interface DedupeEntry {
  ts: number;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
}
