import { describe, expect, it } from "vitest";
import {
  createDefaultQaRunSelection,
  createIdleQaRunnerSnapshot,
  createQaRunOutputDir,
  normalizeQaRunSelection,
} from "./run-config.js";

const scenarios = [
  {
    id: "dm-chat-baseline",
    objective: "test DM",
    successCriteria: ["reply"],
    surface: "dm",
    title: "DM baseline",
  },
  {
    id: "thread-lifecycle",
    objective: "test thread",
    successCriteria: ["thread reply"],
    surface: "thread",
    title: "Thread lifecycle",
  },
];

describe("qa run config", () => {
  it("creates a synthetic-by-default selection that arms every scenario", () => {
    expect(createDefaultQaRunSelection(scenarios)).toEqual({
      alternateModel: "mock-openai/gpt-5.4-alt",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.4",
      providerMode: "mock-openai",
      scenarioIds: ["dm-chat-baseline", "thread-lifecycle"],
    });
  });

  it("normalizes live selections and filters unknown scenario ids", () => {
    expect(
      normalizeQaRunSelection(
        {
          alternateModel: "",
          fastMode: false,
          primaryModel: "openai/gpt-5.4",
          providerMode: "live-openai",
          scenarioIds: ["thread-lifecycle", "missing", "thread-lifecycle"],
        },
        scenarios,
      ),
    ).toEqual({
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      scenarioIds: ["thread-lifecycle"],
    });
  });

  it("falls back to all scenarios when selection would otherwise be empty", () => {
    const snapshot = createIdleQaRunnerSnapshot(scenarios);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.selection.scenarioIds).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
    expect(
      normalizeQaRunSelection(
        {
          scenarioIds: [],
        },
        scenarios,
      ).scenarioIds,
    ).toEqual(["dm-chat-baseline", "thread-lifecycle"]);
  });

  it("anchors generated run output dirs under the provided repo root", () => {
    const outputDir = createQaRunOutputDir("/tmp/openclaw-repo");
    expect(outputDir.startsWith("/tmp/openclaw-repo/.artifacts/qa-e2e/lab-")).toBe(true);
  });
});
