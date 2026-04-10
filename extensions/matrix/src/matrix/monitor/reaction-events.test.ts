import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMatrixApprovalReactionTargetsForTest,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import type { CoreConfig } from "../../types.js";
import { handleInboundMatrixReaction } from "./reaction-events.js";

const resolveMatrixApproval = vi.fn();
type MatrixReactionParams = Parameters<typeof handleInboundMatrixReaction>[0];
type MatrixReactionClient = MatrixReactionParams["client"];
type MatrixReactionCore = MatrixReactionParams["core"];
type MatrixReactionEvent = MatrixReactionParams["event"];

vi.mock("../../exec-approval-resolver.js", () => ({
  isApprovalNotFoundError: (err: unknown) =>
    err instanceof Error && /unknown or expired approval id/i.test(err.message),
  resolveMatrixApproval: (...args: unknown[]) => resolveMatrixApproval(...args),
}));

beforeEach(() => {
  resolveMatrixApproval.mockReset();
  clearMatrixApprovalReactionTargetsForTest();
});

function buildConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        accessToken: "tok",
        execApprovals: {
          approvers: ["@owner:example.org"],
          enabled: true,
          target: "channel",
        },
        homeserver: "https://matrix.example.org",
        reactionNotifications: "own",
        userId: "@bot:example.org",
      },
    },
  } as CoreConfig;
}

function buildCore() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          mainSessionKey: "agent:main:matrix:channel:!ops:example.org",
          matchedBy: "peer",
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
        }),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["core"];
}

function createReactionClient(
  getEvent: ReturnType<typeof vi.fn> = vi.fn(),
): MatrixReactionClient & { getEvent: ReturnType<typeof vi.fn> } {
  return { getEvent } as unknown as MatrixReactionClient & {
    getEvent: ReturnType<typeof vi.fn>;
  };
}

function createReactionEvent(
  params: {
    eventId?: string;
    targetEventId?: string;
    reactionKey?: string;
  } = {},
): MatrixReactionEvent {
  return {
    content: {
      "m.relates_to": {
        event_id: params.targetEventId ?? "$approval-msg",
        key: params.reactionKey ?? "✅",
        rel_type: "m.annotation",
      },
    },
    event_id: params.eventId ?? "$reaction-1",
    origin_server_ts: 123,
    sender: "@owner:example.org",
    type: "m.reaction",
  } as MatrixReactionEvent;
}

async function handleReaction(params: {
  client: MatrixReactionClient;
  core: MatrixReactionCore;
  cfg?: CoreConfig;
  targetEventId?: string;
  reactionKey?: string;
}): Promise<void> {
  await handleInboundMatrixReaction({
    accountId: "default",
    cfg: params.cfg ?? buildConfig(),
    client: params.client,
    core: params.core,
    event: createReactionEvent({
      reactionKey: params.reactionKey,
      targetEventId: params.targetEventId,
    }),
    isDirectMessage: false,
    logVerboseMessage: vi.fn(),
    roomId: "!ops:example.org",
    selfUserId: "@bot:example.org",
    senderId: "@owner:example.org",
    senderLabel: "Owner",
  });
}

describe("matrix approval reactions", () => {
  it("resolves approval reactions instead of enqueueing a generic reaction event", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        content: { body: "approval prompt" },
        event_id: "$approval-msg",
        sender: "@bot:example.org",
      }),
    );

    await handleReaction({
      cfg,
      client,
      core,
    });

    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      approvalId: "req-123",
      cfg,
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps ordinary reactions on bot messages as generic reaction events", async () => {
    const core = buildCore();
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        content: {
          body: "normal bot message",
        },
        event_id: "$msg-1",
        sender: "@bot:example.org",
      }),
    );

    await handleReaction({
      client,
      core,
      reactionKey: "👍",
      targetEventId: "$msg-1",
    });

    expect(resolveMatrixApproval).not.toHaveBeenCalled();
    expect(core.system.enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 👍 by Owner on msg $msg-1",
      expect.objectContaining({
        contextKey: "matrix:reaction:add:!ops:example.org:$msg-1:@owner:example.org:👍",
      }),
    );
  });

  it("still resolves approval reactions when generic reaction notifications are off", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.reactionNotifications = "off";
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["deny"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        content: { body: "approval prompt" },
        event_id: "$approval-msg",
        sender: "@bot:example.org",
      }),
    );

    await handleReaction({
      cfg,
      client,
      core,
      reactionKey: "❌",
    });

    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      approvalId: "req-123",
      cfg,
      decision: "deny",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("resolves registered approval reactions without fetching the target event", async () => {
    const core = buildCore();
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["allow-once"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });
    const client = createReactionClient(vi.fn().mockRejectedValue(new Error("boom")));

    await handleReaction({
      client,
      core,
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      approvalId: "req-123",
      cfg: buildConfig(),
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("resolves plugin approval reactions through the same Matrix reaction path", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.dm = { allowFrom: ["@owner:example.org"] };
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["allow-once", "deny"],
      approvalId: "plugin:req-123",
      eventId: "$plugin-approval-msg",
      roomId: "!ops:example.org",
    });
    const client = createReactionClient();

    await handleReaction({
      cfg,
      client,
      core,
      targetEventId: "$plugin-approval-msg",
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      approvalId: "plugin:req-123",
      cfg,
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("unregisters stale approval anchors after not-found resolution", async () => {
    const core = buildCore();
    resolveMatrixApproval.mockRejectedValueOnce(
      new Error("unknown or expired approval id req-123"),
    );
    registerMatrixApprovalReactionTarget({
      allowedDecisions: ["deny"],
      approvalId: "req-123",
      eventId: "$approval-msg",
      roomId: "!ops:example.org",
    });
    const client = createReactionClient();

    await handleReaction({
      client,
      core,
      reactionKey: "❌",
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(
      resolveMatrixApprovalReactionTarget({
        eventId: "$approval-msg",
        reactionKey: "❌",
        roomId: "!ops:example.org",
      }),
    ).toBeNull();
  });

  it("skips target fetches for ordinary reactions when notifications are off", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.reactionNotifications = "off";
    const client = createReactionClient();

    await handleReaction({
      cfg,
      client,
      core,
      reactionKey: "👍",
      targetEventId: "$msg-1",
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).not.toHaveBeenCalled();
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
