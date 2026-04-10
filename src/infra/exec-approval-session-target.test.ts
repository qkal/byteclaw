import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import { withTempDirSync } from "../test-helpers/temp-dir.js";
import {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestAccountId,
  resolveApprovalRequestChannelAccountId,
} from "./approval-request-account-binding.js";
import {
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestSessionConversation,
  resolveExecApprovalSessionTarget,
} from "./exec-approval-session-target.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

vi.mock("../channels/plugins/session-conversation.js", () => ({
  resolveSessionConversationRef(sessionKey: string | undefined | null) {
    const raw = parseRawSessionConversationRef(sessionKey);
    if (!raw) {
      return null;
    }
    const parsed = parseThreadSessionSuffix(raw.rawId);
    const id = (parsed.baseSessionKey ?? raw.rawId).trim();
    if (!id) {
      return null;
    }
    return {
      baseConversationId: id,
      baseSessionKey: `${raw.prefix}:${id}`,
      channel: raw.channel,
      id,
      kind: raw.kind,
      parentConversationCandidates: parsed.threadId ? [id] : [],
      rawId: raw.rawId,
      threadId: parsed.threadId,
    };
  },
}));

vi.mock(
  "./outbound/targets.js",
  async () =>
    await vi.importActual<typeof import("./outbound/targets-session.js")>(
      "./outbound/targets-session.js",
    ),
);

const baseRequest: ExecApprovalRequest = {
  createdAtMs: 1000,
  expiresAtMs: 6000,
  id: "req-1",
  request: {
    command: "echo hello",
    sessionKey: "agent:main:main",
  },
};

function writeStoreFile(
  storePath: string,
  entries: Record<string, Partial<SessionEntry>>,
): OpenClawConfig {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf8");
  return {
    session: { store: storePath },
  } as OpenClawConfig;
}

function expectResolvedSessionTarget(
  cfg: OpenClawConfig,
  request: ExecApprovalRequest,
): ReturnType<typeof resolveExecApprovalSessionTarget> {
  return resolveExecApprovalSessionTarget({ cfg, request });
}

function buildRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    ...baseRequest,
    request: {
      ...baseRequest.request,
      ...overrides,
    },
  };
}

function buildPluginRequest(
  overrides: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    createdAtMs: 1000,
    expiresAtMs: 6000,
    id: "plugin:req-1",
    request: {
      description: "Allow plugin action",
      sessionKey: "agent:main:main",
      title: "Plugin approval",
      ...overrides,
    },
  };
}

describe("exec approval session target", () => {
  interface PlaceholderStoreCase {
    name: string;
    relativeStoreDir: string;
    entries: Record<string, Partial<SessionEntry>>;
    request: ExecApprovalRequest;
    expected: ReturnType<typeof resolveExecApprovalSessionTarget>;
  }

  it("returns null for blank session keys, missing entries, and unresolved targets", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastChannel: "slack",
          sessionId: "main",
          updatedAt: 1,
        },
      });

      const requests = [
        buildRequest({ sessionKey: "  " }),
        buildRequest({ sessionKey: "agent:main:missing" }),
        baseRequest,
      ] satisfies ExecApprovalRequest[];

      for (const request of requests) {
        expect(expectResolvedSessionTarget(cfg, request)).toBeNull();
      }
    });
  });

  it("prefers turn-source routing over stale session delivery state", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastChannel: "slack",
          lastTo: "U1",
          sessionId: "main",
          updatedAt: 1,
        },
      });

      expect(
        resolveExecApprovalSessionTarget({
          cfg,
          request: baseRequest,
          turnSourceAccountId: " work ",
          turnSourceChannel: " whatsapp ",
          turnSourceThreadId: "1739201675.123",
          turnSourceTo: " +15555550123 ",
        }),
      ).toEqual({
        accountId: "work",
        channel: "whatsapp",
        threadId: "1739201675.123",
        to: "+15555550123",
      });
    });
  });

  it.each([
    {
      entries: {
        "agent:helper:main": {
          lastAccountId: " Work ",
          lastChannel: "discord",
          lastThreadId: "55",
          lastTo: "channel:123",
          sessionId: "main",
          updatedAt: 1,
        },
      } as Record<string, Partial<SessionEntry>>,
      expected: {
        accountId: "work",
        channel: "discord",
        threadId: "55",
        to: "channel:123",
      },
      name: "uses the parsed session-key agent id for store-path placeholders",
      relativeStoreDir: "helper",
      request: buildRequest({ sessionKey: "agent:helper:main" }),
    },
    {
      entries: {
        "legacy-main": {
          lastChannel: "telegram",
          lastThreadId: 77,
          lastTo: "-100123",
          sessionId: "legacy-main",
          updatedAt: 1,
        },
      } as Record<string, Partial<SessionEntry>>,
      expected: {
        accountId: undefined,
        channel: "telegram",
        threadId: 77,
        to: "-100123",
      },
      name: "falls back to request agent id for legacy session keys",
      relativeStoreDir: "worker-1",
      request: buildRequest({
        agentId: "Worker 1",
        sessionKey: "legacy-main",
      }),
    },
  ] satisfies PlaceholderStoreCase[])(
    "$name",
    ({ relativeStoreDir, entries, request, expected }) => {
      withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
        const cfg = writeStoreFile(path.join(tmpDir, relativeStoreDir, "sessions.json"), entries);
        cfg.session = { store: path.join(tmpDir, "{agentId}", "sessions.json") };
        expect(expectResolvedSessionTarget(cfg, request)).toEqual(expected);
      });
    },
  );

  it("preserves string thread ids from the session store", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastAccountId: " Work ",
          lastChannel: "discord",
          lastThreadId: "777888999111222333",
          lastTo: "channel:123",
          sessionId: "main",
          updatedAt: 1,
        },
      });

      expect(expectResolvedSessionTarget(cfg, baseRequest)).toEqual({
        accountId: "work",
        channel: "discord",
        threadId: "777888999111222333",
        to: "channel:123",
      });
    });
  });

  it("parses channel-scoped session conversation fallbacks for approval requests", () => {
    const request = buildPluginRequest({
      sessionKey: "agent:main:matrix:channel:!Ops:Example.org:thread:$root",
    });

    expect(
      resolveApprovalRequestSessionConversation({
        channel: "matrix",
        request,
      }),
    ).toEqual({
      baseConversationId: "!Ops:Example.org",
      baseSessionKey: "agent:main:matrix:channel:!Ops:Example.org",
      channel: "matrix",
      id: "!Ops:Example.org",
      kind: "channel",
      parentConversationCandidates: ["!Ops:Example.org"],
      rawId: "!Ops:Example.org:thread:$root",
      threadId: "$root",
    });
  });

  it("ignores session conversation fallbacks for other channels", () => {
    const request = buildPluginRequest({
      sessionKey: "agent:main:matrix:channel:!ops:example.org",
    });

    expect(
      resolveApprovalRequestSessionConversation({
        channel: "slack",
        request,
      }),
    ).toBeNull();
  });

  it("prefers explicit turn-source account bindings when session store is missing", () => {
    const cfg = {} as OpenClawConfig;
    const request = buildRequest({
      sessionKey: "agent:main:missing",
      turnSourceAccountId: "Work",
      turnSourceChannel: "slack",
    });

    expect(resolveApprovalRequestAccountId({ cfg, channel: "slack", request })).toBe("work");
    expect(
      doesApprovalRequestMatchChannelAccount({
        accountId: "work",
        cfg,
        channel: "slack",
        request,
      }),
    ).toBe(true);
    expect(
      doesApprovalRequestMatchChannelAccount({
        accountId: "other",
        cfg,
        channel: "slack",
        request,
      }),
    ).toBe(false);
  });

  it("rejects mismatched channel bindings before account checks", () => {
    const cfg = {} as OpenClawConfig;
    const request = buildRequest({
      turnSourceAccountId: "work",
      turnSourceChannel: "discord",
    });

    expect(resolveApprovalRequestAccountId({ cfg, channel: "slack", request })).toBeNull();
    expect(
      doesApprovalRequestMatchChannelAccount({
        accountId: "work",
        cfg,
        channel: "slack",
        request,
      }),
    ).toBe(false);
  });

  it("falls back to the stored session binding when turn source uses another channel", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:matrix:channel:!ops:example.org": {
          lastAccountId: "work",
          lastChannel: "slack",
          lastTo: "channel:C123",
          origin: {
            accountId: "ops",
            provider: "matrix",
          },
          sessionId: "main",
          updatedAt: 1,
        },
      });
      const request = buildRequest({
        sessionKey: "agent:main:matrix:channel:!ops:example.org",
        turnSourceAccountId: "work",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:D123",
      });

      expect(resolveApprovalRequestAccountId({ cfg, channel: "matrix", request })).toBeNull();
      expect(resolveApprovalRequestChannelAccountId({ cfg, channel: "matrix", request })).toBe(
        "ops",
      );
    });
  });

  it("falls back to the session-bound account when no turn-source account is present", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastAccountId: "ops",
          lastChannel: "slack",
          lastTo: "user:U1",
          sessionId: "main",
          updatedAt: 1,
        },
      });

      expect(resolveApprovalRequestAccountId({ cfg, channel: "slack", request: baseRequest })).toBe(
        "ops",
      );
      expect(
        doesApprovalRequestMatchChannelAccount({
          accountId: "ops",
          cfg,
          channel: "slack",
          request: baseRequest,
        }),
      ).toBe(true);
    });
  });

  it("prefers explicit turn-source accounts over stale session account bindings", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastAccountId: "ops",
          lastChannel: "slack",
          lastTo: "user:U1",
          sessionId: "main",
          updatedAt: 1,
        },
      });
      const request = buildRequest({
        turnSourceAccountId: "work",
        turnSourceChannel: "slack",
      });

      expect(resolveApprovalRequestAccountId({ cfg, channel: "slack", request })).toBe("work");
      expect(
        doesApprovalRequestMatchChannelAccount({
          accountId: "work",
          cfg,
          channel: "slack",
          request,
        }),
      ).toBe(true);
    });
  });

  it("reconciles plugin-request turn source and session origin targets through the shared helper", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastChannel: "slack",
          lastTo: "channel:C123",
          sessionId: "main",
          updatedAt: 1,
        },
      });

      const target = resolveApprovalRequestOriginTarget({
        accountId: "default",
        cfg,
        channel: "slack",
        request: buildPluginRequest({
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
        }),
        resolveSessionTarget: (sessionTarget) => ({ to: sessionTarget.to }),
        resolveTurnSourceTarget: (request) =>
          request.request.turnSourceChannel === "slack" && request.request.turnSourceTo
            ? { to: request.request.turnSourceTo }
            : null,
        targetsMatch: (a, b) => a.to === b.to,
      });

      expect(target).toEqual({ to: "channel:C123" });
    });
  });

  it("returns null when explicit turn source conflicts with the session-bound origin target", () => {
    withTempDirSync({ prefix: "openclaw-exec-approval-session-target-" }, (tmpDir) => {
      const storePath = path.join(tmpDir, "sessions.json");
      const cfg = writeStoreFile(storePath, {
        "agent:main:main": {
          lastChannel: "slack",
          lastTo: "channel:C123",
          sessionId: "main",
          updatedAt: 1,
        },
      });

      const target = resolveApprovalRequestOriginTarget({
        accountId: "default",
        cfg,
        channel: "slack",
        request: buildPluginRequest({
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C999",
        }),
        resolveSessionTarget: (sessionTarget) => ({ to: sessionTarget.to }),
        resolveTurnSourceTarget: (request) =>
          request.request.turnSourceChannel === "slack" && request.request.turnSourceTo
            ? { to: request.request.turnSourceTo }
            : null,
        targetsMatch: (a, b) => a.to === b.to,
      });

      expect(target).toBeNull();
    });
  });

  it("falls back to a legacy origin target when no turn-source or session target exists", () => {
    const target = resolveApprovalRequestOriginTarget({
      accountId: "default",
      cfg: {} as OpenClawConfig,
      channel: "discord",
      request: buildPluginRequest({ sessionKey: "agent:main:missing" }),
      resolveFallbackTarget: () => ({ to: "channel:legacy" }),
      resolveSessionTarget: () => ({ to: "unused" }),
      resolveTurnSourceTarget: () => null,
      targetsMatch: (a, b) => a.to === b.to,
    });

    expect(target).toEqual({ to: "channel:legacy" });
  });
});
