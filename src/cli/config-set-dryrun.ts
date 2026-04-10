export type ConfigSetDryRunInputMode = "value" | "json" | "builder";

export interface ConfigSetDryRunError {
  kind: "schema" | "resolvability";
  message: string;
  ref?: string;
}

export interface ConfigSetDryRunResult {
  ok: boolean;
  operations: number;
  configPath: string;
  inputModes: ConfigSetDryRunInputMode[];
  checks: {
    schema: boolean;
    resolvability: boolean;
    resolvabilityComplete: boolean;
  };
  refsChecked: number;
  skippedExecRefs: number;
  errors?: ConfigSetDryRunError[];
}
