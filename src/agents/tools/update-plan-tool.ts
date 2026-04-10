import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import {
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
  describeUpdatePlanTool,
} from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, readStringParam, textResult } from "./common.js";

const PLAN_STEP_STATUSES = ["pending", "in_progress", "completed"] as const;

const UpdatePlanToolSchema = Type.Object({
  explanation: Type.Optional(
    Type.String({
      description: "Optional short note explaining what changed in the plan.",
    }),
  ),
  plan: Type.Array(
    Type.Object(
      {
        status: stringEnum(PLAN_STEP_STATUSES, {
          description: 'One of "pending", "in_progress", or "completed".',
        }),
        step: Type.String({ description: "Short plan step." }),
      },
      { additionalProperties: false },
    ),
    {
      description: "Ordered list of plan steps. At most one step may be in_progress.",
      minItems: 1,
    },
  ),
});

interface UpdatePlanStep {
  step: string;
  status: (typeof PLAN_STEP_STATUSES)[number];
}

function readPlanSteps(params: Record<string, unknown>): UpdatePlanStep[] {
  const rawPlan = params.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new ToolInputError("plan required");
  }

  const steps = rawPlan.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ToolInputError(`plan[${index}] must be an object`);
    }
    const stepParams = entry as Record<string, unknown>;
    const step = readStringParam(stepParams, "step", {
      label: `plan[${index}].step`,
      required: true,
    });
    const status = readStringParam(stepParams, "status", {
      label: `plan[${index}].status`,
      required: true,
    });
    if (!PLAN_STEP_STATUSES.includes(status as (typeof PLAN_STEP_STATUSES)[number])) {
      throw new ToolInputError(
        `plan[${index}].status must be one of ${PLAN_STEP_STATUSES.join(", ")}`,
      );
    }
    return {
      status: status as (typeof PLAN_STEP_STATUSES)[number],
      step,
    };
  });

  const inProgressCount = steps.filter((entry) => entry.status === "in_progress").length;
  if (inProgressCount > 1) {
    throw new ToolInputError("plan can contain at most one in_progress step");
  }
  return steps;
}

export function createUpdatePlanTool(): AnyAgentTool {
  return {
    description: describeUpdatePlanTool(),
    displaySummary: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      readStringParam(params, "explanation");
      readPlanSteps(params);
      return textResult("Plan updated.", {
        status: "updated" as const,
      });
    },
    label: "Update Plan",
    name: "update_plan",
    parameters: UpdatePlanToolSchema,
  };
}
