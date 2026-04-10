import { beforeEach, describe, expect, test } from "vitest";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  resetToolPolicyWarningCacheForTest,
} from "./tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "./tool-policy.js";

interface DummyTool {
  name: string;
}

function runAllowlistWarningStep(params: {
  allow: string[];
  label: string;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
}) {
  const warnings: string[] = [];
  const tools = [{ name: "exec" }] as unknown as DummyTool[];
  applyToolPolicyPipeline({
    steps: [
      {
        label: params.label,
        policy: { allow: params.allow },
        stripPluginOnlyAllowlist: true,
        suppressUnavailableCoreToolWarning: params.suppressUnavailableCoreToolWarning,
        suppressUnavailableCoreToolWarningAllowlist:
          params.suppressUnavailableCoreToolWarningAllowlist,
      },
    ],
    toolMeta: () => undefined,
    tools: tools as any,
    warn: (msg) => warnings.push(msg),
  });
  return warnings;
}

describe("tool-policy-pipeline", () => {
  beforeEach(() => {
    resetToolPolicyWarningCacheForTest();
  });

  test("preserves plugin-only allowlists instead of silently stripping them", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      steps: [
        {
          label: "tools.allow",
          policy: { allow: ["plugin_tool"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: (t: any) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
      tools: tools as any,
      warn: () => {},
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toEqual(["plugin_tool"]);
  });

  test("warns about unknown allowlist entries", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      steps: [
        {
          label: "tools.allow",
          policy: { allow: ["wat"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: (msg) => warnings.push(msg),
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (wat)");
  });

  test("suppresses built-in profile warnings for unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings).toEqual([]);
  });

  test("still warns for profile steps when explicit alsoAllow entries are present", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "browser"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (browser)");
    expect(warnings[0]).not.toContain("apply_patch");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
  });

  test("still warns for explicit allowlists that mention unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.allow",
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown entries (apply_patch)");
    expect(warnings[0]).toContain(
      "shipped core tools but unavailable in the current runtime/provider/model/config",
    );
    expect(warnings[0]).not.toContain("Allowlist contains only plugin entries");
    expect(warnings[0]).not.toContain("unless the plugin is enabled");
  });

  test("default profile steps suppress unavailable baseline profile entries", () => {
    const warnings: string[] = [];
    const profilePolicy = resolveToolProfilePolicy("coding");
    applyToolPolicyPipeline({
      steps: buildDefaultToolPolicyPipelineSteps({
        profile: "coding",
        profilePolicy,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
      }),
      toolMeta: () => undefined,
      tools: [{ name: "exec" }] as any,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings).toEqual([]);
  });

  test("dedupes identical unknown-allowlist warnings across repeated runs", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    const params = {
      steps: [
        {
          label: "tools.allow",
          policy: { allow: ["wat"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: (msg: string) => warnings.push(msg),
    };

    applyToolPolicyPipeline(params);
    applyToolPolicyPipeline(params);

    expect(warnings).toHaveLength(1);
  });

  test("bounds the warning dedupe cache so new warnings still surface", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 257; i += 1) {
      applyToolPolicyPipeline({
        steps: [
          {
            label: "tools.profile (coding)",
            policy: { allow: [`unknown_${i}`] },
            stripPluginOnlyAllowlist: true,
          },
        ],
        toolMeta: () => undefined,
        tools: tools as any,
        warn: (msg: string) => warnings.push(msg),
      });
    }

    applyToolPolicyPipeline({
      steps: [
        {
          label: "tools.profile (coding)",
          policy: { allow: ["unknown_0"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: (msg: string) => warnings.push(msg),
    });

    expect(warnings).toHaveLength(258);
  });

  test("evicts the oldest warning when the dedupe cache is full", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 256; i += 1) {
      applyToolPolicyPipeline({
        steps: [
          {
            label: "tools.allow",
            policy: { allow: [`unknown_${i}`] },
            stripPluginOnlyAllowlist: true,
          },
        ],
        toolMeta: () => undefined,
        tools: tools as any,
        warn: (msg: string) => warnings.push(msg),
      });
    }

    warnings.length = 0;

    applyToolPolicyPipeline({
      steps: [
        {
          label: "tools.allow",
          policy: { allow: ["unknown_256"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: (msg: string) => warnings.push(msg),
    });
    applyToolPolicyPipeline({
      steps: [
        { label: "tools.allow", policy: { allow: ["unknown_0"] }, stripPluginOnlyAllowlist: true },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: (msg: string) => warnings.push(msg),
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("unknown_0");
  });

  test("applies allowlist filtering when core tools are explicitly listed", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      steps: [
        {
          label: "tools.allow",
          policy: { allow: ["exec"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: () => {},
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  test("applies deny filtering after allow filtering", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      steps: [
        {
          label: "tools.allow",
          policy: { allow: ["exec", "process"], deny: ["process"] },
          stripPluginOnlyAllowlist: true,
        },
      ],
      toolMeta: () => undefined,
      tools: tools as any,
      warn: () => {},
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });
});
