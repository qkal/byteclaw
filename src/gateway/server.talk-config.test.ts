import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { withEnvAsync } from "../test-utils/env.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { validateTalkConfigResult } from "./protocol/index.js";
import { withSpeechProviders } from "./talk.test-helpers.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
interface SecretRef { source?: string; provider?: string; id?: string }
interface TalkConfigPayload {
  config?: {
    talk?: {
      provider?: string;
      providers?: Record<string, { voiceId?: string; apiKey?: string | SecretRef } | undefined>;
      resolved?: {
        provider?: string;
        config?: { voiceId?: string; apiKey?: string | SecretRef };
      };
      silenceTimeoutMs?: number;
    };
    session?: { mainKey?: string };
    ui?: { seamColor?: string };
  };
}
type TalkConfig = NonNullable<NonNullable<TalkConfigPayload["config"]>["talk"]>;
const GENERIC_TALK_PROVIDER_ID = "acme";
const GENERIC_TALK_API_ENV = "ACME_SPEECH_API_KEY";
let harness: GatewayHarness;
let talkConfigDeviceSeq = 0;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "token", token: "secret" } },
  });
});

afterAll(async () => {
  await harness.close();
});

async function createFreshOperatorDevice(scopes: string[], nonce: string) {
  const identity = loadOrCreateDeviceIdentity(
    path.join(os.tmpdir(), `openclaw-talk-config-device-${process.pid}-${talkConfigDeviceSeq++}`),
  );
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    clientId: "test",
    clientMode: "test",
    deviceId: identity.deviceId,
    nonce,
    role: "operator",
    scopes,
    signedAtMs,
    token: "secret",
  });

  return {
    id: identity.deviceId,
    nonce,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
  };
}

async function connectOperator(ws: GatewaySocket, scopes: string[]) {
  const nonce = await readConnectChallengeNonce(ws);
  expect(nonce).toBeTruthy();
  await connectOk(ws, {
    device: await createFreshOperatorDevice(scopes, String(nonce)),
    scopes,
    token: "secret",
  });
}

async function writeTalkConfig(config: {
  provider?: string;
  apiKey?: string | { source: "env" | "file" | "exec"; provider: string; id: string };
  voiceId?: string;
  silenceTimeoutMs?: number;
}) {
  const { writeConfigFile } = await import("../config/config.js");
  const providerId = config.provider ?? GENERIC_TALK_PROVIDER_ID;
  await writeConfigFile({
    talk: {
      provider: providerId,
      providers:
        config.apiKey !== undefined || config.voiceId !== undefined
          ? {
              [providerId]: {
                ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
                ...(config.voiceId !== undefined ? { voiceId: config.voiceId } : {}),
              },
            }
          : undefined,
      silenceTimeoutMs: config.silenceTimeoutMs,
    },
  });
}

async function fetchTalkConfig(
  ws: GatewaySocket,
  params?: { includeSecrets?: boolean } | Record<string, unknown>,
) {
  return rpcReq<TalkConfigPayload>(ws, "talk.config", params ?? {});
}

async function withTalkConfigConnection<T>(
  scopes: string[],
  run: (ws: GatewaySocket) => Promise<T>,
): Promise<T> {
  const ws = await harness.openWs();
  try {
    await connectOperator(ws, scopes);
    return await run(ws);
  } finally {
    ws.close();
  }
}

function expectTalkConfig(
  talk: TalkConfig | undefined,
  expected: {
    provider: string;
    voiceId?: string;
    apiKey?: string | SecretRef;
    providerApiKey?: string | SecretRef;
    resolvedApiKey?: string | SecretRef;
    silenceTimeoutMs?: number;
  },
) {
  expect(talk?.provider).toBe(expected.provider);
  expect(talk?.providers?.[expected.provider]?.voiceId).toBe(expected.voiceId);
  expect(talk?.resolved?.provider).toBe(expected.provider);
  expect(talk?.resolved?.config?.voiceId).toBe(expected.voiceId);

  if ("apiKey" in expected) {
    expect(talk?.providers?.[expected.provider]?.apiKey).toEqual(expected.apiKey);
    expect(talk?.resolved?.config?.apiKey).toEqual(expected.apiKey);
  }
  if ("providerApiKey" in expected) {
    expect(talk?.providers?.[expected.provider]?.apiKey).toEqual(expected.providerApiKey);
  }
  if ("resolvedApiKey" in expected) {
    expect(talk?.resolved?.config?.apiKey).toEqual(expected.resolvedApiKey);
  }
  if ("silenceTimeoutMs" in expected) {
    expect(talk?.silenceTimeoutMs).toBe(expected.silenceTimeoutMs);
  }
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      session: {
        mainKey: "main-test",
      },
      talk: {
        provider: GENERIC_TALK_PROVIDER_ID,
        providers: {
          [GENERIC_TALK_PROVIDER_ID]: {
            apiKey: "secret-key-abc",
            voiceId: "voice-123", // Pragma: allowlist secret
          },
        },
        silenceTimeoutMs: 1500,
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchTalkConfig(ws);
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        apiKey: "__OPENCLAW_REDACTED__",
        provider: GENERIC_TALK_PROVIDER_ID,
        silenceTimeoutMs: 1500,
        voiceId: "voice-123",
      });
      expect(res.payload?.config?.session?.mainKey).toBe("main-test");
      expect(res.payload?.config?.ui?.seamColor).toBe("#112233");
    });
  });

  it("rejects invalid talk.config params", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // Pragma: allowlist secret

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchTalkConfig(ws, { includeSecrets: "yes" });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("invalid talk.config params");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // Pragma: allowlist secret

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchTalkConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it.each([
    ["operator.talk.secrets", ["operator.read", "operator.write", "operator.talk.secrets"]],
    ["operator.admin", ["operator.read", "operator.admin"]],
  ] as const)("returns secrets for %s scope", async (_label, scopes) => {
    await writeTalkConfig({ apiKey: "secret-key-abc" }); // Pragma: allowlist secret

    await withTalkConfigConnection([...scopes], async (ws) => {
      const res = await fetchTalkConfig(ws, { includeSecrets: true });
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        apiKey: "secret-key-abc",
        provider: GENERIC_TALK_PROVIDER_ID,
      });
    });
  });

  it("returns Talk SecretRef payloads that satisfy the protocol schema", async () => {
    await writeTalkConfig({
      apiKey: {
        id: GENERIC_TALK_API_ENV,
        provider: "default",
        source: "env",
      },
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withTalkConfigConnection(
        ["operator.read", "operator.write", "operator.talk.secrets"],
        async (ws) => {
          const res = await fetchTalkConfig(ws, { includeSecrets: true });
          expect(res.ok, JSON.stringify(res.error)).toBe(true);
          expect(validateTalkConfigResult(res.payload)).toBe(true);
          const secretRef = {
            id: GENERIC_TALK_API_ENV,
            provider: "default",
            source: "env",
          } satisfies SecretRef;
          expectTalkConfig(res.payload?.config?.talk, {
            apiKey: secretRef,
            provider: GENERIC_TALK_PROVIDER_ID,
          });
        },
      );
    });
  });

  it("preserves configured Talk provider data when plugin-owned defaults exist", async () => {
    await writeTalkConfig({
      provider: GENERIC_TALK_PROVIDER_ID,
      voiceId: "voice-from-config",
    });

    await withEnvAsync({ [GENERIC_TALK_API_ENV]: "env-acme-key" }, async () => {
      await withSpeechProviders(
        [
          {
            pluginId: "acme-talk-defaults-test",
            provider: {
              id: GENERIC_TALK_PROVIDER_ID,
              isConfigured: () => true,
              label: "Acme Speech",
              resolveTalkConfig: ({ talkProviderConfig }) => ({
                ...talkProviderConfig,
                apiKey:
                  typeof process.env[GENERIC_TALK_API_ENV] === "string"
                    ? process.env[GENERIC_TALK_API_ENV]
                    : undefined,
              }),
              synthesize: async () => ({
                audioBuffer: Buffer.from([1]),
                fileExtension: ".mp3",
                outputFormat: "mp3",
                voiceCompatible: false,
              }),
            },
            source: "test",
          },
        ],
        async () => {
          await withTalkConfigConnection(["operator.read"], async (ws) => {
            const res = await fetchTalkConfig(ws);
            expect(res.ok, JSON.stringify(res.error)).toBe(true);
            expectTalkConfig(res.payload?.config?.talk, {
              provider: GENERIC_TALK_PROVIDER_ID,
              providerApiKey: undefined,
              voiceId: "voice-from-config",
            });
          });
        },
      );
    });
  });

  it("returns canonical provider talk payloads", async () => {
    await writeTalkConfig({
      provider: GENERIC_TALK_PROVIDER_ID,
      voiceId: "voice-normalized",
    });

    await withTalkConfigConnection(["operator.read"], async (ws) => {
      const res = await fetchTalkConfig(ws);
      expect(res.ok).toBe(true);
      expectTalkConfig(res.payload?.config?.talk, {
        provider: GENERIC_TALK_PROVIDER_ID,
        voiceId: "voice-normalized",
      });
    });
  });
});
