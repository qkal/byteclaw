import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";

interface QaManualLaneParams {
  repoRoot: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  message: string;
  timeoutMs?: number;
}

function resolveManualLaneTimeoutMs(params: {
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  timeoutMs?: number;
}) {
  if (
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
  ) {
    return params.timeoutMs;
  }
  return resolveQaLiveTurnTimeoutMs(
    {
      alternateModel: params.alternateModel,
      primaryModel: params.primaryModel,
      providerMode: params.providerMode,
    },
    120_000,
    params.primaryModel,
  );
}

export async function runQaManualLane(params: QaManualLaneParams) {
  const sessionSuffix = params.primaryModel.replace(/[^a-z0-9._-]+/gi, "-");
  const lab = await startQaLabServer({
    embeddedGateway: "disabled",
    repoRoot: params.repoRoot,
  });
  const mock =
    params.providerMode === "mock-openai"
      ? await startQaMockOpenAiServer({
          host: "127.0.0.1",
          port: 0,
        })
      : null;
  const gateway = await startQaGatewayChild({
    alternateModel: params.alternateModel,
    controlUiEnabled: false,
    fastMode: params.fastMode,
    primaryModel: params.primaryModel,
    providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
    providerMode: params.providerMode,
    qaBusBaseUrl: lab.listenUrl,
    repoRoot: params.repoRoot,
    thinkingDefault: params.thinkingDefault,
  });

  const timeoutMs = resolveManualLaneTimeoutMs({
    alternateModel: params.alternateModel,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    timeoutMs: params.timeoutMs,
  });
  try {
    const started = (await gateway.call(
      "agent",
      {
        agentId: "qa",
        channel: "qa-channel",
        deliver: true,
        idempotencyKey: randomUUID(),
        message: params.message,
        replyChannel: "qa-channel",
        replyTo: "dm:qa-operator",
        sessionKey: `agent:qa:manual:${sessionSuffix}`,
        to: "dm:qa-operator",
      },
      { timeoutMs: 30_000 },
    )) as { runId?: string };

    if (!started.runId) {
      throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
    }

    const waited = (await gateway.call(
      "agent.wait",
      {
        runId: started.runId,
        timeoutMs,
      },
      { timeoutMs: timeoutMs + 5000 },
    )) as { status?: string; error?: string };

    await sleep(500);

    const reply =
      lab.state
        .getSnapshot()
        .messages.filter(
          (candidate) =>
            candidate.direction === "outbound" && candidate.conversation.id === "qa-operator",
        )
        .at(-1)?.text ?? null;

    return {
      model: params.primaryModel,
      reply,
      waited,
      watchUrl: lab.baseUrl,
    };
  } catch (error) {
    throw new Error(formatErrorMessage(error), { cause: error });
  } finally {
    await gateway.stop();
    await mock?.stop();
    await lab.stop();
  }
}
