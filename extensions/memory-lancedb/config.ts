import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemoryConfig {
  embedding: {
    provider: "openai";
    model: string;
    apiKey: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dreaming?: Record<string, unknown>;
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
}

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const DEFAULT_MODEL = "text-embedding-3-small";
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
const LEGACY_STATE_DIRS: string[] = [];

function resolveDefaultDbPath(): string {
  const home = homedir();
  const preferred = join(home, ".openclaw", "memory", "lancedb");
  try {
    if (fs.existsSync(preferred)) {
      return preferred;
    }
  } catch {
    // Best-effort
  }

  for (const legacy of LEGACY_STATE_DIRS) {
    const candidate = join(home, legacy, "memory", "lancedb");
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Best-effort
    }
  }

  return preferred;
}

const DEFAULT_DB_PATH = resolveDefaultDbPath();

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
};

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEmbeddingModel(embedding: Record<string, unknown>): string {
  const model = typeof embedding.model === "string" ? embedding.model : DEFAULT_MODEL;
  if (typeof embedding.dimensions !== "number") {
    vectorDimsForModel(model);
  }
  return model;
}

export const memoryConfigSchema = {
  parse(value: unknown): MemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("memory config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["embedding", "dreaming", "dbPath", "autoCapture", "autoRecall", "captureMaxChars"],
      "memory config",
    );

    const embedding = cfg.embedding as Record<string, unknown> | undefined;
    if (!embedding || typeof embedding.apiKey !== "string") {
      throw new Error("embedding.apiKey is required");
    }
    assertAllowedKeys(embedding, ["apiKey", "model", "baseUrl", "dimensions"], "embedding config");

    const model = resolveEmbeddingModel(embedding);

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    const dreaming =
      typeof cfg.dreaming === "undefined"
        ? undefined
        : cfg.dreaming && typeof cfg.dreaming === "object" && !Array.isArray(cfg.dreaming)
          ? (cfg.dreaming as Record<string, unknown>)
          : (() => {
              throw new Error("dreaming config must be an object");
            })();

    return {
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
      dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULT_DB_PATH,
      dreaming,
      embedding: {
        apiKey: resolveEnvVars(embedding.apiKey),
        baseUrl:
          typeof embedding.baseUrl === "string" ? resolveEnvVars(embedding.baseUrl) : undefined,
        dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : undefined,
        model,
        provider: "openai",
      },
    };
  },
  uiHints: {
    autoCapture: {
      help: "Automatically capture important information from conversations",
      label: "Auto-Capture",
    },
    autoRecall: {
      help: "Automatically inject relevant memories into context",
      label: "Auto-Recall",
    },
    captureMaxChars: {
      advanced: true,
      help: "Maximum message length eligible for auto-capture",
      label: "Capture Max Chars",
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
    dbPath: {
      advanced: true,
      label: "Database Path",
      placeholder: "~/.openclaw/memory/lancedb",
    },
    "embedding.apiKey": {
      help: "API key for OpenAI embeddings (or use ${OPENAI_API_KEY})",
      label: "OpenAI API Key",
      placeholder: "sk-proj-...",
      sensitive: true,
    },
    "embedding.baseUrl": {
      advanced: true,
      help: "Base URL for compatible providers (e.g. http://localhost:11434/v1)",
      label: "Base URL",
      placeholder: "https://api.openai.com/v1",
    },
    "embedding.dimensions": {
      advanced: true,
      help: "Vector dimensions for custom models (required for non-standard models)",
      label: "Dimensions",
      placeholder: "1536",
    },
    "embedding.model": {
      help: "OpenAI embedding model to use",
      label: "Embedding Model",
      placeholder: DEFAULT_MODEL,
    },
  },
};
