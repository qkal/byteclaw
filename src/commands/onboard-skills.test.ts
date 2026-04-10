import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  detectBinary: vi.fn(),
  installSkill: vi.fn(),
  resolveNodeManagerOptions: vi.fn(() => [
    { label: "npm", value: "npm" },
    { label: "pnpm", value: "pnpm" },
    { label: "bun", value: "bun" },
  ]),
}));

// Module under test imports these at module scope.
vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../agents/skills-install.js", () => ({
  installSkill: mocks.installSkill,
}));
vi.mock("./onboard-helpers.js", () => ({
  detectBinary: mocks.detectBinary,
  resolveNodeManagerOptions: mocks.resolveNodeManagerOptions,
}));

import { setupSkills } from "./onboard-skills.js";

function createBundledSkill(params: {
  name: string;
  description: string;
  bins: string[];
  os?: string[];
  installLabel: string;
}): {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  configChecks: [];
  install: { id: string; kind: string; label: string; bins: string[] }[];
} {
  return {
    always: false,
    baseDir: `/tmp/skills/${params.name}`,
    blockedByAllowlist: false,
    bundled: true,
    configChecks: [],
    description: params.description,
    disabled: false,
    eligible: false,
    filePath: `/tmp/skills/${params.name}`,
    install: [{ bins: params.bins, id: "brew", kind: "brew", label: params.installLabel }],
    missing: { anyBins: [], bins: params.bins, config: [], env: [], os: params.os ?? [] },
    name: params.name,
    requirements: { anyBins: [], bins: params.bins, config: [], env: [], os: params.os ?? [] },
    skillKey: params.name,
    source: "openclaw-bundled",
  };
}

function mockMissingBrewStatus(skills: ReturnType<typeof createBundledSkill>[]): void {
  mocks.detectBinary.mockResolvedValue(false);
  mocks.installSkill.mockResolvedValue({
    code: 0,
    message: "Installed",
    ok: true,
    stderr: "",
    stdout: "",
  });
  mocks.buildWorkspaceSkillStatus.mockReturnValue({
    managedSkillsDir: "/tmp/managed",
    skills,
    workspaceDir: "/tmp/ws",
  } as never);
}

function createPrompter(params: {
  configure?: boolean;
  showBrewInstall?: boolean;
  multiselect?: string[];
}): { prompter: WizardPrompter; notes: { title?: string; message: string }[] } {
  const notes: { title?: string; message: string }[] = [];

  const confirmAnswers: boolean[] = [];
  confirmAnswers.push(params.configure ?? true);

  const prompter: WizardPrompter = {
    confirm: vi.fn(async ({ message }) => {
      if (message === "Show Homebrew install command?") {
        return params.showBrewInstall ?? false;
      }
      return confirmAnswers.shift() ?? false;
    }),
    intro: vi.fn(async () => {}),
    multiselect: vi.fn(
      async () => params.multiselect ?? ["__skip__"],
    ) as unknown as WizardPrompter["multiselect"],
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ message, title });
    }),
    outro: vi.fn(async () => {}),
    progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
    select: vi.fn(async () => "npm") as unknown as WizardPrompter["select"],
    text: vi.fn(async () => ""),
  };

  return { notes, prompter };
}

const runtime: RuntimeEnv = {
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
  log: vi.fn(),
};

describe("setupSkills", () => {
  it("does not recommend Homebrew when user skips installing brew-backed deps", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        bins: ["remindctl"],
        description: "macOS-only",
        installLabel: "Install remindctl (brew)",
        name: "apple-reminders",
        os: ["darwin"],
      }),
      createBundledSkill({
        bins: ["ffmpeg"],
        description: "ffmpeg",
        installLabel: "Install ffmpeg (brew)",
        name: "video-frames",
      }),
    ]);

    const { prompter, notes } = createPrompter({ multiselect: ["__skip__"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    // OS-mismatched skill should be counted as unsupported, not installable/missing.
    const status = notes.find((n) => n.title === "Skills status")?.message ?? "";
    expect(status).toContain("Unsupported on this OS: 1");

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote).toBeUndefined();
  });

  it("recommends Homebrew when user selects a brew-backed install and brew is missing", async () => {
    if (process.platform === "win32") {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        bins: ["ffmpeg"],
        description: "ffmpeg",
        installLabel: "Install ffmpeg (brew)",
        name: "video-frames",
      }),
    ]);

    const { prompter, notes } = createPrompter({ multiselect: ["video-frames"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote).toBeDefined();
  });
});
