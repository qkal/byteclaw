import { describe, expect, it } from "vitest";
import { formatLocationText, toLocationContext } from "./location.js";

describe("provider location helpers", () => {
  it("formats pin locations with accuracy", () => {
    const text = formatLocationText({
      accuracy: 12,
      latitude: 48.858_844,
      longitude: 2.294_351,
    });
    expect(text).toBe("📍 48.858844, 2.294351 ±12m");
  });

  it("formats named places with address and caption", () => {
    const text = formatLocationText({
      accuracy: 8,
      address: "Liberty Island, NY",
      caption: "Bring snacks",
      latitude: 40.689_247,
      longitude: -74.044_502,
      name: "Statue of Liberty",
    });
    expect(text).toBe(
      "📍 Statue of Liberty — Liberty Island, NY (40.689247, -74.044502 ±8m)\nBring snacks",
    );
  });

  it("formats live locations with live label", () => {
    const text = formatLocationText({
      accuracy: 20,
      caption: "On the move",
      isLive: true,
      latitude: 37.819_929,
      longitude: -122.478_255,
      source: "live",
    });
    expect(text).toBe("🛰 Live location: 37.819929, -122.478255 ±20m\nOn the move");
  });

  it("builds ctx fields with normalized source", () => {
    const ctx = toLocationContext({
      address: "Main St",
      latitude: 1,
      longitude: 2,
      name: "Cafe",
    });
    expect(ctx).toEqual({
      LocationAccuracy: undefined,
      LocationAddress: "Main St",
      LocationIsLive: false,
      LocationLat: 1,
      LocationLon: 2,
      LocationName: "Cafe",
      LocationSource: "place",
    });
  });
});
