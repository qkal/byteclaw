import { beforeEach, describe, expect, it, vi } from "vitest";
import * as normalize from "./normalize-target.js";

vi.mock("./normalize-target.js");
vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  missingTargetError: (platform: string, format: string) => new Error(`${platform}: ${format}`),
}));

let resolveWhatsAppOutboundTarget: typeof import("./resolve-outbound-target.js").resolveWhatsAppOutboundTarget;

type ResolveParams = Parameters<typeof resolveWhatsAppOutboundTarget>[0];
const PRIMARY_TARGET = "+11234567890";
const SECONDARY_TARGET = "+19876543210";

function expectResolutionError(params: ResolveParams) {
  const result = resolveWhatsAppOutboundTarget(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolution to fail");
  }
  expect(result.error.message).toContain("WhatsApp");
}

function expectResolutionErrorMessage(params: ResolveParams, expectedMessage: string) {
  const result = resolveWhatsAppOutboundTarget(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolution to fail");
  }
  expect(result.error.message).toBe(expectedMessage);
}

function expectResolutionOk(params: ResolveParams, expectedTarget: string) {
  const result = resolveWhatsAppOutboundTarget(params);
  expect(result).toEqual({ ok: true, to: expectedTarget });
}

function mockNormalizedDirectMessage(...values: (string | null)[]) {
  const normalizeMock = vi.mocked(normalize.normalizeWhatsAppTarget);
  for (const value of values) {
    normalizeMock.mockReturnValueOnce(value);
  }
  vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);
}

function expectAllowedForTarget(params: {
  allowFrom: ResolveParams["allowFrom"];
  mode: ResolveParams["mode"];
  to?: string;
}) {
  const to = params.to ?? PRIMARY_TARGET;
  expectResolutionOk(
    {
      allowFrom: params.allowFrom,
      mode: params.mode,
      to,
    },
    to,
  );
}

function expectDeniedForTarget(params: {
  allowFrom: ResolveParams["allowFrom"];
  mode: ResolveParams["mode"];
  to?: string;
}) {
  expectResolutionError({
    allowFrom: params.allowFrom,
    mode: params.mode,
    to: params.to ?? PRIMARY_TARGET,
  });
}

describe("resolveWhatsAppOutboundTarget", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    ({ resolveWhatsAppOutboundTarget } = await import("./resolve-outbound-target.js"));
  });

  describe("empty/missing to parameter", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace only", "   "],
    ])("returns error when to is %s", (_label, to) => {
      expectResolutionError({ allowFrom: undefined, mode: undefined, to });
    });
  });

  describe("normalization failures", () => {
    it("returns error when normalizeWhatsAppTarget returns null/undefined", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce(null);
      expectResolutionError({
        allowFrom: undefined,
        mode: undefined,
        to: "+1234567890",
      });
    });
  });

  describe("group JID handling", () => {
    it("returns success for valid group JID regardless of mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("120363123456789@g.us");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(true);

      expectResolutionOk(
        {
          allowFrom: undefined,
          mode: "implicit",
          to: "120363123456789@g.us",
        },
        "120363123456789@g.us",
      );
    });

    it("returns success for group JID in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("120363999888777@g.us");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(true);

      expectResolutionOk(
        {
          allowFrom: undefined,
          mode: "heartbeat",
          to: "120363999888777@g.us",
        },
        "120363999888777@g.us",
      );
    });
  });

  describe("implicit/heartbeat mode with allowList", () => {
    it("allows message when wildcard is present", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: ["*"], mode: "implicit" });
    });

    it("allows message when allowList is empty", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [], mode: "implicit" });
    });

    it("allows message when target is in allowList", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [PRIMARY_TARGET], mode: "implicit" });
    });

    it("denies message when target is not in allowList", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, SECONDARY_TARGET);
      expectResolutionErrorMessage(
        {
          allowFrom: [SECONDARY_TARGET],
          mode: "implicit",
          to: PRIMARY_TARGET,
        },
        `Target "${SECONDARY_TARGET}" is not listed in the configured WhatsApp allowFrom policy.`,
      );
    });

    it("uses the normalized target in the allowFrom error message", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce(SECONDARY_TARGET)
        .mockReturnValueOnce(PRIMARY_TARGET);
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionErrorMessage(
        {
          allowFrom: [SECONDARY_TARGET],
          mode: "implicit",
          to: "(123) 456-7890",
        },
        `Target "${PRIMARY_TARGET}" is not listed in the configured WhatsApp allowFrom policy.`,
      );
    });

    it("handles mixed numeric and string allowList entries", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectAllowedForTarget({
        allowFrom: [1_234_567_890, PRIMARY_TARGET],
        mode: "implicit",
      });
    });

    it("filters out invalid normalized entries from allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectAllowedForTarget({
        allowFrom: ["invalid", PRIMARY_TARGET],
        mode: "implicit",
      });
    });
  });

  describe("heartbeat mode", () => {
    it("allows message when target is in allowList in heartbeat mode", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [PRIMARY_TARGET], mode: "heartbeat" });
    });

    it("denies message when target is not in allowList in heartbeat mode", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, SECONDARY_TARGET);
      expectDeniedForTarget({ allowFrom: [SECONDARY_TARGET], mode: "heartbeat" });
    });
  });

  describe("explicit/custom modes", () => {
    it("allows message in null mode when allowList is not set", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: undefined, mode: null });
    });

    it("allows message in undefined mode when allowList is not set", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: undefined, mode: undefined });
    });

    it("enforces allowList in custom mode string", () => {
      mockNormalizedDirectMessage(SECONDARY_TARGET, PRIMARY_TARGET);
      expectDeniedForTarget({ allowFrom: [SECONDARY_TARGET], mode: "broadcast" });
    });

    it("allows message in custom mode string when target is in allowList", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [PRIMARY_TARGET], mode: "broadcast" });
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace from to parameter", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET);

      expectResolutionOk(
        {
          allowFrom: undefined,
          mode: undefined,
          to: `  ${PRIMARY_TARGET}  `,
        },
        PRIMARY_TARGET,
      );
      expect(vi.mocked(normalize.normalizeWhatsAppTarget)).toHaveBeenCalledWith(PRIMARY_TARGET);
    });

    it("trims whitespace from allowList entries", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);

      resolveWhatsAppOutboundTarget({
        allowFrom: [`  ${PRIMARY_TARGET}  `],
        mode: undefined,
        to: PRIMARY_TARGET,
      });

      expect(vi.mocked(normalize.normalizeWhatsAppTarget)).toHaveBeenCalledWith(PRIMARY_TARGET);
    });
  });
});
