export interface QaChannelActionConfig {
  messages?: boolean;
  reactions?: boolean;
  search?: boolean;
  threads?: boolean;
}

export interface QaChannelAccountConfig {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  botUserId?: string;
  botDisplayName?: string;
  pollTimeoutMs?: number;
  allowFrom?: (string | number)[];
  defaultTo?: string;
  actions?: QaChannelActionConfig;
}

export type QaChannelConfig = QaChannelAccountConfig & {
  accounts?: Record<string, Partial<QaChannelAccountConfig>>;
  defaultAccount?: string;
};

export interface CoreConfig {
  channels?: {
    "qa-channel"?: QaChannelConfig;
  };
  session?: {
    store?: string;
  };
}

export interface ResolvedQaChannelAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  botUserId: string;
  botDisplayName: string;
  pollTimeoutMs: number;
  config: QaChannelAccountConfig;
}
