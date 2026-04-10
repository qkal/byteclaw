import { describe, expect, it } from "vitest";
import { hasLineDirectives, parseLineDirectives } from "./reply-payload-transform.js";

const getLineData = (result: ReturnType<typeof parseLineDirectives>) =>
  (result.channelData?.line as Record<string, unknown> | undefined) ?? {};

describe("hasLineDirectives", () => {
  it("matches expected detection across directive patterns", () => {
    const cases: { text: string; expected: boolean }[] = [
      { expected: true, text: "Here are options [[quick_replies: A, B, C]]" },
      { expected: true, text: "[[location: Place | Address | 35.6 | 139.7]]" },
      { expected: true, text: "[[confirm: Continue? | Yes | No]]" },
      { expected: true, text: "[[buttons: Menu | Choose | Opt1:data1, Opt2:data2]]" },
      { expected: false, text: "Just regular text" },
      { expected: false, text: "[[not_a_directive: something]]" },
      { expected: true, text: "[[media_player: Song | Artist | Speaker]]" },
      { expected: true, text: "[[event: Meeting | Jan 24 | 2pm]]" },
      { expected: true, text: "[[agenda: Today | Meeting:9am, Lunch:12pm]]" },
      { expected: true, text: "[[device: TV | Room]]" },
      { expected: true, text: "[[appletv_remote: Apple TV | Playing]]" },
    ];

    for (const testCase of cases) {
      expect(hasLineDirectives(testCase.text)).toBe(testCase.expected);
    }
  });
});

describe("parseLineDirectives", () => {
  describe("quick_replies", () => {
    it("parses quick replies variants", () => {
      const cases: {
        text: string;
        channelData?: { line: { quickReplies: string[] } };
        quickReplies: string[];
        outputText?: string;
      }[] = [
        {
          outputText: "Choose one:",
          quickReplies: ["Option A", "Option B", "Option C"],
          text: "Choose one:\n[[quick_replies: Option A, Option B, Option C]]",
        },
        {
          outputText: "Before  After",
          quickReplies: ["A", "B"],
          text: "Before [[quick_replies: A, B]] After",
        },
        {
          channelData: { line: { quickReplies: ["A", "B"] } },
          outputText: "Text",
          quickReplies: ["A", "B", "C", "D"],
          text: "Text [[quick_replies: C, D]]",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({
          channelData: testCase.channelData,
          text: testCase.text,
        });
        expect(getLineData(result).quickReplies).toEqual(testCase.quickReplies);
        if (testCase.outputText !== undefined) {
          expect(result.text).toBe(testCase.outputText);
        }
      }
    });
  });

  describe("location", () => {
    it("parses location variants", () => {
      const existing = { address: "Addr", latitude: 1, longitude: 2, title: "Existing" };
      const cases: {
        text: string;
        channelData?: { line: { location: typeof existing } };
        location?: typeof existing;
        outputText?: string;
      }[] = [
        {
          location: {
            address: "Tokyo, Japan",
            latitude: 35.6812,
            longitude: 139.7671,
            title: "Tokyo Station",
          },
          outputText: "Here's the location:",
          text: "Here's the location:\n[[location: Tokyo Station | Tokyo, Japan | 35.6812 | 139.7671]]",
        },
        {
          location: undefined,
          text: "[[location: Place | Address | invalid | 139.7]]",
        },
        {
          channelData: { line: { location: existing } },
          location: existing,
          text: "[[location: New | New Addr | 35.6 | 139.7]]",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({
          channelData: testCase.channelData,
          text: testCase.text,
        });
        expect(getLineData(result).location).toEqual(testCase.location);
        if (testCase.outputText !== undefined) {
          expect(result.text).toBe(testCase.outputText);
        }
      }
    });
  });

  describe("confirm", () => {
    it("parses confirm directives with default and custom action payloads", () => {
      const cases = [
        {
          expectedTemplate: {
            altText: "Delete this item?",
            cancelData: "no",
            cancelLabel: "No",
            confirmData: "yes",
            confirmLabel: "Yes",
            text: "Delete this item?",
            type: "confirm",
          },
          expectedText: undefined,
          name: "default yes/no data",
          text: "[[confirm: Delete this item? | Yes | No]]",
        },
        {
          expectedTemplate: {
            altText: "Proceed?",
            cancelData: "action=cancel",
            cancelLabel: "Cancel",
            confirmData: "action=confirm",
            confirmLabel: "OK",
            text: "Proceed?",
            type: "confirm",
          },
          expectedText: undefined,
          name: "custom action data",
          text: "[[confirm: Proceed? | OK:action=confirm | Cancel:action=cancel]]",
        },
      ] as const;

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        expect(getLineData(result).templateMessage, testCase.name).toEqual(
          testCase.expectedTemplate,
        );
        expect(result.text, testCase.name).toBe(testCase.expectedText);
      }
    });
  });

  describe("buttons", () => {
    it("parses message/uri/postback button actions and enforces action caps", () => {
      const cases = [
        {
          expectedTemplate: {
            actions: [
              { data: "/help", label: "Help", type: "message" },
              { data: "/status", label: "Status", type: "message" },
            ],
            altText: "Menu: Select an option",
            text: "Select an option",
            title: "Menu",
            type: "buttons",
          },
          name: "message actions",
          text: "[[buttons: Menu | Select an option | Help:/help, Status:/status]]",
        },
        {
          expectedFirstAction: {
            label: "Site",
            type: "uri",
            uri: "https://example.com",
          },
          name: "uri action",
          text: "[[buttons: Links | Visit us | Site:https://example.com]]",
        },
        {
          expectedFirstAction: {
            data: "action=select&id=1",
            label: "Select",
            type: "postback",
          },
          name: "postback action",
          text: "[[buttons: Actions | Choose | Select:action=select&id=1]]",
        },
        {
          expectedActionCount: 4,
          name: "action cap",
          text: "[[buttons: Menu | Text | A:a, B:b, C:c, D:d, E:e, F:f]]",
        },
      ] as const;

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const templateMessage = getLineData(result).templateMessage as {
          type?: string;
          actions?: Record<string, unknown>[];
        };
        expect(templateMessage?.type, testCase.name).toBe("buttons");
        if ("expectedTemplate" in testCase) {
          expect(templateMessage, testCase.name).toEqual(testCase.expectedTemplate);
        }
        if ("expectedFirstAction" in testCase) {
          expect(templateMessage?.actions?.[0], testCase.name).toEqual(
            testCase.expectedFirstAction,
          );
        }
        if ("expectedActionCount" in testCase) {
          expect(templateMessage?.actions?.length, testCase.name).toBe(
            testCase.expectedActionCount,
          );
        }
      }
    });
  });

  describe("media_player", () => {
    it("parses media_player directives across full/minimal/paused variants", () => {
      const cases = [
        {
          expectBodyContents: false,
          expectFooter: true,
          expectedAltText: "🎵 Bohemian Rhapsody - Queen",
          expectedText: "Now playing:",
          name: "all fields",
          text: "Now playing:\n[[media_player: Bohemian Rhapsody | Queen | Speaker | https://example.com/album.jpg | playing]]",
        },
        {
          expectBodyContents: false,
          expectFooter: false,
          expectedAltText: "🎵 Unknown Track",
          expectedText: undefined,
          name: "minimal",
          text: "[[media_player: Unknown Track]]",
        },
        {
          expectBodyContents: true,
          expectFooter: false,
          expectedAltText: undefined,
          expectedText: undefined,
          name: "paused status",
          text: "[[media_player: Song | Artist | Player | | paused]]",
        },
      ] as const;

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as {
          altText?: string;
          contents?: { footer?: { contents?: unknown[] }; body?: { contents?: unknown[] } };
        };
        expect(flexMessage, testCase.name).toBeDefined();
        if (testCase.expectedAltText !== undefined) {
          expect(flexMessage?.altText, testCase.name).toBe(testCase.expectedAltText);
        }
        if (testCase.expectedText !== undefined) {
          expect(result.text, testCase.name).toBe(testCase.expectedText);
        }
        if (testCase.expectFooter) {
          expect(flexMessage?.contents?.footer?.contents?.length, testCase.name).toBeGreaterThan(0);
        }
        if ("expectBodyContents" in testCase && testCase.expectBodyContents) {
          expect(flexMessage?.contents?.body?.contents, testCase.name).toBeDefined();
        }
      }
    });
  });

  describe("event", () => {
    it("parses event variants", () => {
      const cases = [
        {
          altText: "📅 Team Meeting - January 24, 2026 2:00 PM - 3:00 PM",
          text: "[[event: Team Meeting | January 24, 2026 | 2:00 PM - 3:00 PM | Conference Room A | Discuss Q1 roadmap]]",
        },
        {
          altText: "📅 Birthday Party - March 15",
          text: "[[event: Birthday Party | March 15]]",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        expect(flexMessage?.altText).toBe(testCase.altText);
      }
    });
  });

  describe("agenda", () => {
    it("parses agenda variants", () => {
      const cases = [
        {
          altText: "📋 Today's Schedule (3 events)",
          text: "[[agenda: Today's Schedule | Team Meeting:9:00 AM, Lunch:12:00 PM, Review:3:00 PM]]",
        },
        {
          altText: "📋 Tasks (3 events)",
          text: "[[agenda: Tasks | Buy groceries, Call mom, Workout]]",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        expect(flexMessage?.altText).toBe(testCase.altText);
      }
    });
  });

  describe("device", () => {
    it("parses device variants", () => {
      const cases = [
        {
          altText: "📱 TV: Playing",
          text: "[[device: TV | Streaming Box | Playing | Play/Pause:toggle, Menu:menu]]",
        },
        {
          altText: "📱 Speaker",
          text: "[[device: Speaker]]",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        expect(flexMessage?.altText).toBe(testCase.altText);
      }
    });
  });

  describe("appletv_remote", () => {
    it("parses appletv remote variants", () => {
      const cases = [
        {
          contains: "Apple TV",
          text: "[[appletv_remote: Apple TV | Playing]]",
        },
        {
          contains: undefined,
          text: "[[appletv_remote: Apple TV]]",
        },
      ];

      for (const testCase of cases) {
        const result = parseLineDirectives({ text: testCase.text });
        const flexMessage = getLineData(result).flexMessage as { altText?: string };
        expect(flexMessage).toBeDefined();
        if (testCase.contains) {
          expect(flexMessage?.altText).toContain(testCase.contains);
        }
      }
    });
  });

  describe("combined directives", () => {
    it("handles text with no directives", () => {
      const result = parseLineDirectives({
        text: "Just plain text here",
      });

      expect(result.text).toBe("Just plain text here");
      expect(getLineData(result).quickReplies).toBeUndefined();
      expect(getLineData(result).location).toBeUndefined();
      expect(getLineData(result).templateMessage).toBeUndefined();
    });

    it("preserves other payload fields", () => {
      const result = parseLineDirectives({
        mediaUrl: "https://example.com/image.jpg",
        replyToId: "msg123",
        text: "Hello [[quick_replies: A, B]]",
      });

      expect(result.mediaUrl).toBe("https://example.com/image.jpg");
      expect(result.replyToId).toBe("msg123");
      expect(getLineData(result).quickReplies).toEqual(["A", "B"]);
    });
  });
});
