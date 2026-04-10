import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

export const beforeToolCallRuntime = {
  detectToolCallLoop,
  getDiagnosticSessionState,
  logToolLoopAction,
  recordToolCall,
  recordToolCallOutcome,
};
