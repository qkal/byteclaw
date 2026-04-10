import { describe, expect, it } from "vitest";
import { resolveMatrixRoomConfig } from "./rooms.js";

describe("resolveMatrixRoomConfig", () => {
  it("matches room IDs and aliases, not names", () => {
    const rooms = {
      "!room:example.org": { enabled: true },
      "#alias:example.org": { enabled: true },
      "Project Room": { enabled: true },
    };

    const byId = resolveMatrixRoomConfig({
      aliases: [],
      roomId: "!room:example.org",
      rooms,
    });
    expect(byId.allowed).toBe(true);
    expect(byId.matchKey).toBe("!room:example.org");

    const byAlias = resolveMatrixRoomConfig({
      aliases: ["#alias:example.org"],
      roomId: "!other:example.org",
      rooms,
    });
    expect(byAlias.allowed).toBe(true);
    expect(byAlias.matchKey).toBe("#alias:example.org");

    const byName = resolveMatrixRoomConfig({
      aliases: [],
      roomId: "!different:example.org",
      rooms: { "Project Room": { enabled: true } },
    });
    expect(byName.allowed).toBe(false);
    expect(byName.config).toBeUndefined();
  });

  describe("matchSource classification", () => {
    it('returns matchSource="direct" for exact room ID match', () => {
      const result = resolveMatrixRoomConfig({
        aliases: [],
        roomId: "!room:example.org",
        rooms: { "!room:example.org": { enabled: true } },
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config).toBeDefined();
    });

    it('returns matchSource="direct" for alias match', () => {
      const result = resolveMatrixRoomConfig({
        aliases: ["#alias:example.org"],
        roomId: "!room:example.org",
        rooms: { "#alias:example.org": { enabled: true } },
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config).toBeDefined();
    });

    it('returns matchSource="wildcard" for wildcard match', () => {
      const result = resolveMatrixRoomConfig({
        aliases: [],
        roomId: "!any:example.org",
        rooms: { "*": { enabled: true } },
      });
      expect(result.matchSource).toBe("wildcard");
      expect(result.config).toBeDefined();
    });

    it("returns undefined matchSource when no match", () => {
      const result = resolveMatrixRoomConfig({
        aliases: [],
        roomId: "!room:example.org",
        rooms: { "!other:example.org": { enabled: true } },
      });
      expect(result.matchSource).toBeUndefined();
      expect(result.config).toBeUndefined();
    });

    it("direct match takes priority over wildcard", () => {
      const result = resolveMatrixRoomConfig({
        aliases: [],
        roomId: "!room:example.org",
        rooms: {
          "!room:example.org": { enabled: true, systemPrompt: "room-specific" },
          "*": { enabled: true, systemPrompt: "generic" },
        },
      });
      expect(result.matchSource).toBe("direct");
      expect(result.config?.systemPrompt).toBe("room-specific");
    });
  });

  describe("DM override safety (matchSource distinction)", () => {
    // These tests verify the matchSource property that handler.ts uses
    // To decide whether a configured room should override DM classification.
    // Only "direct" matches should trigger the override -- never "wildcard".

    it("wildcard config should NOT be usable to override DM classification", () => {
      const result = resolveMatrixRoomConfig({
        aliases: [],
        roomId: "!dm-room:example.org",
        rooms: { "*": { enabled: true, skills: ["general"] } },
      });
      // Handler.ts checks: matchSource === "direct" -> this is "wildcard", so no override
      expect(result.matchSource).not.toBe("direct");
      expect(result.matchSource).toBe("wildcard");
    });

    it("explicitly configured room should be usable to override DM classification", () => {
      const result = resolveMatrixRoomConfig({
        aliases: [],
        roomId: "!configured-room:example.org",
        rooms: {
          "!configured-room:example.org": { enabled: true },
          "*": { enabled: true },
        },
      });
      // Handler.ts checks: matchSource === "direct" -> this IS "direct", so override is safe
      expect(result.matchSource).toBe("direct");
    });
  });
});
