import { describe, expect, it } from "vitest";
import { FeishuConfigSchema, FeishuGroupSchema } from "./config-schema.js";

function expectSchemaIssue(
  result: ReturnType<typeof FeishuConfigSchema.safeParse>,
  issuePath: string,
) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.some((issue) => issue.path.join(".") === issuePath)).toBe(true);
  }
}

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    // RequireMention has no schema-level default now — it is resolved at runtime
    // Through shared channel group-policy resolution, with an open-group override
    // That defaults to false only when requireMention is otherwise unset.
    expect(result.requireMention).toBeUndefined();
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {},
      },
    });

    expect(result.accounts?.main?.dmPolicy).toBeUndefined();
    expect(result.accounts?.main?.groupPolicy).toBeUndefined();
    expect(result.accounts?.main?.requireMention).toBeUndefined();
  });

  it("normalizes legacy groupPolicy allowall to open", () => {
    const result = FeishuConfigSchema.parse({
      groupPolicy: "allowall",
    });

    expect(result.groupPolicy).toBe("open");
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      appId: "cli_top",
      appSecret: "secret_top",
      connectionMode: "webhook", // Pragma: allowlist secret
    });

    expectSchemaIssue(result, "verificationToken");
  });

  it("rejects top-level webhook mode without encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      appId: "cli_top",
      appSecret: "secret_top",
      connectionMode: "webhook",
      verificationToken: "token_top", // Pragma: allowlist secret
    });

    expectSchemaIssue(result, "encryptKey");
  });

  it("accepts top-level webhook mode with verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      appId: "cli_top",
      appSecret: "secret_top",
      connectionMode: "webhook",
      encryptKey: "encrypt_top",
      verificationToken: "token_top", // Pragma: allowlist secret
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          appId: "cli_main",
          appSecret: "secret_main",
          connectionMode: "webhook", // Pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.verificationToken");
  });

  it("rejects account webhook mode without encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          appId: "cli_main",
          appSecret: "secret_main",
          connectionMode: "webhook",
          verificationToken: "token_main", // Pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.encryptKey");
  });

  it("accepts account webhook mode inheriting top-level verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          appId: "cli_main",
          appSecret: "secret_main",
          connectionMode: "webhook", // Pragma: allowlist secret
        },
      },
      encryptKey: "encrypt_top",
      verificationToken: "token_top",
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef verificationToken in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      appId: "cli_top",
      appSecret: {
        id: "FEISHU_APP_SECRET",
        provider: "default",
        source: "env",
      },
      connectionMode: "webhook",
      encryptKey: "encrypt_top",
      verificationToken: {
        id: "FEISHU_VERIFICATION_TOKEN",
        provider: "default",
        source: "env",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef encryptKey in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      appId: "cli_top",
      appSecret: {
        id: "FEISHU_APP_SECRET",
        provider: "default",
        source: "env",
      },
      connectionMode: "webhook",
      encryptKey: {
        id: "FEISHU_ENCRYPT_KEY",
        provider: "default",
        source: "env",
      },
      verificationToken: {
        id: "FEISHU_VERIFICATION_TOKEN",
        provider: "default",
        source: "env",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("FeishuConfigSchema replyInThread", () => {
  it("accepts replyInThread at top level", () => {
    const result = FeishuConfigSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("defaults replyInThread to undefined when not set", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.replyInThread).toBeUndefined();
  });

  it("rejects invalid replyInThread value", () => {
    const result = FeishuConfigSchema.safeParse({ replyInThread: "always" });
    expect(result.success).toBe(false);
  });

  it("accepts replyInThread in group config", () => {
    const result = FeishuGroupSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("accepts replyInThread in account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: { replyInThread: "enabled" },
      },
    });
    expect(result.accounts?.main?.replyInThread).toBe("enabled");
  });
});

describe("FeishuConfigSchema optimization flags", () => {
  it("defaults top-level typingIndicator and resolveSenderNames to true", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.typingIndicator).toBe(true);
    expect(result.resolveSenderNames).toBe(true);
  });

  it("accepts account-level optimization flags", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          resolveSenderNames: false,
          typingIndicator: false,
        },
      },
    });
    expect(result.accounts?.main?.typingIndicator).toBe(false);
    expect(result.accounts?.main?.resolveSenderNames).toBe(false);
  });
});

describe("FeishuConfigSchema actions", () => {
  it("accepts top-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      actions: { reactions: false },
    });
    expect(result.actions?.reactions).toBe(false);
  });

  it("accepts account-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          actions: { reactions: false },
        },
      },
    });
    expect(result.accounts?.main?.actions?.reactions).toBe(false);
  });
});

describe("FeishuConfigSchema defaultAccount", () => {
  it("accepts defaultAccount when it matches an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        "router-d": { appId: "cli_router", appSecret: "secret_router" }, // Pragma: allowlist secret
      },
      defaultAccount: "router-d",
    });

    expect(result.success).toBe(true);
  });

  it("rejects defaultAccount when it does not match an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        backup: { appId: "cli_backup", appSecret: "secret_backup" }, // Pragma: allowlist secret
      },
      defaultAccount: "router-d",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "defaultAccount")).toBe(
        true,
      );
    }
  });
});
