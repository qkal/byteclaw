import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

const defaultTools = createOpenClawCodingTools({ senderIsOwner: true });

describe("createOpenClawCodingTools", () => {
  it("preserves action enums in normalized schemas", () => {
    const toolNames = ["canvas", "nodes", "cron", "gateway", "message"];
    const missingNames = toolNames.filter(
      (name) => !defaultTools.some((candidate) => candidate.name === name),
    );
    expect(missingNames).toEqual([]);

    const collectActionValues = (schema: unknown, values: Set<string>): void => {
      if (!schema || typeof schema !== "object") {
        return;
      }
      const record = schema as Record<string, unknown>;
      if (typeof record.const === "string") {
        values.add(record.const);
      }
      if (Array.isArray(record.enum)) {
        for (const value of record.enum) {
          if (typeof value === "string") {
            values.add(value);
          }
        }
      }
      if (Array.isArray(record.anyOf)) {
        for (const variant of record.anyOf) {
          collectActionValues(variant, values);
        }
      }
    };

    for (const name of toolNames) {
      const tool = defaultTools.find((candidate) => candidate.name === name);
      const parameters = tool?.parameters as {
        properties?: Record<string, unknown>;
      };
      const action = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const values = new Set<string>();
      collectActionValues(action, values);

      const min =
        name === "gateway"
          ? 1
          : // Most tools expose multiple actions; keep this signal so schemas stay useful to models.
            2;
      expect(values.size).toBeGreaterThanOrEqual(min);
    }
  });
  it("enforces apply_patch availability and canonical names across model/provider constraints", () => {
    expect(defaultTools.some((tool) => tool.name === "exec")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "process")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const openAiTools = createOpenClawCodingTools({
      modelId: "gpt-5.4",
      modelProvider: "openai",
    });
    expect(openAiTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const codexTools = createOpenClawCodingTools({
      modelId: "gpt-5.4",
      modelProvider: "openai-codex",
    });
    expect(codexTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const disabledConfig: OpenClawConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: false },
        },
      },
    };
    const disabledOpenAiTools = createOpenClawCodingTools({
      config: disabledConfig,
      modelId: "gpt-5.4",
      modelProvider: "openai",
    });
    expect(disabledOpenAiTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const anthropicTools = createOpenClawCodingTools({
      config: disabledConfig,
      modelId: "claude-opus-4-6",
      modelProvider: "anthropic",
    });
    expect(anthropicTools.some((tool) => tool.name === "apply_patch")).toBe(false);

    const allowModelsConfig: OpenClawConfig = {
      tools: {
        exec: {
          applyPatch: { allowModels: ["gpt-5.4"] },
        },
      },
    };
    const allowed = createOpenClawCodingTools({
      config: allowModelsConfig,
      modelId: "gpt-5.4",
      modelProvider: "openai",
    });
    expect(allowed.some((tool) => tool.name === "apply_patch")).toBe(true);

    const denied = createOpenClawCodingTools({
      config: allowModelsConfig,
      modelId: "gpt-5.4-mini",
      modelProvider: "openai",
    });
    expect(denied.some((tool) => tool.name === "apply_patch")).toBe(false);

    const oauthTools = createOpenClawCodingTools({
      modelAuthMode: "oauth",
      modelProvider: "anthropic",
    });
    const names = new Set(oauthTools.map((tool) => tool.name));
    expect(names.has("exec")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });
  it("provides top-level object schemas for all tools", () => {
    const tools = createOpenClawCodingTools();
    const offenders = tools
      .map((tool) => {
        const schema =
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : null;
        return {
          keys: schema ? Object.keys(schema).toSorted() : null,
          name: tool.name,
          type: schema?.type,
        };
      })
      .filter((entry) => entry.type !== "object");

    expect(offenders).toEqual([]);
  });
});
