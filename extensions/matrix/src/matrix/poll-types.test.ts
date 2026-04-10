import { describe, expect, it } from "vitest";
import {
  buildPollResponseContent,
  buildPollResultsSummary,
  buildPollStartContent,
  formatPollResultsAsText,
  parsePollResponseAnswerIds,
  parsePollStart,
  parsePollStartContent,
  resolvePollReferenceEventId,
} from "./poll-types.js";

describe("parsePollStartContent", () => {
  it("parses legacy m.poll payloads", () => {
    const summary = parsePollStartContent({
      "m.poll": {
        answers: [
          { id: "answer1", "m.text": "Yes" },
          { id: "answer2", "m.text": "No" },
        ],
        kind: "m.poll.disclosed",
        max_selections: 1,
        question: { "m.text": "Lunch?" },
      },
    });

    expect(summary?.question).toBe("Lunch?");
    expect(summary?.answers).toEqual(["Yes", "No"]);
  });

  it("preserves answer ids when parsing poll start content", () => {
    const parsed = parsePollStart({
      "m.poll.start": {
        answers: [
          { id: "a1", "m.text": "Yes" },
          { id: "a2", "m.text": "No" },
        ],
        kind: "m.poll.disclosed",
        max_selections: 1,
        question: { "m.text": "Lunch?" },
      },
    });

    expect(parsed).toMatchObject({
      answers: [
        { id: "a1", text: "Yes" },
        { id: "a2", text: "No" },
      ],
      maxSelections: 1,
      question: "Lunch?",
    });
  });

  it("caps invalid remote max selections to the available answer count", () => {
    const parsed = parsePollStart({
      "m.poll.start": {
        answers: [
          { id: "a1", "m.text": "Yes" },
          { id: "a2", "m.text": "No" },
        ],
        kind: "m.poll.undisclosed",
        max_selections: 99,
        question: { "m.text": "Lunch?" },
      },
    });

    expect(parsed?.maxSelections).toBe(2);
  });
});

describe("buildPollStartContent", () => {
  it("preserves the requested multiselect cap instead of widening to all answers", () => {
    const content = buildPollStartContent({
      maxSelections: 2,
      options: ["Pizza", "Sushi", "Tacos"],
      question: "Lunch?",
    });

    expect(content["m.poll.start"]?.max_selections).toBe(2);
    expect(content["m.poll.start"]?.kind).toBe("m.poll.undisclosed");
  });
});

describe("buildPollResponseContent", () => {
  it("builds a poll response payload with a reference relation", () => {
    expect(buildPollResponseContent("$poll", ["a2"])).toEqual({
      "m.poll.response": {
        answers: ["a2"],
      },
      "m.relates_to": {
        event_id: "$poll",
        rel_type: "m.reference",
      },
      "org.matrix.msc3381.poll.response": {
        answers: ["a2"],
      },
    });
  });
});

describe("poll relation parsing", () => {
  it("parses stable and unstable poll response answer ids", () => {
    expect(
      parsePollResponseAnswerIds({
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
      }),
    ).toEqual(["a1"]);
    expect(
      parsePollResponseAnswerIds({
        "org.matrix.msc3381.poll.response": { answers: ["a2"] },
      }),
    ).toEqual(["a2"]);
  });

  it("extracts poll relation targets", () => {
    expect(
      resolvePollReferenceEventId({
        "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
      }),
    ).toBe("$poll");
  });
});

describe("buildPollResultsSummary", () => {
  it("counts only the latest valid response from each sender", () => {
    const summary = buildPollResultsSummary({
      content: {
        "m.poll.start": {
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
          kind: "m.poll.disclosed",
          max_selections: 1,
          question: { "m.text": "Lunch?" },
        },
      },
      pollEventId: "$poll",
      relationEvents: [
        {
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
          },
          event_id: "$vote1",
          origin_server_ts: 1,
          sender: "@bob:example.org",
          type: "m.poll.response",
        },
        {
          content: {
            "m.poll.response": { answers: ["a2"] },
            "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
          },
          event_id: "$vote2",
          origin_server_ts: 2,
          sender: "@bob:example.org",
          type: "m.poll.response",
        },
        {
          content: {
            "m.poll.response": { answers: [] },
            "m.relates_to": { event_id: "$poll", rel_type: "m.reference" },
          },
          event_id: "$vote3",
          origin_server_ts: 3,
          sender: "@carol:example.org",
          type: "m.poll.response",
        },
      ],
      roomId: "!room:example.org",
      sender: "@alice:example.org",
      senderName: "Alice",
    });

    expect(summary?.entries).toEqual([
      { id: "a1", text: "Pizza", votes: 0 },
      { id: "a2", text: "Sushi", votes: 1 },
    ]);
    expect(summary?.totalVotes).toBe(1);
  });

  it("formats disclosed poll results with vote totals", () => {
    const text = formatPollResultsAsText({
      answers: ["Pizza", "Sushi"],
      closed: false,
      entries: [
        { id: "a1", text: "Pizza", votes: 1 },
        { id: "a2", text: "Sushi", votes: 0 },
      ],
      eventId: "$poll",
      kind: "m.poll.disclosed",
      maxSelections: 1,
      question: "Lunch?",
      roomId: "!room:example.org",
      sender: "@alice:example.org",
      senderName: "Alice",
      totalVotes: 1,
    });

    expect(text).toContain("1. Pizza (1 vote)");
    expect(text).toContain("Total voters: 1");
  });
});
