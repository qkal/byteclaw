import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import {
  createActivityHandler,
  createMSTeamsMessageHandlerDeps,
} from "./monitor-handler.test-helpers.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return {
    ...actual,
    runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection,
  };
});

function createRuntimeStub(readAllowFromStore: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    channel: {
      debounce: {
        createInboundDebouncer: () => ({
          enqueue: async () => {},
        }),
        resolveInboundDebounceMs: () => 0,
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          agentId: "default",
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
        }),
      },
      session: {
        resolveStorePath: (storePath?: string) => storePath ?? tmpdir(),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;
}

function createDeps(params: {
  cfg: OpenClawConfig;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
}): MSTeamsMessageHandlerDeps {
  const readAllowFromStore = params.readAllowFromStore ?? vi.fn(async () => []);
  setMSTeamsRuntime(createRuntimeStub(readAllowFromStore));
  return createMSTeamsMessageHandlerDeps({
    cfg: params.cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
  });
}

function createFeedbackInvokeContext(params: {
  reaction: "like" | "dislike";
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
}): MSTeamsTurnContext {
  return {
    activity: {
      channelData: params.teamId
        ? {
            channel: params.channelName ? { name: params.channelName } : undefined,
            team: { id: params.teamId, name: "Team 1" },
          }
        : {},
      channelId: "msteams",
      conversation: {
        conversationType: params.conversationType,
        id: params.conversationId,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      from: {
        aadObjectId: params.senderId,
        id: `${params.senderId}-botframework`,
        name: params.senderName ?? "Sender",
      },
      id: `invoke-${params.reaction}`,
      name: "message/submitAction",
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      serviceUrl: "https://service.example.test",
      type: "invoke",
      value: {
        actionName: "feedback",
        actionValue: {
          feedback: JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
          reaction: params.reaction,
        },
        replyToId: "bot-msg-1",
      },
    },
    sendActivities: async () => [],
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
  } as unknown as MSTeamsTurnContext;
}

async function expectFileMissing(filePath: string) {
  await expect(access(filePath)).rejects.toThrow();
}

async function withFeedbackHandler(params: {
  cfg: OpenClawConfig;
  context: Parameters<typeof createFeedbackInvokeContext>[0];
  assertResult: (args: { tmpDir: string; originalRun: ReturnType<typeof vi.fn> }) => Promise<void>;
}) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
  try {
    const originalRun = vi.fn(async () => undefined);
    const handler = registerMSTeamsHandlers(
      createActivityHandler(originalRun),
      createDeps({
        cfg: {
          ...params.cfg,
          session: { store: tmpDir },
        },
      }),
    ) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await handler.run(createFeedbackInvokeContext(params.context));
    await params.assertResult({ originalRun, tmpDir });
  } finally {
    await rm(tmpDir, { force: true, recursive: true });
  }
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    feedbackReflectionMockState.runFeedbackReflection.mockReset();
    feedbackReflectionMockState.runFeedbackReflection.mockResolvedValue(undefined);
  });

  it("records feedback for an allowlisted DM sender", async () => {
    await withFeedbackHandler({
      assertResult: async ({ tmpDir, originalRun }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf8",
        );
        expect(JSON.parse(transcript.trim())).toMatchObject({
          comment: "allowed feedback",
          conversationId: "a:personal-chat",
          event: "feedback",
          messageId: "bot-msg-1",
          sessionKey: "msteams:direct:owner-aad",
          value: "positive",
        });
        expect(originalRun).not.toHaveBeenCalled();
      },
      cfg: {
        channels: {
          msteams: {
            allowFrom: ["owner-aad"],
            dmPolicy: "allowlist",
          },
        },
      } as OpenClawConfig,
      context: {
        comment: "allowed feedback",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        reaction: "like",
        senderId: "owner-aad",
        senderName: "Owner",
      },
    });
  });

  it("keeps DM feedback allowed when team route allowlists exist", async () => {
    await withFeedbackHandler({
      assertResult: async ({ tmpDir, originalRun }) => {
        const transcript = await readFile(
          path.join(tmpDir, "msteams_direct_owner-aad.jsonl"),
          "utf8",
        );
        expect(JSON.parse(transcript.trim())).toMatchObject({
          comment: "allowed dm feedback",
          event: "feedback",
          sessionKey: "msteams:direct:owner-aad",
          value: "positive",
        });
        expect(originalRun).not.toHaveBeenCalled();
      },
      cfg: {
        channels: {
          msteams: {
            allowFrom: ["owner-aad"],
            dmPolicy: "allowlist",
            teams: {
              team123: {
                channels: {
                  "19:group@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        comment: "allowed dm feedback",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        reaction: "like",
        senderId: "owner-aad",
        senderName: "Owner",
      },
    });
  });

  it("does not record feedback for a DM sender outside allowFrom", async () => {
    await withFeedbackHandler({
      assertResult: async ({ tmpDir, originalRun }) => {
        await expectFileMissing(path.join(tmpDir, "msteams_direct_attacker-aad.jsonl"));
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
        expect(originalRun).not.toHaveBeenCalled();
      },
      cfg: {
        channels: {
          msteams: {
            allowFrom: ["owner-aad"],
            dmPolicy: "allowlist",
          },
        },
      } as OpenClawConfig,
      context: {
        comment: "blocked feedback",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        reaction: "like",
        senderId: "attacker-aad",
        senderName: "Attacker",
      },
    });
  });

  it("does not trigger reflection for a group sender outside groupAllowFrom", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-msteams-feedback-"));
    try {
      const originalRun = vi.fn(async () => undefined);
      const handler = registerMSTeamsHandlers(
        createActivityHandler(originalRun),
        createDeps({
          cfg: {
            channels: {
              msteams: {
                feedbackReflection: true,
                groupAllowFrom: ["owner-aad"],
                groupPolicy: "allowlist",
              },
            },
            session: { store: tmpDir },
          } as OpenClawConfig,
        }),
      ) as MSTeamsActivityHandler & {
        run: NonNullable<MSTeamsActivityHandler["run"]>;
      };

      await handler.run(
        createFeedbackInvokeContext({
          channelName: "General",
          comment: "blocked reflection",
          conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
          conversationType: "groupChat",
          reaction: "dislike",
          senderId: "attacker-aad",
          senderName: "Attacker",
          teamId: "team-1",
        }),
      );

      await expectFileMissing(path.join(tmpDir, "msteams_group_19_group_thread_tacv2.jsonl"));
      expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      expect(originalRun).not.toHaveBeenCalled();
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });
});
