import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

interface GuidanceCase {
  file: string;
  required?: string[];
  forbidden?: string[];
}

const CASES: GuidanceCase[] = [
  {
    file: "skills/session-logs/SKILL.md",
    forbidden: [
      "for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl",
      'rg -l "phrase" ~/.openclaw/agents/<agentId>/sessions/*.jsonl',
      "~/.openclaw/agents/<agentId>/sessions/<id>.jsonl",
    ],
    required: ["OPENCLAW_STATE_DIR"],
  },
  {
    file: "skills/gh-issues/SKILL.md",
    forbidden: ["cat ~/.openclaw/openclaw.json"],
    required: ["OPENCLAW_CONFIG_PATH"],
  },
  {
    file: "skills/canvas/SKILL.md",
    forbidden: ["cat ~/.openclaw/openclaw.json"],
    required: ["OPENCLAW_CONFIG_PATH"],
  },
  {
    file: "skills/openai-whisper-api/SKILL.md",
    required: ["OPENCLAW_CONFIG_PATH"],
  },
  {
    file: "skills/sherpa-onnx-tts/SKILL.md",
    forbidden: [
      'SHERPA_ONNX_RUNTIME_DIR: "~/.openclaw/tools/sherpa-onnx-tts/runtime"',
      'SHERPA_ONNX_MODEL_DIR: "~/.openclaw/tools/sherpa-onnx-tts/models/vits-piper-en_US-lessac-high"',
      "<state-dir>",
    ],
    required: [
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      'STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"',
    ],
  },
  {
    file: "skills/coding-agent/SKILL.md",
    forbidden: ["NEVER start Codex in ~/.openclaw/"],
    required: ["OPENCLAW_STATE_DIR"],
  },
];

describe("bundled skill env-path guidance", () => {
  it.each(CASES)(
    "keeps $file aligned with OPENCLAW env overrides",
    ({ file, required, forbidden }) => {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const needle of required ?? []) {
        expect(content).toContain(needle);
      }
      for (const needle of forbidden ?? []) {
        expect(content).not.toContain(needle);
      }
    },
  );
});
