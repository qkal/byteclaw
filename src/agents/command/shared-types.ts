export interface AgentStreamParams {
  /** Provider stream params override (best-effort). */
  temperature?: number;
  maxTokens?: number;
  /** Provider fast-mode override (best-effort). */
  fastMode?: boolean;
}

// Simplified tool definition for client-provided tools (OpenResponses hosted tools)
export interface ClientToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** Strict argument enforcement (Responses API). Propagated from the request. */
    strict?: boolean;
  };
}
