import { describe, expect, it } from "vitest";
import { buildDiscordInteractiveComponents } from "./shared-interactive.js";

describe("buildDiscordInteractiveComponents", () => {
  it("maps shared buttons and selects into Discord component blocks", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            buttons: [
              { label: "Approve", style: "success", value: "approve" },
              { label: "Reject", style: "danger", value: "reject" },
            ],
            type: "buttons",
          },
          {
            options: [{ label: "Alpha", value: "alpha" }],
            placeholder: "Pick one",
            type: "select",
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          buttons: [
            { callbackData: "approve", label: "Approve", style: "success" },
            { callbackData: "reject", label: "Reject", style: "danger" },
          ],
          type: "actions",
        },
        {
          select: {
            options: [{ label: "Alpha", value: "alpha" }],
            placeholder: "Pick one",
            type: "string",
          },
          type: "actions",
        },
      ],
    });
  });

  it("preserves authored shared text blocks around controls", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          { text: "First", type: "text" },
          {
            buttons: [{ label: "Approve", style: "success", value: "approve" }],
            type: "buttons",
          },
          { text: "Last", type: "text" },
        ],
      }),
    ).toEqual({
      blocks: [
        { text: "First", type: "text" },
        {
          buttons: [{ callbackData: "approve", label: "Approve", style: "success" }],
          type: "actions",
        },
        { text: "Last", type: "text" },
      ],
    });
  });

  it("splits long shared button rows to stay within Discord action limits", () => {
    expect(
      buildDiscordInteractiveComponents({
        blocks: [
          {
            buttons: [
              { label: "One", value: "1" },
              { label: "Two", value: "2" },
              { label: "Three", value: "3" },
              { label: "Four", value: "4" },
              { label: "Five", value: "5" },
              { label: "Six", value: "6" },
            ],
            type: "buttons",
          },
        ],
      }),
    ).toEqual({
      blocks: [
        {
          buttons: [
            { callbackData: "1", label: "One", style: "secondary" },
            { callbackData: "2", label: "Two", style: "secondary" },
            { callbackData: "3", label: "Three", style: "secondary" },
            { callbackData: "4", label: "Four", style: "secondary" },
            { callbackData: "5", label: "Five", style: "secondary" },
          ],
          type: "actions",
        },
        {
          buttons: [{ callbackData: "6", label: "Six", style: "secondary" }],
          type: "actions",
        },
      ],
    });
  });
});
