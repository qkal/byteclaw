import type { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { buildHttpError, matrixEventToRaw, parseMxc } from "./event-helpers.js";

describe("event-helpers", () => {
  it("parses mxc URIs", () => {
    expect(parseMxc("mxc://server.example/media-id")).toEqual({
      mediaId: "media-id",
      server: "server.example",
    });
    expect(parseMxc("not-mxc")).toBeNull();
  });

  it("builds HTTP errors from JSON and plain text payloads", () => {
    const fromJson = buildHttpError(403, JSON.stringify({ error: "forbidden" }));
    expect(fromJson.message).toBe("forbidden");
    expect(fromJson.statusCode).toBe(403);

    const fromText = buildHttpError(500, "internal failure");
    expect(fromText.message).toBe("internal failure");
    expect(fromText.statusCode).toBe(500);
  });

  it("serializes Matrix events and resolves state key from available sources", () => {
    const viaGetter = {
      getContent: () => ({ membership: "join" }),
      getId: () => "$1",
      getSender: () => "@alice:example.org",
      getStateKey: () => "@alice:example.org",
      getTs: () => 1000,
      getType: () => "m.room.member",
      getUnsigned: () => ({ age: 1 }),
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaGetter).state_key).toBe("@alice:example.org");

    const viaWire = {
      getContent: () => ({ membership: "join" }),
      getId: () => "$2",
      getSender: () => "@bob:example.org",
      getStateKey: () => undefined,
      getTs: () => 2000,
      getType: () => "m.room.member",
      getUnsigned: () => ({}),
      getWireContent: () => ({ state_key: "@bob:example.org" }),
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaWire).state_key).toBe("@bob:example.org");

    const viaRaw = {
      event: { state_key: "@carol:example.org" },
      getContent: () => ({ membership: "join" }),
      getId: () => "$3",
      getSender: () => "@carol:example.org",
      getStateKey: () => undefined,
      getTs: () => 3000,
      getType: () => "m.room.member",
      getUnsigned: () => ({}),
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaRaw).state_key).toBe("@carol:example.org");
  });
});
