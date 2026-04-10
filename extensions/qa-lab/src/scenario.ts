import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaBusState } from "./bus-state.js";

export interface QaScenarioStepContext {
  state: QaBusState;
}

export interface QaScenarioStep {
  name: string;
  run: (ctx: QaScenarioStepContext) => Promise<string | void>;
}

export interface QaScenarioDefinition {
  name: string;
  steps: QaScenarioStep[];
}

export interface QaScenarioStepResult {
  name: string;
  status: "pass" | "fail";
  details?: string;
}

export interface QaScenarioResult {
  name: string;
  status: "pass" | "fail";
  steps: QaScenarioStepResult[];
  details?: string;
}

export async function runQaScenario(
  definition: QaScenarioDefinition,
  ctx: QaScenarioStepContext,
): Promise<QaScenarioResult> {
  const steps: QaScenarioStepResult[] = [];

  for (const step of definition.steps) {
    try {
      const details = await step.run(ctx);
      steps.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatErrorMessage(error);
      steps.push({
        details,
        name: step.name,
        status: "fail",
      });
      return {
        details,
        name: definition.name,
        status: "fail",
        steps,
      };
    }
  }

  return {
    name: definition.name,
    status: "pass",
    steps,
  };
}
