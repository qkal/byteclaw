import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { listMatrixReactions, removeMatrixReactions } from "./reactions.js";

function createReactionsClient(params: {
  chunk: {
    event_id?: string;
    sender?: string;
    key?: string;
  }[];
  userId?: string | null;
}) {
  const doRequest = vi.fn(async (_method: string, _path: string, _query: unknown) => ({
    chunk: params.chunk.map((item) => ({
      content: item.key
        ? {
            "m.relates_to": {
              event_id: "$target",
              key: item.key,
              rel_type: "m.annotation",
            },
          }
        : {},
      event_id: item.event_id ?? "",
      sender: item.sender ?? "",
    })),
  }));
  const getUserId = vi.fn(async () => params.userId ?? null);
  const redactEvent = vi.fn(async () => undefined);

  return {
    client: {
      doRequest,
      getUserId,
      redactEvent,
      stop: vi.fn(),
    } as unknown as MatrixClient,
    doRequest,
    redactEvent,
  };
}

describe("matrix reaction actions", () => {
  it("aggregates reactions by key and unique sender", async () => {
    const { client, doRequest } = createReactionsClient({
      chunk: [
        { event_id: "$1", key: "👍", sender: "@alice:example.org" },
        { event_id: "$2", key: "👍", sender: "@bob:example.org" },
        { event_id: "$3", key: "👎", sender: "@alice:example.org" },
        { event_id: "$4", sender: "@bot:example.org" },
      ],
      userId: "@bot:example.org",
    });

    const result = await listMatrixReactions("!room:example.org", "$msg", { client, limit: 2.9 });

    expect(doRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("/rooms/!room%3Aexample.org/relations/%24msg/"),
      expect.objectContaining({ limit: 2 }),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          count: 2,
          key: "👍",
          users: expect.arrayContaining(["@alice:example.org", "@bob:example.org"]),
        }),
        expect.objectContaining({
          count: 1,
          key: "👎",
          users: ["@alice:example.org"],
        }),
      ]),
    );
  });

  it("removes only current-user reactions matching emoji filter", async () => {
    const { client, redactEvent } = createReactionsClient({
      chunk: [
        { event_id: "$1", key: "👍", sender: "@me:example.org" },
        { event_id: "$2", key: "👎", sender: "@me:example.org" },
        { event_id: "$3", key: "👍", sender: "@other:example.org" },
      ],
      userId: "@me:example.org",
    });

    const result = await removeMatrixReactions("!room:example.org", "$msg", {
      client,
      emoji: "👍",
    });

    expect(result).toEqual({ removed: 1 });
    expect(redactEvent).toHaveBeenCalledTimes(1);
    expect(redactEvent).toHaveBeenCalledWith("!room:example.org", "$1");
  });

  it("returns removed=0 when current user id is unavailable", async () => {
    const { client, redactEvent } = createReactionsClient({
      chunk: [{ event_id: "$1", key: "👍", sender: "@me:example.org" }],
      userId: null,
    });

    const result = await removeMatrixReactions("!room:example.org", "$msg", { client });

    expect(result).toEqual({ removed: 0 });
    expect(redactEvent).not.toHaveBeenCalled();
  });

  it("returns an empty list when the relations response is malformed", async () => {
    const doRequest = vi.fn(async () => ({ chunk: null }));
    const client = {
      doRequest,
      getUserId: vi.fn(async () => "@me:example.org"),
      redactEvent: vi.fn(async () => undefined),
      stop: vi.fn(),
    } as unknown as MatrixClient;

    const result = await listMatrixReactions("!room:example.org", "$msg", { client });

    expect(result).toEqual([]);
  });

  it("rejects blank message ids before querying Matrix relations", async () => {
    const { client, doRequest } = createReactionsClient({
      chunk: [],
      userId: "@me:example.org",
    });

    await expect(listMatrixReactions("!room:example.org", "   ", { client })).rejects.toThrow(
      "messageId",
    );
    expect(doRequest).not.toHaveBeenCalled();
  });
});
