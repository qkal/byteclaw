import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppReactAction } from "./channel-react-action.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  handleWhatsAppAction: vi.fn(async () => ({ content: [{ text: '{"ok":true}', type: "text" }] })),
}));

vi.mock("./channel-react-action.runtime.js", async () => ({
  handleWhatsAppAction: hoisted.handleWhatsAppAction,
  normalizeWhatsAppTarget: (value?: string | null) => {
    const raw = `${value ?? ""}`.trim();
    if (!raw) {
      return null;
    }
    const stripped = raw.replace(/^whatsapp:/, "");
    return stripped.startsWith("+") ? stripped : `+${stripped.replace(/^\+/, "")}`;
  },
  readStringParam: (
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean; allowEmpty?: boolean },
  ) => {
    const value = params[key];
    if (value == null) {
      if (options?.required) {
        const err = new Error(`${key} required`);
        err.name = "ToolInputError";
        throw err;
      }
      return undefined;
    }
    const text = String(value);
    if (!options?.allowEmpty && !text.trim()) {
      if (options?.required) {
        const err = new Error(`${key} required`);
        err.name = "ToolInputError";
        throw err;
      }
      return undefined;
    }
    return text;
  },
  resolveReactionMessageId: ({
    args,
    toolContext,
  }: {
    args: Record<string, unknown>;
    toolContext?: { currentMessageId?: string | number | null };
  }) => args.messageId ?? toolContext?.currentMessageId ?? null,
}));

describe("whatsapp react action messageId resolution", () => {
  const baseCfg = {
    channels: { whatsapp: { actions: { reactions: true }, allowFrom: ["*"] } },
  } as OpenClawConfig;

  beforeEach(() => {
    hoisted.handleWhatsAppAction.mockClear();
  });

  it("uses explicit messageId when provided", async () => {
    await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "👍", messageId: "explicit-id", to: "+1555" },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "explicit-id" }),
      baseCfg,
    );
  });

  it("falls back to toolContext.currentMessageId when messageId omitted", async () => {
    await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "❤️", to: "+1555" },
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "ctx-msg-42" }),
      baseCfg,
    );
  });

  it("converts numeric toolContext messageId to string", async () => {
    await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "🎉", to: "+1555" },
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: 12_345,
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "12345" }),
      baseCfg,
    );
  });

  it("throws ToolInputError when messageId missing and no toolContext", async () => {
    const err = await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "👍", to: "+1555" },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when targeting a different chat", async () => {
    const err = await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "👍", to: "+9999" },
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("uses context fallback when target matches current chat", async () => {
    await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "👍", to: "+1555" },
      toolContext: {
        currentChannelId: "whatsapp:+1555",
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    });
    expect(hoisted.handleWhatsAppAction).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "ctx-msg-42" }),
      baseCfg,
    );
  });

  it("skips context fallback when source is another provider", async () => {
    const err = await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "👍", to: "+1555" },
      toolContext: {
        currentChannelId: "telegram:-1003841603622",
        currentChannelProvider: "telegram",
        currentMessageId: "tg-msg-99",
      },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });

  it("skips context fallback when currentChannelId is missing with explicit target", async () => {
    const err = await handleWhatsAppReactAction({
      accountId: "default",
      action: "react",
      cfg: baseCfg,
      params: { emoji: "👍", to: "+1555" },
      toolContext: {
        currentChannelProvider: "whatsapp",
        currentMessageId: "ctx-msg-42",
      },
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("ToolInputError");
  });
});
