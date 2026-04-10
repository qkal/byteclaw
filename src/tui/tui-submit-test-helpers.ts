import { vi } from "vitest";
import { createEditorSubmitHandler } from "./tui-submit.js";

type MockFn = ReturnType<typeof vi.fn>;

export interface SubmitHarness {
  editor: {
    setText: MockFn;
    addToHistory: MockFn;
  };
  handleCommand: MockFn;
  sendMessage: MockFn;
  handleBangLine: MockFn;
  onSubmit: (text: string) => void;
}

export function createSubmitHarness(): SubmitHarness {
  const editor = {
    addToHistory: vi.fn(),
    setText: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleBangLine,
    handleCommand,
    sendMessage,
  });
  return { editor, handleBangLine, handleCommand, onSubmit, sendMessage };
}
