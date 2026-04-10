export interface GatewayAgentIdentity {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
}

export interface GatewayAgentModel {
  primary?: string;
  fallbacks?: string[];
}

export interface GatewayAgentRow {
  id: string;
  name?: string;
  identity?: GatewayAgentIdentity;
  workspace?: string;
  model?: GatewayAgentModel;
}

export interface SessionsListResultBase<TDefaults, TRow> {
  ts: number;
  path: string;
  count: number;
  defaults: TDefaults;
  sessions: TRow[];
}

export interface SessionsPatchResultBase<TEntry> {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
}
