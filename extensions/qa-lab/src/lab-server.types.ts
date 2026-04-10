import type { QaBusState } from "./bus-state.js";
import type { QaSelfCheckResult } from "./self-check.js";

export interface QaLabLatestReport {
  outputPath: string;
  markdown: string;
  generatedAt: string;
}

export type QaLabRunStatus = "idle" | "running" | "completed";

export interface QaLabScenarioStep {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
}

export interface QaLabScenarioOutcome {
  id: string;
  name: string;
  status: "pending" | "running" | "pass" | "fail" | "skip";
  details?: string;
  steps?: QaLabScenarioStep[];
  startedAt?: string;
  finishedAt?: string;
}

export interface QaLabScenarioRun {
  kind: "suite" | "self-check";
  status: QaLabRunStatus;
  startedAt?: string;
  finishedAt?: string;
  scenarios: QaLabScenarioOutcome[];
  counts: {
    total: number;
    pending: number;
    running: number;
    passed: number;
    failed: number;
    skipped: number;
  };
}

export interface QaLabServerStartParams {
  repoRoot?: string;
  host?: string;
  port?: number;
  outputPath?: string;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
  controlUiToken?: string;
  controlUiProxyTarget?: string;
  uiDistDir?: string;
  autoKickoffTarget?: string;
  embeddedGateway?: string;
  sendKickoffOnStart?: boolean;
}

export interface QaLabServerHandle {
  baseUrl: string;
  listenUrl: string;
  state: QaBusState;
  setControlUi: (next: {
    controlUiUrl?: string | null;
    controlUiToken?: string | null;
    controlUiProxyTarget?: string | null;
  }) => void;
  setScenarioRun: (next: Omit<QaLabScenarioRun, "counts"> | null) => void;
  setLatestReport: (next: QaLabLatestReport | null) => void;
  runSelfCheck: () => Promise<QaSelfCheckResult>;
  stop: () => Promise<void>;
}
