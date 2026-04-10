import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveOutboundTarget } from "./targets.js";
import {
  createTargetsTestRegistry,
  createTelegramTestPlugin,
  createWhatsAppTestPlugin,
} from "./targets.test-helpers.js";

export function installResolveOutboundTargetPluginRegistryHooks(): void {
  beforeEach(() => {
    setActivePluginRegistry(
      createTargetsTestRegistry([createWhatsAppTestPlugin(), createTelegramTestPlugin()]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTargetsTestRegistry([]));
  });
}

export function runResolveOutboundTargetCoreTests(): void {
  describe("resolveOutboundTarget", () => {
    installResolveOutboundTargetPluginRegistryHooks();

    it("rejects whatsapp with empty target even when allowFrom configured", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["+1555"] } },
      };
      const res = resolveOutboundTarget({
        cfg,
        channel: "whatsapp",
        mode: "explicit",
        to: "",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("WhatsApp");
      }
    });

    it.each([
      {
        expected: { ok: true as const, to: "+5551234567" },
        input: { channel: "whatsapp" as const, to: " (555) 123-4567 " },
        name: "normalizes whatsapp target when provided",
      },
      {
        expected: { ok: true as const, to: "120363401234567890@g.us" },
        input: { channel: "whatsapp" as const, to: "120363401234567890@g.us" },
        name: "keeps whatsapp group targets",
      },
      {
        expected: { ok: true as const, to: "120363401234567890@g.us" },
        input: {
          channel: "whatsapp" as const,
          to: " WhatsApp:120363401234567890@G.US ",
        },
        name: "normalizes prefixed/uppercase whatsapp group targets",
      },
      {
        expectedErrorIncludes: "WhatsApp",
        input: { allowFrom: ["+1555"], channel: "whatsapp" as const, to: "" },
        name: "rejects whatsapp with empty target and allowFrom (no silent fallback)",
      },
      {
        expectedErrorIncludes: "WhatsApp",
        input: {
          allowFrom: ["whatsapp:(555) 123-4567"],
          channel: "whatsapp" as const,
          to: "",
        },
        name: "rejects whatsapp with empty target and prefixed allowFrom (no silent fallback)",
      },
      {
        expectedErrorIncludes: "WhatsApp",
        input: { channel: "whatsapp" as const, to: "wat" },
        name: "rejects invalid whatsapp target",
      },
      {
        expectedErrorIncludes: "WhatsApp",
        input: { channel: "whatsapp" as const, to: " " },
        name: "rejects whatsapp without to when allowFrom missing",
      },
      {
        expectedErrorIncludes: "WhatsApp",
        input: { allowFrom: ["wat"], channel: "whatsapp" as const, to: "" },
        name: "rejects whatsapp allowFrom fallback when invalid",
      },
    ])("$name", ({ input, expected, expectedErrorIncludes }) => {
      const res = resolveOutboundTarget(input);
      if (expected) {
        expect(res).toEqual(expected);
        return;
      }
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain(expectedErrorIncludes);
      }
    });

    it("rejects telegram with missing target", () => {
      const res = resolveOutboundTarget({ channel: "telegram", to: " " });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Telegram");
      }
    });

    it("rejects webchat delivery", () => {
      const res = resolveOutboundTarget({ channel: "webchat", to: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("WebChat");
      }
    });
  });
}
