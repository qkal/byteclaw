import { describe, expect, it } from "vitest";
import { parseNodeList, parsePairingList } from "./node-list-parse.js";

describe("shared/node-list-parse", () => {
  it("parses node.list payloads", () => {
    expect(parseNodeList({ nodes: [{ nodeId: "node-1" }] })).toEqual([{ nodeId: "node-1" }]);
    expect(parseNodeList({ nodes: "nope" })).toEqual([]);
    expect(parseNodeList(null)).toEqual([]);
    expect(parseNodeList(["not-an-object"])).toEqual([]);
  });

  it("parses node.pair.list payloads", () => {
    expect(
      parsePairingList({
        paired: [{ nodeId: "n1" }],
        pending: [
          {
            nodeId: "n1",
            requestId: "r1",
            requiredApproveScopes: ["operator.pairing"],
            ts: 1,
          },
        ],
      }),
    ).toEqual({
      paired: [{ nodeId: "n1" }],
      pending: [
        {
          nodeId: "n1",
          requestId: "r1",
          requiredApproveScopes: ["operator.pairing"],
          ts: 1,
        },
      ],
    });
    expect(parsePairingList({ paired: "x", pending: 1 })).toEqual({ paired: [], pending: [] });
    expect(parsePairingList(undefined)).toEqual({ paired: [], pending: [] });
    expect(parsePairingList(["not-an-object"])).toEqual({ paired: [], pending: [] });
  });

  it("preserves valid pairing arrays when the sibling field is malformed", () => {
    expect(
      parsePairingList({
        paired: "x",
        pending: [{ nodeId: "n1", requestId: "r1", ts: 1 }],
      }),
    ).toEqual({
      paired: [],
      pending: [{ nodeId: "n1", requestId: "r1", ts: 1 }],
    });

    expect(
      parsePairingList({
        paired: [{ nodeId: "n1" }],
        pending: 1,
      }),
    ).toEqual({
      paired: [{ nodeId: "n1" }],
      pending: [],
    });
  });
});
