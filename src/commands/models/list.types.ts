export interface ConfiguredEntry {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
}

export interface ModelRow {
  key: string;
  name: string;
  input: string;
  contextWindow: number | null;
  local: boolean | null;
  available: boolean | null;
  tags: string[];
  missing: boolean;
}

export interface ProviderAuthOverview {
  provider: string;
  effective: {
    kind: "profiles" | "env" | "models.json" | "missing";
    detail: string;
  };
  profiles: {
    count: number;
    oauth: number;
    token: number;
    apiKey: number;
    labels: string[];
  };
  env?: { value: string; source: string };
  modelsJson?: { value: string; source: string };
}
