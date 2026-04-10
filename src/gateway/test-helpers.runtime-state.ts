import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Mock} from "vitest";
import { vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions, ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.agents.js";
import type { HooksConfig } from "../config/types.hooks.js";
import type { TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type GetReplyFromConfigFn = (
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;
export type CronIsolatedRunFn = (
  ...args: unknown[]
) => Promise<{ status: string; summary: string }>;
export type AgentCommandFn = (...args: unknown[]) => Promise<void>;
export type SendWhatsAppFn = (...args: unknown[]) => Promise<{ messageId: string; toJid: string }>;
export type RunBtwSideQuestionFn = (...args: unknown[]) => Promise<unknown>;
export type DispatchInboundMessageFn = (...args: unknown[]) => Promise<unknown>;
export type CompactEmbeddedPiSessionFn = (...args: unknown[]) => Promise<unknown>;

const GATEWAY_TEST_CONFIG_ROOT_KEY = Symbol.for("openclaw.gatewayTestHelpers.configRoot");

export interface GatewayTestHoistedState {
  testTailnetIPv4: { value: string | undefined };
  piSdkMock: {
    enabled: boolean;
    discoverCalls: number;
    models: {
      id: string;
      name?: string;
      provider: string;
      contextWindow?: number;
      reasoning?: boolean;
    }[];
  };
  cronIsolatedRun: Mock<CronIsolatedRunFn>;
  agentCommand: Mock<AgentCommandFn>;
  runBtwSideQuestion: Mock<RunBtwSideQuestionFn>;
  dispatchInboundMessage: Mock<DispatchInboundMessageFn>;
  testIsNixMode: { value: boolean };
  sessionStoreSaveDelayMs: { value: number };
  embeddedRunMock: {
    activeIds: Set<string>;
    abortCalls: string[];
    waitCalls: string[];
    waitResults: Map<string, boolean>;
    compactEmbeddedPiSession: Mock<CompactEmbeddedPiSessionFn>;
  };
  testTailscaleWhois: { value: TailscaleWhoisIdentity | null };
  getReplyFromConfig: Mock<GetReplyFromConfigFn>;
  sendWhatsAppMock: Mock<SendWhatsAppFn>;
  testState: {
    agentConfig: Record<string, unknown> | undefined;
    agentsConfig: Record<string, unknown> | undefined;
    bindingsConfig: AgentBinding[] | undefined;
    channelsConfig: Record<string, unknown> | undefined;
    sessionStorePath: string | undefined;
    sessionConfig: Record<string, unknown> | undefined;
    allowFrom: string[] | undefined;
    cronStorePath: string | undefined;
    cronEnabled: boolean | undefined;
    gatewayBind: "auto" | "lan" | "tailnet" | "loopback" | undefined;
    gatewayAuth: Record<string, unknown> | undefined;
    gatewayControlUi: Record<string, unknown> | undefined;
    hooksConfig: HooksConfig | undefined;
    canvasHostPort: number | undefined;
    legacyIssues: { path: string; message: string }[];
    legacyParsed: Record<string, unknown>;
    migrationConfig: Record<string, unknown> | null;
    migrationChanges: string[];
  };
}

const gatewayTestHoisted = vi.hoisted(() => {
  const key = Symbol.for("openclaw.gatewayTestHelpers.hoisted");
  const store = globalThis as Record<PropertyKey, unknown>;
  if (Object.hasOwn(store, key)) {
    return store[key] as GatewayTestHoistedState;
  }
  const created: GatewayTestHoistedState = {
    agentCommand: vi.fn().mockResolvedValue(undefined),
    cronIsolatedRun: vi.fn(async () => ({ status: "ok", summary: "ok" })),
    dispatchInboundMessage: vi.fn(),
    embeddedRunMock: {
      abortCalls: [],
      activeIds: new Set<string>(),
      compactEmbeddedPiSession: vi.fn().mockResolvedValue({
        compacted: true,
        ok: true,
        result: {
          firstKeptEntryId: "entry-1",
          summary: "summary",
          tokensAfter: 80,
          tokensBefore: 120,
        },
      }),
      waitCalls: [],
      waitResults: new Map<string, boolean>(),
    },
    getReplyFromConfig: vi.fn<GetReplyFromConfigFn>().mockResolvedValue(undefined),
    piSdkMock: {
      discoverCalls: 0,
      enabled: false,
      models: [],
    },
    runBtwSideQuestion: vi.fn().mockResolvedValue(undefined),
    sendWhatsAppMock: vi.fn().mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
    sessionStoreSaveDelayMs: { value: 0 },
    testIsNixMode: { value: false },
    testState: {
      agentConfig: undefined,
      agentsConfig: undefined,
      allowFrom: undefined,
      bindingsConfig: undefined,
      canvasHostPort: undefined,
      channelsConfig: undefined,
      cronEnabled: false,
      cronStorePath: undefined,
      gatewayAuth: undefined,
      gatewayBind: undefined,
      gatewayControlUi: undefined,
      hooksConfig: undefined,
      legacyIssues: [],
      legacyParsed: {},
      migrationChanges: [],
      migrationConfig: null,
      sessionConfig: undefined,
      sessionStorePath: undefined,
    },
    testTailnetIPv4: { value: undefined },
    testTailscaleWhois: { value: null },
  };
  store[key] = created;
  return created;
});

export function getGatewayTestHoistedState(): GatewayTestHoistedState {
  return gatewayTestHoisted;
}

export const {testTailnetIPv4} = gatewayTestHoisted;
export const {testTailscaleWhois} = gatewayTestHoisted;
export const {piSdkMock} = gatewayTestHoisted;
export const {cronIsolatedRun} = gatewayTestHoisted;
export const {agentCommand} = gatewayTestHoisted;
export const {runBtwSideQuestion} = gatewayTestHoisted;
export const dispatchInboundMessageMock = gatewayTestHoisted.dispatchInboundMessage;
export const {getReplyFromConfig} = gatewayTestHoisted;
export const mockGetReplyFromConfigOnce = (impl: GetReplyFromConfigFn) => {
  getReplyFromConfig.mockImplementationOnce(impl);
};
export const {sendWhatsAppMock} = gatewayTestHoisted;
export const {testState} = gatewayTestHoisted;
export const {testIsNixMode} = gatewayTestHoisted;
export const {sessionStoreSaveDelayMs} = gatewayTestHoisted;
export const {embeddedRunMock} = gatewayTestHoisted;

export const testConfigRoot = resolveGlobalSingleton(GATEWAY_TEST_CONFIG_ROOT_KEY, () => ({
  value: path.join(os.tmpdir(), `openclaw-gateway-test-${process.pid}-${crypto.randomUUID()}`),
}));

export function setTestConfigRoot(root: string): void {
  testConfigRoot.value = root;
  process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
}
