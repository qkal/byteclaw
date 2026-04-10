import { describe, expect, it } from "vitest";
import {
  buildMatrixReactionContent,
  buildMatrixReactionRelationsPath,
  extractMatrixReactionAnnotation,
  selectOwnMatrixReactionEventIds,
  summarizeMatrixReactionEvents,
} from "./reaction-common.js";

describe("matrix reaction helpers", () => {
  it("builds trimmed reaction content and relation paths", () => {
    expect(buildMatrixReactionContent(" $msg ", " 👍 ")).toEqual({
      "m.relates_to": {
        event_id: "$msg",
        key: "👍",
        rel_type: "m.annotation",
      },
    });
    expect(buildMatrixReactionRelationsPath("!room:example.org", " $msg ")).toContain(
      "/rooms/!room%3Aexample.org/relations/%24msg/m.annotation/m.reaction",
    );
  });

  it("summarizes reactions by emoji and unique sender", () => {
    expect(
      summarizeMatrixReactionEvents([
        { content: { "m.relates_to": { key: "👍" } }, sender: "@alice:example.org" },
        { content: { "m.relates_to": { key: "👍" } }, sender: "@alice:example.org" },
        { content: { "m.relates_to": { key: "👍" } }, sender: "@bob:example.org" },
        { content: { "m.relates_to": { key: "👎" } }, sender: "@alice:example.org" },
        { content: {}, sender: "@ignored:example.org" },
      ]),
    ).toEqual([
      {
        count: 3,
        key: "👍",
        users: ["@alice:example.org", "@bob:example.org"],
      },
      {
        count: 1,
        key: "👎",
        users: ["@alice:example.org"],
      },
    ]);
  });

  it("selects only matching reaction event ids for the current user", () => {
    expect(
      selectOwnMatrixReactionEventIds(
        [
          {
            content: { "m.relates_to": { key: "👍" } },
            event_id: "$1",
            sender: "@me:example.org",
          },
          {
            content: { "m.relates_to": { key: "👎" } },
            event_id: "$2",
            sender: "@me:example.org",
          },
          {
            content: { "m.relates_to": { key: "👍" } },
            event_id: "$3",
            sender: "@other:example.org",
          },
        ],
        "@me:example.org",
        "👍",
      ),
    ).toEqual(["$1"]);
  });

  it("extracts annotations and ignores non-annotation relations", () => {
    expect(
      extractMatrixReactionAnnotation({
        "m.relates_to": {
          event_id: " $msg ",
          key: " 👍 ",
          rel_type: "m.annotation",
        },
      }),
    ).toEqual({
      eventId: "$msg",
      key: "👍",
    });
    expect(
      extractMatrixReactionAnnotation({
        "m.relates_to": {
          event_id: "$msg",
          key: "👍",
          rel_type: "m.replace",
        },
      }),
    ).toBeUndefined();
  });
});
