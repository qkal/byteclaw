import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import Ajv from "ajv";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  formatXHighModelHint,
  normalizeThinkLevel,
  resolvePreferredOpenClawTmpDir,
  supportsXHighThinking,
} from "../api.js";
import type { OpenClawPluginApi } from "../api.js";

const AjvCtor = Ajv as unknown as typeof import("ajv").default;

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

function collectText(payloads: { text?: string; isError?: boolean }[] | undefined): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

function toModelKey(provider?: string, model?: string): string | undefined {
  const p = provider?.trim();
  const m = model?.trim();
  if (!p || !m) {
    return undefined;
  }
  return `${p}/${m}`;
}

interface PluginCfg {
  defaultProvider?: string;
  defaultModel?: string;
  defaultAuthProfileId?: string;
  allowedModels?: string[];
  maxTokens?: number;
  timeoutMs?: number;
}

interface LlmTaskParams {
  prompt?: unknown;
  input?: unknown;
  schema?: unknown;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
  authProfileId?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  timeoutMs?: unknown;
}

const INVALID_THINKING_LEVELS_HINT =
  "off, minimal, low, medium, high, adaptive, and xhigh where supported";

export function createLlmTaskTool(api: OpenClawPluginApi) {
  return {
    description:
      "Run a generic JSON-only LLM task and return schema-validated JSON. Designed for orchestration from Lobster workflows via openclaw.invoke.",
    async execute(_id: string, params: LlmTaskParams) {
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      if (!prompt.trim()) {
        throw new Error("prompt required");
      }

      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;

      const defaultsModel = api.config?.agents?.defaults?.model;
      const primary =
        typeof defaultsModel === "string"
          ? normalizeOptionalString(defaultsModel)
          : normalizeOptionalString(defaultsModel?.primary);
      const primaryProvider = typeof primary === "string" ? primary.split("/")[0] : undefined;
      const primaryModel =
        typeof primary === "string" ? primary.split("/").slice(1).join("/") : undefined;

      const provider =
        (typeof params.provider === "string" && params.provider.trim()) ||
        (typeof pluginCfg.defaultProvider === "string" && pluginCfg.defaultProvider.trim()) ||
        primaryProvider ||
        undefined;

      const model =
        (typeof params.model === "string" && params.model.trim()) ||
        (typeof pluginCfg.defaultModel === "string" && pluginCfg.defaultModel.trim()) ||
        primaryModel ||
        undefined;

      const authProfileId =
        (typeof params.authProfileId === "string" && params.authProfileId.trim()) ||
        (typeof pluginCfg.defaultAuthProfileId === "string" &&
          pluginCfg.defaultAuthProfileId.trim()) ||
        undefined;

      const modelKey = toModelKey(provider, model);
      if (!provider || !model || !modelKey) {
        throw new Error(
          `provider/model could not be resolved (provider=${String(provider ?? "")}, model=${String(model ?? "")})`,
        );
      }

      const allowed = Array.isArray(pluginCfg.allowedModels) ? pluginCfg.allowedModels : undefined;
      if (allowed && allowed.length > 0 && !allowed.includes(modelKey)) {
        throw new Error(
          `Model not allowed by llm-task plugin config: ${modelKey}. Allowed models: ${allowed.join(", ")}`,
        );
      }

      const thinkingRaw =
        typeof params.thinking === "string" && params.thinking.trim() ? params.thinking : undefined;
      const thinkLevel = thinkingRaw ? normalizeThinkLevel(thinkingRaw) : undefined;
      if (thinkingRaw && !thinkLevel) {
        throw new Error(
          `Invalid thinking level "${thinkingRaw}". Use one of: ${INVALID_THINKING_LEVELS_HINT}.`,
        );
      }
      if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }

      const timeoutMs =
        (typeof params.timeoutMs === "number" && params.timeoutMs > 0
          ? params.timeoutMs
          : undefined) ||
        (typeof pluginCfg.timeoutMs === "number" && pluginCfg.timeoutMs > 0
          ? pluginCfg.timeoutMs
          : undefined) ||
        30_000;

      const streamParams = {
        maxTokens:
          typeof params.maxTokens === "number"
            ? params.maxTokens
            : typeof pluginCfg.maxTokens === "number"
              ? pluginCfg.maxTokens
              : undefined,
        temperature: typeof params.temperature === "number" ? params.temperature : undefined,
      };

      const { input } = params;
      let inputJson: string;
      try {
        inputJson = JSON.stringify(input ?? null, null, 2);
      } catch {
        throw new Error("input must be JSON-serializable");
      }

      const system = [
        "You are a JSON-only function.",
        "Return ONLY a valid JSON value.",
        "Do not wrap in markdown fences.",
        "Do not include commentary.",
        "Do not call tools.",
      ].join(" ");

      const fullPrompt = `${system}\n\nTASK:\n${prompt}\n\nINPUT_JSON:\n${inputJson}\n`;

      let tmpDir: string | null = null;
      try {
        tmpDir = await fs.mkdtemp(
          path.join(resolvePreferredOpenClawTmpDir(), "openclaw-llm-task-"),
        );
        const sessionId = `llm-task-${Date.now()}`;
        const sessionFile = path.join(tmpDir, "session.json");

        const result = await api.runtime.agent.runEmbeddedPiAgent({
          authProfileId,
          authProfileIdSource: authProfileId ? "user" : "auto",
          config: api.config,
          disableTools: true,
          model,
          prompt: fullPrompt,
          provider,
          runId: `llm-task-${Date.now()}`,
          sessionFile,
          sessionId,
          streamParams,
          thinkLevel,
          timeoutMs,
          workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
        });

        const text = collectText(
          typeof result === "object" && result !== null && "payloads" in result
            ? (result as { payloads?: { text?: string; isError?: boolean }[] }).payloads
            : undefined,
        );
        if (!text) {
          throw new Error("LLM returned empty output");
        }

        const raw = stripCodeFences(text);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("LLM returned invalid JSON");
        }

        const { schema } = params;
        if (schema && typeof schema === "object" && !Array.isArray(schema)) {
          const ajv = new AjvCtor({ allErrors: true, strict: false });
          const validate = ajv.compile(schema);
          const ok = validate(parsed);
          if (!ok) {
            const msg =
              validate.errors
                ?.map(
                  (e: { instancePath?: string; message?: string }) =>
                    `${e.instancePath || "<root>"} ${e.message || "invalid"}`,
                )
                .join("; ") ?? "invalid";
            throw new Error(`LLM JSON did not match schema: ${msg}`);
          }
        }

        return {
          content: [{ text: JSON.stringify(parsed, null, 2), type: "text" }],
          details: { json: parsed, model, provider },
        };
      } finally {
        if (tmpDir) {
          try {
            await fs.rm(tmpDir, { force: true, recursive: true });
          } catch {
            // Ignore
          }
        }
      }
    },
    label: "LLM Task",
    name: "llm-task",

    parameters: Type.Object({
      authProfileId: Type.Optional(Type.String({ description: "Auth profile override." })),
      input: Type.Optional(Type.Unknown({ description: "Optional input payload for the task." })),
      maxTokens: Type.Optional(Type.Number({ description: "Best-effort maxTokens override." })),
      model: Type.Optional(Type.String({ description: "Model id override." })),
      prompt: Type.String({ description: "Task instruction for the LLM." }),
      provider: Type.Optional(
        Type.String({ description: "Provider override (e.g. openai-codex, anthropic)." }),
      ),
      schema: Type.Optional(
        Type.Unknown({ description: "Optional JSON Schema to validate the returned JSON." }),
      ),
      temperature: Type.Optional(Type.Number({ description: "Best-effort temperature override." })),
      thinking: Type.Optional(Type.String({ description: "Thinking level override." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout for the LLM run." })),
    }),
  };
}
