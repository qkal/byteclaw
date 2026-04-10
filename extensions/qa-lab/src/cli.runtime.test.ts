import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runQaManualLane,
  runQaSuiteFromRuntime,
  runQaCharacterEval,
  runQaMultipass,
  startQaLabServer,
  writeQaDockerHarnessFiles,
  buildQaDockerHarnessImage,
  runQaDockerUp,
} = vi.hoisted(() => ({
  buildQaDockerHarnessImage: vi.fn(),
  runQaCharacterEval: vi.fn(),
  runQaDockerUp: vi.fn(),
  runQaManualLane: vi.fn(),
  runQaMultipass: vi.fn(),
  runQaSuiteFromRuntime: vi.fn(),
  startQaLabServer: vi.fn(),
  writeQaDockerHarnessFiles: vi.fn(),
}));

vi.mock("./manual-lane.runtime.js", () => ({
  runQaManualLane,
}));

vi.mock("./suite-launch.runtime.js", () => ({
  runQaSuiteFromRuntime,
}));

vi.mock("./character-eval.js", () => ({
  runQaCharacterEval,
}));

vi.mock("./multipass.runtime.js", () => ({
  runQaMultipass,
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

vi.mock("./docker-harness.js", () => ({
  buildQaDockerHarnessImage,
  writeQaDockerHarnessFiles,
}));

vi.mock("./docker-up.runtime.js", () => ({
  runQaDockerUp,
}));

import {
  runQaLabSelfCheckCommand,
  runQaDockerBuildImageCommand,
  runQaDockerScaffoldCommand,
  runQaDockerUpCommand,
  runQaCharacterEvalCommand,
  runQaManualLaneCommand,
  runQaSuiteCommand,
} from "./cli.runtime.js";

describe("qa cli runtime", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runQaSuiteFromRuntime.mockReset();
    runQaCharacterEval.mockReset();
    runQaManualLane.mockReset();
    runQaMultipass.mockReset();
    startQaLabServer.mockReset();
    writeQaDockerHarnessFiles.mockReset();
    buildQaDockerHarnessImage.mockReset();
    runQaDockerUp.mockReset();
    runQaSuiteFromRuntime.mockResolvedValue({
      reportPath: "/tmp/report.md",
      summaryPath: "/tmp/summary.json",
      watchUrl: "http://127.0.0.1:43124",
    });
    runQaCharacterEval.mockResolvedValue({
      reportPath: "/tmp/character-report.md",
      summaryPath: "/tmp/character-summary.json",
    });
    runQaManualLane.mockResolvedValue({
      model: "openai/gpt-5.4",
      reply: "done",
      waited: { status: "ok" },
      watchUrl: "http://127.0.0.1:43124",
    });
    runQaMultipass.mockResolvedValue({
      bootstrapLogPath: "/tmp/multipass/multipass-guest-bootstrap.log",
      guestScriptPath: "/tmp/multipass/multipass-guest-run.sh",
      hostLogPath: "/tmp/multipass/multipass-host.log",
      outputDir: "/tmp/multipass",
      reportPath: "/tmp/multipass/qa-suite-report.md",
      scenarioIds: ["channel-chat-baseline"],
      summaryPath: "/tmp/multipass/qa-suite-summary.json",
      vmName: "openclaw-qa-test",
    });
    startQaLabServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:58000",
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/report.md",
      }),
      stop: vi.fn(),
    });
    writeQaDockerHarnessFiles.mockResolvedValue({
      outputDir: "/tmp/openclaw-repo/.artifacts/qa-docker",
    });
    buildQaDockerHarnessImage.mockResolvedValue({
      imageName: "openclaw:qa-local-prebaked",
    });
    runQaDockerUp.mockResolvedValue({
      gatewayUrl: "http://127.0.0.1:18789/",
      outputDir: "/tmp/openclaw-repo/.artifacts/qa-docker",
      qaLabUrl: "http://127.0.0.1:43124",
      stopCommand: "docker compose down",
    });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    vi.clearAllMocks();
  });

  it("resolves suite repo-root-relative paths before dispatching", async () => {
    await runQaSuiteCommand({
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      outputDir: ".artifacts/qa/frontier",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith({
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/frontier"),
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioIds: ["approval-turn-tool-followthrough"],
    });
  });

  it("normalizes legacy live-openai suite runs onto the frontier provider mode", async () => {
    await runQaSuiteCommand({
      providerMode: "live-openai",
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: "live-frontier",
        repoRoot: path.resolve("/tmp/openclaw-repo"),
      }),
    );
  });

  it("passes host suite concurrency through", async () => {
    await runQaSuiteCommand({
      concurrency: 3,
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        concurrency: 3,
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
      }),
    );
  });

  it("resolves character eval paths and passes model refs through", async () => {
    await runQaCharacterEvalCommand({
      blindJudgeModels: true,
      concurrency: 4,
      fast: true,
      judgeConcurrency: 3,
      judgeModel: ["openai/gpt-5.4,thinking=xhigh,fast", "anthropic/claude-opus-4-6,thinking=high"],
      judgeTimeoutMs: 180_000,
      model: [
        "openai/gpt-5.4,thinking=xhigh,fast=false",
        "codex-cli/test-model,thinking=high,fast",
      ],
      modelThinking: ["codex-cli/test-model=medium"],
      outputDir: ".artifacts/qa/character",
      repoRoot: "/tmp/openclaw-repo",
      scenario: "character-vibes-gollum",
      thinking: "medium",
    });

    expect(runQaCharacterEval).toHaveBeenCalledWith({
      candidateConcurrency: 4,
      candidateFastMode: true,
      candidateModelOptions: {
        "codex-cli/test-model": { fastMode: true, thinkingDefault: "high" },
        "openai/gpt-5.4": { fastMode: false, thinkingDefault: "xhigh" },
      },
      candidateThinkingByModel: { "codex-cli/test-model": "medium" },
      candidateThinkingDefault: "medium",
      judgeBlindModels: true,
      judgeConcurrency: 3,
      judgeModelOptions: {
        "anthropic/claude-opus-4-6": { thinkingDefault: "high" },
        "openai/gpt-5.4": { fastMode: true, thinkingDefault: "xhigh" },
      },
      judgeModels: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
      judgeTimeoutMs: 180_000,
      models: ["openai/gpt-5.4", "codex-cli/test-model"],
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/character"),
      progress: expect.any(Function),
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioId: "character-vibes-gollum",
    });
  });

  it("lets character eval auto-select candidate fast mode when --fast is omitted", async () => {
    await runQaCharacterEvalCommand({
      model: ["openai/gpt-5.4"],
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaCharacterEval).toHaveBeenCalledWith({
      candidateConcurrency: undefined,
      candidateFastMode: undefined,
      candidateModelOptions: undefined,
      candidateThinkingByModel: undefined,
      candidateThinkingDefault: undefined,
      judgeBlindModels: undefined,
      judgeConcurrency: undefined,
      judgeModelOptions: undefined,
      judgeModels: undefined,
      judgeTimeoutMs: undefined,
      models: ["openai/gpt-5.4"],
      outputDir: undefined,
      progress: expect.any(Function),
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioId: undefined,
    });
  });

  it("rejects invalid character eval thinking levels", async () => {
    await expect(
      runQaCharacterEvalCommand({
        model: ["openai/gpt-5.4"],
        repoRoot: "/tmp/openclaw-repo",
        thinking: "enormous",
      }),
    ).rejects.toThrow("--thinking must be one of");

    await expect(
      runQaCharacterEvalCommand({
        model: ["openai/gpt-5.4,thinking=galaxy"],
        repoRoot: "/tmp/openclaw-repo",
      }),
    ).rejects.toThrow("--model thinking must be one of");

    await expect(
      runQaCharacterEvalCommand({
        model: ["openai/gpt-5.4,warp"],
        repoRoot: "/tmp/openclaw-repo",
      }),
    ).rejects.toThrow("--model options must be thinking=<level>");

    await expect(
      runQaCharacterEvalCommand({
        model: ["openai/gpt-5.4"],
        modelThinking: ["openai/gpt-5.4"],
        repoRoot: "/tmp/openclaw-repo",
      }),
    ).rejects.toThrow("--model-thinking must use provider/model=level");
  });

  it("passes the explicit repo root into manual runs", async () => {
    await runQaManualLaneCommand({
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      message: "read qa kickoff and reply short",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
      timeoutMs: 45_000,
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      message: "read qa kickoff and reply short",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      timeoutMs: 45_000,
    });
  });

  it("routes suite runs through multipass when the runner is selected", async () => {
    await runQaSuiteCommand({
      concurrency: 3,
      cpus: 2,
      disk: "24G",
      image: "lts",
      memory: "4G",
      outputDir: ".artifacts/qa-multipass",
      providerMode: "mock-openai",
      repoRoot: "/tmp/openclaw-repo",
      runner: "multipass",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaMultipass).toHaveBeenCalledWith({
      alternateModel: undefined,
      concurrency: 3,
      cpus: 2,
      disk: "24G",
      fastMode: undefined,
      image: "lts",
      memory: "4G",
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-multipass"),
      primaryModel: undefined,
      providerMode: "mock-openai",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioIds: ["channel-chat-baseline"],
    });
    expect(runQaSuiteFromRuntime).not.toHaveBeenCalled();
  });

  it("passes live suite selection through to the multipass runner", async () => {
    await runQaSuiteCommand({
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
      runner: "multipass",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaMultipass).toHaveBeenCalledWith(
      expect.objectContaining({
        alternateModel: "openai/gpt-5.4",
        fastMode: true,
        primaryModel: "openai/gpt-5.4",
        providerMode: "live-frontier",
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
  });

  it("rejects multipass-only suite flags on the host runner", async () => {
    await expect(
      runQaSuiteCommand({
        image: "lts",
        repoRoot: "/tmp/openclaw-repo",
        runner: "host",
      }),
    ).rejects.toThrow("--image, --cpus, --memory, and --disk require --runner multipass.");
  });

  it("defaults manual mock runs onto the mock-openai model lane", async () => {
    await runQaManualLaneCommand({
      message: "read qa kickoff and reply short",
      providerMode: "mock-openai",
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      alternateModel: "mock-openai/gpt-5.4-alt",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      primaryModel: "mock-openai/gpt-5.4",
      providerMode: "mock-openai",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      timeoutMs: undefined,
    });
  });

  it("defaults manual frontier runs onto the frontier model lane", async () => {
    await runQaManualLaneCommand({
      message: "read qa kickoff and reply short",
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      alternateModel: "openai/gpt-5.4",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      primaryModel: "openai/gpt-5.4",
      providerMode: "live-frontier",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      timeoutMs: undefined,
    });
  });

  it("keeps an explicit manual primary model as the alternate default", async () => {
    await runQaManualLaneCommand({
      message: "read qa kickoff and reply short",
      primaryModel: "anthropic/claude-sonnet-4-6",
      providerMode: "live-frontier",
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      primaryModel: "anthropic/claude-sonnet-4-6",
      providerMode: "live-frontier",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      timeoutMs: undefined,
    });
  });

  it("normalizes legacy live-openai manual runs onto the frontier provider mode", async () => {
    await runQaManualLaneCommand({
      message: "read qa kickoff and reply short",
      providerMode: "live-openai",
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaManualLane).toHaveBeenCalledWith(
      expect.objectContaining({
        alternateModel: "openai/gpt-5.4",
        primaryModel: "openai/gpt-5.4",
        providerMode: "live-frontier",
        repoRoot: path.resolve("/tmp/openclaw-repo"),
      }),
    );
  });

  it("resolves self-check repo-root-relative paths before starting the lab server", async () => {
    await runQaLabSelfCheckCommand({
      output: ".artifacts/qa/self-check.md",
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(startQaLabServer).toHaveBeenCalledWith({
      outputPath: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/self-check.md"),
      repoRoot: path.resolve("/tmp/openclaw-repo"),
    });
  });

  it("resolves docker scaffold paths relative to the explicit repo root", async () => {
    await runQaDockerScaffoldCommand({
      outputDir: ".artifacts/qa-docker",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      repoRoot: "/tmp/openclaw-repo",
      usePrebuiltImage: true,
    });

    expect(writeQaDockerHarnessFiles).toHaveBeenCalledWith({
      gatewayPort: undefined,
      imageName: undefined,
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-docker"),
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      qaLabPort: undefined,
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      usePrebuiltImage: true,
    });
  });

  it("passes the explicit repo root into docker image builds", async () => {
    await runQaDockerBuildImageCommand({
      image: "openclaw:qa-local-prebaked",
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(buildQaDockerHarnessImage).toHaveBeenCalledWith({
      imageName: "openclaw:qa-local-prebaked",
      repoRoot: path.resolve("/tmp/openclaw-repo"),
    });
  });

  it("resolves docker up paths relative to the explicit repo root", async () => {
    await runQaDockerUpCommand({
      outputDir: ".artifacts/qa-up",
      repoRoot: "/tmp/openclaw-repo",
      skipUiBuild: true,
      usePrebuiltImage: true,
    });

    expect(runQaDockerUp).toHaveBeenCalledWith({
      gatewayPort: undefined,
      image: undefined,
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-up"),
      providerBaseUrl: undefined,
      qaLabPort: undefined,
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      skipUiBuild: true,
      usePrebuiltImage: true,
    });
  });
});
