import { describe, expect, it } from "vitest";
import { buildTelegramInteractiveButtons, resolveTelegramInlineButtons } from "./button-types.js";

export function describeTelegramInteractiveButtonBehavior(): void {
  describe("buildTelegramInteractiveButtons", () => {
    it("maps shared buttons and selects into Telegram inline rows", () => {
      expect(
        buildTelegramInteractiveButtons({
          blocks: [
            {
              buttons: [
                { label: "Approve", style: "success", value: "approve" },
                { label: "Reject", style: "danger", value: "reject" },
                { label: "Later", value: "later" },
                { label: "Archive", value: "archive" },
              ],
              type: "buttons",
            },
            {
              options: [{ label: "Alpha", value: "alpha" }],
              type: "select",
            },
          ],
        }),
      ).toEqual([
        [
          { callback_data: "approve", style: "success", text: "Approve" },
          { callback_data: "reject", style: "danger", text: "Reject" },
          { callback_data: "later", style: undefined, text: "Later" },
        ],
        [{ callback_data: "archive", style: undefined, text: "Archive" }],
        [{ callback_data: "alpha", style: undefined, text: "Alpha" }],
      ]);
    });
  });

  describe("resolveTelegramInlineButtons", () => {
    it("prefers explicit buttons over shared interactive blocks", () => {
      const explicit = [[{ callback_data: "keep", text: "Keep" }]] as const;

      expect(
        resolveTelegramInlineButtons({
          buttons: explicit,
          interactive: {
            blocks: [
              {
                buttons: [{ label: "Override", value: "override" }],
                type: "buttons",
              },
            ],
          },
        }),
      ).toBe(explicit);
    });

    it("derives buttons from raw interactive payloads", () => {
      expect(
        resolveTelegramInlineButtons({
          interactive: {
            blocks: [
              {
                buttons: [{ label: "Retry", style: "primary", value: "retry" }],
                type: "buttons",
              },
            ],
          },
        }),
      ).toEqual([[{ callback_data: "retry", style: "primary", text: "Retry" }]]);
    });
  });
}
