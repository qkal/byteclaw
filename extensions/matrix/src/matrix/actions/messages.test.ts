import { describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixClient } from "../sdk.js";
import * as sendModule from "../send.js";
import { editMatrixMessage, readMatrixMessages } from "./messages.js";

function installMatrixActionTestRuntime(): void {
  setMatrixRuntime({
    channel: {
      text: {
        convertMarkdownTables: (text: string) => text,
        resolveMarkdownTableMode: () => "code",
      },
    },
    config: {
      loadConfig: () => ({}),
    },
  } as unknown as import("../../runtime-api.js").PluginRuntime);
}

function createPollResponseEvent(): Record<string, unknown> {
  return {
    content: {
      "m.poll.response": { answers: ["a1"] },
      "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
    },
    event_id: "$vote",
    origin_server_ts: 20,
    sender: "@bob:example.org",
    type: "m.poll.response",
  };
}

function createPollStartEvent(params?: {
  answers?: Record<string, unknown>[];
  includeDisclosedKind?: boolean;
  maxSelections?: number;
}): Record<string, unknown> {
  return {
    content: {
      "m.poll.start": {
        question: { "m.text": "Favorite fruit?" },
        ...(params?.includeDisclosedKind ? { kind: "m.poll.disclosed" } : {}),
        ...(params?.maxSelections !== undefined ? { max_selections: params.maxSelections } : {}),
        answers: params?.answers ?? [{ id: "a1", "m.text": "Apple" }],
      },
    },
    event_id: "$poll",
    origin_server_ts: 1,
    sender: "@alice:example.org",
    type: "m.poll.start",
  };
}

function createMessagesClient(params: {
  chunk: Record<string, unknown>[];
  hydratedChunk?: Record<string, unknown>[];
  pollRoot?: Record<string, unknown>;
  pollRelations?: Record<string, unknown>[];
}) {
  const doRequest = vi.fn(async () => ({
    chunk: params.chunk,
    end: "end-token",
    start: "start-token",
  }));
  const hydrateEvents = vi.fn(
    async (_roomId: string, _events: Record<string, unknown>[]) =>
      (params.hydratedChunk ?? params.chunk) as unknown,
  );
  const getEvent = vi.fn(async () => params.pollRoot ?? null);
  const getRelations = vi.fn(async () => ({
    events: params.pollRelations ?? [],
    nextBatch: null,
    prevBatch: null,
  }));

  return {
    client: {
      doRequest,
      getEvent,
      getRelations,
      hydrateEvents,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    doRequest,
    getEvent,
    getRelations,
    hydrateEvents,
  };
}

describe("matrix message actions", () => {
  it("forwards timeoutMs to the shared Matrix edit helper", async () => {
    const editSpy = vi.spyOn(sendModule, "editMessageMatrix").mockResolvedValue("evt-edit");

    try {
      const result = await editMatrixMessage("!room:example.org", "$original", "hello", {
        timeoutMs: 12_345,
      });

      expect(result).toEqual({ eventId: "evt-edit" });
      expect(editSpy).toHaveBeenCalledWith("!room:example.org", "$original", "hello", {
        accountId: undefined,
        cfg: undefined,
        client: undefined,
        timeoutMs: 12_345,
      });
    } finally {
      editSpy.mockRestore();
    }
  });

  it("routes edits through the shared Matrix edit helper so mentions are preserved", async () => {
    installMatrixActionTestRuntime();
    const sendMessage = vi.fn().mockResolvedValue("evt-edit");
    const client = {
      getEvent: vi.fn().mockResolvedValue({
        content: {
          body: "hello @alice:example.org",
          "m.mentions": { user_ids: ["@alice:example.org"] },
        },
      }),
      getJoinedRoomMembers: vi.fn().mockResolvedValue([]),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      prepareForOneOff: vi.fn(async () => undefined),
      sendMessage,
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      stopAndPersist: vi.fn(async () => undefined),
    } as unknown as MatrixClient;

    const result = await editMatrixMessage(
      "!room:example.org",
      "$original",
      "hello @alice:example.org and @bob:example.org",
      { client },
    );

    expect(result).toEqual({ eventId: "evt-edit" });
    expect(sendMessage).toHaveBeenCalledWith(
      "!room:example.org",
      expect.objectContaining({
        "m.mentions": { user_ids: ["@bob:example.org"] },
        "m.new_content": expect.objectContaining({
          "m.mentions": { user_ids: ["@alice:example.org", "@bob:example.org"] },
        }),
      }),
    );
  });

  it("does not re-notify legacy mentions when action edits target pre-m.mentions messages", async () => {
    installMatrixActionTestRuntime();
    const sendMessage = vi.fn().mockResolvedValue("evt-edit");
    const client = {
      getEvent: vi.fn().mockResolvedValue({
        content: {
          body: "hello @alice:example.org",
        },
      }),
      getJoinedRoomMembers: vi.fn().mockResolvedValue([]),
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
      prepareForOneOff: vi.fn(async () => undefined),
      sendMessage,
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      stopAndPersist: vi.fn(async () => undefined),
    } as unknown as MatrixClient;

    const result = await editMatrixMessage(
      "!room:example.org",
      "$original",
      "hello again @alice:example.org",
      { client },
    );

    expect(result).toEqual({ eventId: "evt-edit" });
    expect(sendMessage).toHaveBeenCalledWith(
      "!room:example.org",
      expect.objectContaining({
        "m.mentions": {},
        "m.new_content": expect.objectContaining({
          body: "hello again @alice:example.org",
          "m.mentions": { user_ids: ["@alice:example.org"] },
        }),
      }),
    );
  });

  it("includes poll snapshots when reading message history", async () => {
    const { client, doRequest, getEvent, getRelations } = createMessagesClient({
      chunk: [
        createPollResponseEvent(),
        {
          content: {
            body: "hello",
            msgtype: "m.text",
          },
          event_id: "$msg",
          origin_server_ts: 10,
          sender: "@alice:example.org",
          type: "m.room.message",
        },
      ],
      pollRelations: [createPollResponseEvent()],
      pollRoot: createPollStartEvent({
        answers: [
          { id: "a1", "m.text": "Apple" },
          { id: "a2", "m.text": "Strawberry" },
        ],
        includeDisclosedKind: true,
        maxSelections: 1,
      }),
    });

    const result = await readMatrixMessages("room:!room:example.org", { client, limit: 2.9 });

    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/rooms/!room%3Aexample.org/messages"),
      expect.objectContaining({ limit: 2 }),
    );
    expect(getEvent).toHaveBeenCalledWith("!room:example.org", "$poll");
    expect(getRelations).toHaveBeenCalledWith(
      "!room:example.org",
      "$poll",
      "m.reference",
      undefined,
      {
        from: undefined,
      },
    );
    expect(result.messages).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("1. Apple (1 vote)"),
        eventId: "$poll",
        msgtype: "m.text",
      }),
      expect.objectContaining({
        body: "hello",
        eventId: "$msg",
      }),
    ]);
  });

  it("dedupes multiple poll events for the same poll within one read page", async () => {
    const { client, getEvent } = createMessagesClient({
      chunk: [createPollResponseEvent(), createPollStartEvent()],
      pollRelations: [],
      pollRoot: createPollStartEvent(),
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual(
      expect.objectContaining({
        body: expect.stringContaining("[Poll]"),
        eventId: "$poll",
      }),
    );
    expect(getEvent).toHaveBeenCalledTimes(1);
  });

  it("uses hydrated history events so encrypted poll entries can be read", async () => {
    const { client, hydrateEvents } = createMessagesClient({
      chunk: [
        {
          content: {},
          event_id: "$enc",
          origin_server_ts: 20,
          sender: "@bob:example.org",
          type: "m.room.encrypted",
        },
      ],
      hydratedChunk: [createPollResponseEvent()],
      pollRelations: [],
      pollRoot: createPollStartEvent(),
    });

    const result = await readMatrixMessages("room:!room:example.org", { client });

    expect(hydrateEvents).toHaveBeenCalledWith(
      "!room:example.org",
      expect.arrayContaining([expect.objectContaining({ event_id: "$enc" })]),
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.eventId).toBe("$poll");
  });
});
