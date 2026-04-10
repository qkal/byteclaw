import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock, stylePromptMessageMock, stylePromptHintMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  stylePromptHintMock: vi.fn((value: string) => `hint:${value}`),
  stylePromptMessageMock: vi.fn((value: string) => `msg:${value}`),
}));

vi.mock("@clack/prompts", () => ({
  select: selectMock,
}));

vi.mock("./prompt-style.js", () => ({
  stylePromptHint: stylePromptHintMock,
  stylePromptMessage: stylePromptMessageMock,
}));

import { selectStyled } from "./prompt-select-styled.js";

describe("selectStyled", () => {
  beforeEach(() => {
    selectMock.mockClear();
    stylePromptMessageMock.mockClear();
    stylePromptHintMock.mockClear();
  });

  it("styles message and option hints before delegating to clack select", () => {
    const expected = Symbol("selected");
    selectMock.mockReturnValue(expected);

    const result = selectStyled({
      message: "Pick channel",
      options: [
        { hint: "Tagged releases", label: "Stable", value: "stable" },
        { label: "Dev", value: "dev" },
      ],
    });

    expect(result).toBe(expected);
    expect(stylePromptMessageMock).toHaveBeenCalledWith("Pick channel");
    expect(stylePromptHintMock).toHaveBeenCalledWith("Tagged releases");
    expect(selectMock).toHaveBeenCalledWith({
      message: "msg:Pick channel",
      options: [
        { hint: "hint:Tagged releases", label: "Stable", value: "stable" },
        { label: "Dev", value: "dev" },
      ],
    });
  });
});
