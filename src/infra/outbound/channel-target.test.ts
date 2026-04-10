import { describe, expect, it } from "vitest";
import { applyTargetToParams } from "./channel-target.js";

describe("applyTargetToParams", () => {
  it.each([
    {
      expected: "channel:C1",
      field: "to",
      params: {
        action: "send",
        args: { target: "  channel:C1  " } as Record<string, unknown>,
      },
    },
    {
      expected: "C123",
      field: "channelId",
      params: {
        action: "channel-info",
        args: { target: "  C123  " } as Record<string, unknown>,
      },
    },
  ])("maps trimmed target into configured field for %j", ({ params, field, expected }) => {
    applyTargetToParams(params);
    expect(params.args[field]).toBe(expected);
  });

  it("throws on legacy destination fields when the action has canonical target support", () => {
    expect(() =>
      applyTargetToParams({
        action: "send",
        args: {
          target: "channel:C1",
          to: "legacy",
        },
      }),
    ).toThrow("Use `target` instead of `to`/`channelId`.");
  });

  it.each([
    {
      expectedMessage: "Use `target` for actions that accept a destination.",
      params: {
        action: "broadcast",
        args: {
          to: "legacy",
        },
      },
    },
    {
      expectedMessage: "Action broadcast does not accept a target.",
      params: {
        action: "broadcast",
        args: {
          target: "channel:C1",
        },
      },
    },
  ])("throws on invalid no-target action destination for %j", ({ params, expectedMessage }) => {
    expect(() => applyTargetToParams(params)).toThrow(expectedMessage);
  });

  it("does nothing when target is blank", () => {
    const params = {
      action: "send",
      args: { target: "   " } as Record<string, unknown>,
    };

    applyTargetToParams(params);

    expect(params.args).toEqual({ target: "   " });
  });
});
