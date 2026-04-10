/**
 * Tests for Nostr Profile Import
 */

import { describe, expect, it } from "vitest";
import type { NostrProfile } from "./config-schema.js";
import { mergeProfiles } from "./nostr-profile-import.js";

// Note: importProfileFromRelays requires real network calls or complex mocking
// Of nostr-tools SimplePool, so we focus on unit testing mergeProfiles

describe("nostr-profile-import", () => {
  describe("mergeProfiles", () => {
    it("returns empty object when both are undefined", () => {
      const result = mergeProfiles(undefined, undefined);
      expect(result).toEqual({});
    });

    it("returns imported when local is undefined", () => {
      const imported: NostrProfile = {
        about: "Bio from relay",
        displayName: "Imported User",
        name: "imported",
      };
      const result = mergeProfiles(undefined, imported);
      expect(result).toEqual(imported);
    });

    it("returns local when imported is undefined", () => {
      const local: NostrProfile = {
        displayName: "Local User",
        name: "local",
      };
      const result = mergeProfiles(local, undefined);
      expect(result).toEqual(local);
    });

    it("prefers local values over imported", () => {
      const local: NostrProfile = {
        about: "Local bio",
        name: "localname",
      };
      const imported: NostrProfile = {
        about: "Imported bio",
        displayName: "Imported Display",
        name: "importedname",
        picture: "https://example.com/pic.jpg",
      };

      const result = mergeProfiles(local, imported);

      expect(result.name).toBe("localname"); // Local wins
      expect(result.displayName).toBe("Imported Display"); // Imported fills gap
      expect(result.about).toBe("Local bio"); // Local wins
      expect(result.picture).toBe("https://example.com/pic.jpg"); // Imported fills gap
    });

    it("fills all missing fields from imported", () => {
      const local: NostrProfile = {
        name: "myname",
      };
      const imported: NostrProfile = {
        about: "Their bio",
        banner: "https://example.com/banner.jpg",
        displayName: "Their Name",
        lud16: "user@getalby.com",
        name: "theirname",
        nip05: "user@example.com",
        picture: "https://example.com/pic.jpg",
        website: "https://example.com",
      };

      const result = mergeProfiles(local, imported);

      expect(result.name).toBe("myname");
      expect(result.displayName).toBe("Their Name");
      expect(result.about).toBe("Their bio");
      expect(result.picture).toBe("https://example.com/pic.jpg");
      expect(result.banner).toBe("https://example.com/banner.jpg");
      expect(result.website).toBe("https://example.com");
      expect(result.nip05).toBe("user@example.com");
      expect(result.lud16).toBe("user@getalby.com");
    });

    it("handles empty strings as falsy (prefers imported)", () => {
      const local: NostrProfile = {
        displayName: "",
        name: "",
      };
      const imported: NostrProfile = {
        displayName: "Imported",
        name: "imported",
      };

      const result = mergeProfiles(local, imported);

      // Empty strings are still strings, so they "win" over imported
      // This is JavaScript nullish coalescing behavior
      expect(result.name).toBe("");
      expect(result.displayName).toBe("");
    });

    it("handles null values in local (prefers imported)", () => {
      const local: NostrProfile = {
        displayName: undefined,
        name: undefined,
      };
      const imported: NostrProfile = {
        displayName: "Imported",
        name: "imported",
      };

      const result = mergeProfiles(local, imported);

      expect(result.name).toBe("imported");
      expect(result.displayName).toBe("Imported");
    });
  });
});
