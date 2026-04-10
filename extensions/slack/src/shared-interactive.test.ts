import { describe, expect, it } from "vitest";
import { buildSlackInteractiveBlocks } from "./blocks-render.js";

describe("buildSlackInteractiveBlocks", () => {
  it("renders shared interactive blocks in authored order", () => {
    expect(
      buildSlackInteractiveBlocks({
        blocks: [
          {
            options: [{ label: "Alpha", value: "alpha" }],
            placeholder: "Pick one",
            type: "select",
          },
          { text: "then", type: "text" },
          { buttons: [{ label: "Retry", value: "retry" }], type: "buttons" },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        block_id: "openclaw_reply_select_1",
        type: "actions",
      }),
      expect.objectContaining({
        text: expect.objectContaining({ text: "then" }),
        type: "section",
      }),
      expect.objectContaining({
        block_id: "openclaw_reply_buttons_1",
        type: "actions",
      }),
    ]);
  });

  it("truncates Slack render strings to Block Kit limits", () => {
    const long = "x".repeat(120);
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        { text: "y".repeat(3100), type: "text" },
        { options: [{ label: long, value: long }], placeholder: long, type: "select" },
        { buttons: [{ label: long, value: long }], type: "buttons" },
      ],
    });
    const section = blocks[0] as { text?: { text?: string } };
    const selectBlock = blocks[1] as {
      elements?: { placeholder?: { text?: string } }[];
    };
    const buttonBlock = blocks[2] as {
      elements?: { value?: string }[];
    };

    expect((section.text?.text ?? "").length).toBeLessThanOrEqual(3000);
    expect((selectBlock.elements?.[0]?.placeholder?.text ?? "").length).toBeLessThanOrEqual(75);
    expect(buttonBlock.elements?.[0]?.value).toBe(long);
  });

  it("preserves original callback payloads for round-tripping", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          buttons: [{ label: "Allow", value: "pluginbind:approval-123:o" }],
          type: "buttons",
        },
        {
          options: [{ label: "Approve", value: "codex:approve:thread-1" }],
          type: "select",
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: { action_id?: string; value?: string }[];
    };
    const selectBlock = blocks[1] as {
      elements?: {
        action_id?: string;
        options?: { value?: string }[];
      }[];
    };

    expect(buttonBlock.elements?.[0]?.action_id).toBe("openclaw:reply_button:1:1");
    expect(buttonBlock.elements?.[0]?.value).toBe("pluginbind:approval-123:o");
    expect(selectBlock.elements?.[0]?.action_id).toBe("openclaw:reply_select:1");
    expect(selectBlock.elements?.[0]?.options?.[0]?.value).toBe("codex:approve:thread-1");
  });

  it("maps supported button styles to Slack Block Kit styles", () => {
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        {
          buttons: [
            { label: "Approve", style: "primary", value: "approve" },
            { label: "Deny", style: "danger", value: "deny" },
            { label: "Confirm", style: "success", value: "confirm" },
            { label: "Skip", style: "secondary", value: "skip" },
          ],
          type: "buttons",
        },
      ],
    });

    const buttonBlock = blocks[0] as {
      elements?: { style?: string }[];
    };

    expect(buttonBlock.elements?.[0]?.style).toBe("primary");
    expect(buttonBlock.elements?.[1]?.style).toBe("danger");
    expect(buttonBlock.elements?.[2]?.style).toBe("primary");
    expect(buttonBlock.elements?.[3]).not.toHaveProperty("style");
  });
});
