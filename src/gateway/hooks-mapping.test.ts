import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

const baseUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

describe("hooks mapping", () => {
  const gmailPayload = { messages: [{ subject: "Hello" }] };

  function expectSkippedTransformResult(result: Awaited<ReturnType<typeof applyHookMappings>>) {
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action).toBeNull();
      expect("skipped" in result).toBe(true);
    }
  }

  function createGmailAgentMapping(params: {
    id: string;
    messageTemplate: string;
    model?: string;
    agentId?: string;
  }) {
    return {
      action: "agent" as const,
      id: params.id,
      match: { path: "gmail" },
      messageTemplate: params.messageTemplate,
      ...(params.model ? { model: params.model } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    };
  }

  async function applyGmailMappings(config: Parameters<typeof resolveHookMappings>[0]) {
    const mappings = resolveHookMappings(config);
    return applyHookMappings(mappings, {
      headers: {},
      path: "gmail",
      payload: gmailPayload,
      url: baseUrl,
    });
  }

  function expectAgentMessage(
    result: Awaited<ReturnType<typeof applyHookMappings>> | undefined,
    expectedMessage: string,
  ) {
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe(expectedMessage);
    }
  }

  async function expectBlockedPrototypeTraversal(params: {
    id: string;
    messageTemplate: string;
    payload: Record<string, unknown>;
    expectedMessage: string;
  }) {
    const mappings = resolveHookMappings({
      mappings: [
        createGmailAgentMapping({
          id: params.id,
          messageTemplate: params.messageTemplate,
        }),
      ],
    });
    const result = await applyHookMappings(mappings, {
      headers: {},
      path: "gmail",
      payload: params.payload,
      url: baseUrl,
    });
    expectAgentMessage(result, params.expectedMessage);
  }

  async function applyNullTransformFromTempConfig(params: {
    configDir: string;
    transformsDir?: string;
  }) {
    const transformsRoot = path.join(params.configDir, "hooks", "transforms");
    const transformsDir = params.transformsDir
      ? path.join(transformsRoot, params.transformsDir)
      : transformsRoot;
    fs.mkdirSync(transformsDir, { recursive: true });
    fs.writeFileSync(path.join(transformsDir, "transform.mjs"), "export default () => null;");

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            action: "agent",
            match: { path: "skip" },
            transform: { module: "transform.mjs" },
          },
        ],
        transformsDir: params.transformsDir,
      },
      { configDir: params.configDir },
    );

    return applyHookMappings(mappings, {
      headers: {},
      path: "skip",
      payload: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
    });
  }

  it("resolves gmail preset", () => {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings[0]?.matchPath).toBe("gmail");
  });

  it("renders template from payload", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "demo",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expectAgentMessage(result, "Subject: Hello");
  });

  it("passes model override from mapping", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "demo",
          messageTemplate: "Subject: {{messages[0].subject}}",
          model: "openai/gpt-4.1-mini",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === "agent") {
      expect(result.action.model).toBe("openai/gpt-4.1-mini");
    }
  });

  it("runs transform module", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "transform.mjs");
    const placeholder = "${payload.name}";
    fs.writeFileSync(
      modPath,
      `export default ({ payload }) => ({ kind: "wake", text: \`Ping ${placeholder}\` });`,
    );

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            action: "agent",
            match: { path: "custom" },
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applyHookMappings(mappings, {
      headers: {},
      path: "custom",
      payload: { name: "Ada" },
      url: new URL("http://127.0.0.1:18789/hooks/custom"),
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "wake") {
      expect(result.action.kind).toBe("wake");
      expect(result.action.text).toBe("Ping Ada");
    }
  });

  it("rejects transform module traversal outside transformsDir", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-traversal-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              action: "agent",
              match: { path: "custom" },
              transform: { module: "../evil.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);
  });

  it("rejects absolute transform module path outside transformsDir", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-abs-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const outside = path.join(os.tmpdir(), "evil.mjs");
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              action: "agent",
              match: { path: "custom" },
              transform: { module: outside },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);
  });

  it("rejects transformsDir traversal outside the transforms root", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-trav-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              action: "agent",
              match: { path: "custom" },
              transform: { module: "transform.mjs" },
            },
          ],
          transformsDir: "..",
        },
        { configDir },
      ),
    ).toThrow(/Hook transformsDir/);
  });

  it("rejects transformsDir absolute path outside the transforms root", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-abs-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              action: "agent",
              match: { path: "custom" },
              transform: { module: "transform.mjs" },
            },
          ],
          transformsDir: os.tmpdir(),
        },
        { configDir },
      ),
    ).toThrow(/Hook transformsDir/);
  });

  it("accepts transformsDir subdirectory within the transforms root", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-ok-"));
    const result = await applyNullTransformFromTempConfig({ configDir, transformsDir: "subdir" });
    expectSkippedTransformResult(result);
  });

  it.runIf(process.platform !== "win32")(
    "rejects transform module symlink escape outside transformsDir",
    () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-module-"));
      const transformsRoot = path.join(configDir, "hooks", "transforms");
      fs.mkdirSync(transformsRoot, { recursive: true });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outside-module-"));
      const outsideModule = path.join(outsideDir, "evil.mjs");
      fs.writeFileSync(outsideModule, 'export default () => ({ kind: "wake", text: "owned" });');
      fs.symlinkSync(outsideModule, path.join(transformsRoot, "linked.mjs"));
      expect(() =>
        resolveHookMappings(
          {
            mappings: [
              {
                action: "agent",
                match: { path: "custom" },
                transform: { module: "linked.mjs" },
              },
            ],
          },
          { configDir },
        ),
      ).toThrow(/must be within/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects transformsDir symlink escape outside transforms root",
    () => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-dir-"));
      const transformsRoot = path.join(configDir, "hooks", "transforms");
      fs.mkdirSync(transformsRoot, { recursive: true });
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outside-dir-"));
      fs.writeFileSync(path.join(outsideDir, "transform.mjs"), "export default () => null;");
      fs.symlinkSync(outsideDir, path.join(transformsRoot, "escape"), "dir");
      expect(() =>
        resolveHookMappings(
          {
            mappings: [
              {
                action: "agent",
                match: { path: "custom" },
                transform: { module: "transform.mjs" },
              },
            ],
            transformsDir: "escape",
          },
          { configDir },
        ),
      ).toThrow(/Hook transformsDir/);
    },
  );

  it.runIf(process.platform !== "win32")("accepts in-root transform module symlink", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-ok-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    const nestedDir = path.join(transformsRoot, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "transform.mjs"), "export default () => null;");
    fs.symlinkSync(path.join(nestedDir, "transform.mjs"), path.join(transformsRoot, "linked.mjs"));

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            action: "agent",
            match: { path: "skip" },
            transform: { module: "linked.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applyHookMappings(mappings, {
      headers: {},
      path: "skip",
      payload: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
    });

    expectSkippedTransformResult(result);
  });

  it("treats null transform as a handled skip", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-skip-"));
    const result = await applyNullTransformFromTempConfig({ configDir });
    expectSkippedTransformResult(result);
  });

  it("prefers explicit mappings over presets", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "override",
          messageTemplate: "Override subject: {{messages[0].subject}}",
        }),
      ],
      presets: ["gmail"],
    });
    expectAgentMessage(result, "Override subject: Hello");
  });

  it("passes agentId from mapping", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          agentId: "hooks",
          id: "hooks-agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("hooks");
    }
  });

  it("agentId is undefined when not set", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "no-agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBeUndefined();
    }
  });

  it("caches transform functions by module path and export name", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-export-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "multi-export.mjs");
    fs.writeFileSync(
      modPath,
      [
        'export function transformA() { return { kind: "wake", text: "from-A" }; }',
        'export function transformB() { return { kind: "wake", text: "from-B" }; }',
      ].join("\n"),
    );

    const mappingsA = resolveHookMappings(
      {
        mappings: [
          {
            action: "agent",
            match: { path: "testA" },
            messageTemplate: "unused",
            transform: { export: "transformA", module: "multi-export.mjs" },
          },
        ],
      },
      { configDir },
    );

    const mappingsB = resolveHookMappings(
      {
        mappings: [
          {
            action: "agent",
            match: { path: "testB" },
            messageTemplate: "unused",
            transform: { export: "transformB", module: "multi-export.mjs" },
          },
        ],
      },
      { configDir },
    );

    const resultA = await applyHookMappings(mappingsA, {
      headers: {},
      path: "testA",
      payload: {},
      url: new URL("http://127.0.0.1:18789/hooks/testA"),
    });

    const resultB = await applyHookMappings(mappingsB, {
      headers: {},
      path: "testB",
      payload: {},
      url: new URL("http://127.0.0.1:18789/hooks/testB"),
    });

    expect(resultA?.ok).toBe(true);
    if (resultA?.ok && resultA.action?.kind === "wake") {
      expect(resultA.action.text).toBe("from-A");
    }

    expect(resultB?.ok).toBe(true);
    if (resultB?.ok && resultB.action?.kind === "wake") {
      expect(resultB.action.text).toBe("from-B");
    }
  });

  it("rejects missing message", async () => {
    const mappings = resolveHookMappings({
      mappings: [{ action: "agent", match: { path: "noop" } }],
    });
    const result = await applyHookMappings(mappings, {
      headers: {},
      path: "noop",
      payload: {},
      url: new URL("http://127.0.0.1:18789/hooks/noop"),
    });
    expect(result?.ok).toBe(false);
  });

  describe("prototype pollution protection", () => {
    it("blocks __proto__ traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        expectedMessage: "value: ",
        id: "proto-test",
        messageTemplate: "value: {{__proto__}}",
        payload: { __proto__: { polluted: true } } as Record<string, unknown>,
      });
    });

    it("blocks constructor traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        expectedMessage: "type: ",
        id: "constructor-test",
        messageTemplate: "type: {{constructor.name}}",
        payload: { constructor: { name: "INJECTED" } } as Record<string, unknown>,
      });
    });

    it("blocks prototype traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        expectedMessage: "val: ",
        id: "prototype-test",
        messageTemplate: "val: {{prototype}}",
        payload: { prototype: "leaked" } as Record<string, unknown>,
      });
    });
  });
});
