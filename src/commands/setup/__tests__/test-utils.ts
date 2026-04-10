import { vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";

export const makeRuntime = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv => ({
  error: vi.fn(),
  exit: vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as RuntimeEnv["exit"],
  log: vi.fn(),
  ...overrides,
});

export const makePrompter = (overrides: Partial<WizardPrompter> = {}): WizardPrompter => ({
  confirm: vi.fn(async () => false),
  intro: vi.fn(async () => {}),
  multiselect: vi.fn(async () => []) as WizardPrompter["multiselect"],
  note: vi.fn(async () => {}),
  outro: vi.fn(async () => {}),
  progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
  select: vi.fn(async () => "npm") as WizardPrompter["select"],
  text: vi.fn(async () => "") as WizardPrompter["text"],
  ...overrides,
});
