import { describe, expect, it } from "vitest";
import { SYSTEM_MARK, hasSystemMark, prefixSystemMessage } from "./system-message.js";

describe("system-message", () => {
  it.each([
    {
      input: "thread notice",
      marked: false,
      prefixed: `${SYSTEM_MARK} thread notice`,
    },
    {
      input: `  thread notice  `,
      marked: false,
      prefixed: `${SYSTEM_MARK} thread notice`,
    },
    {
      input: "   ",
      marked: false,
      prefixed: "",
    },
    {
      input: `${SYSTEM_MARK} already prefixed`,
      marked: true,
      prefixed: `${SYSTEM_MARK} already prefixed`,
    },
    {
      input: `  ${SYSTEM_MARK} hello`,
      marked: true,
      prefixed: `${SYSTEM_MARK} hello`,
    },
    {
      input: SYSTEM_MARK,
      marked: true,
      prefixed: SYSTEM_MARK,
    },
    {
      input: `  ${SYSTEM_MARK}  `,
      marked: true,
      prefixed: SYSTEM_MARK,
    },
    {
      input: "",
      marked: false,
      prefixed: "",
    },
    {
      input: "hello",
      marked: false,
      prefixed: `${SYSTEM_MARK} hello`,
    },
  ])("handles %j", ({ input, prefixed, marked }) => {
    expect(prefixSystemMessage(input)).toBe(prefixed);
    expect(hasSystemMark(input)).toBe(marked);
  });
});
