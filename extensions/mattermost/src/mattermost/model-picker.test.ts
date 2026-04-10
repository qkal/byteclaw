import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";

const data = {
  byProvider: new Map<string, Set<string>>([
    ["anthropic", new Set(["claude-opus-4-5", "claude-sonnet-4-5"])],
    ["openai", new Set(["gpt-4.1", "gpt-5"])],
  ]),
  modelNames: new Map<string, string>(),
  providers: ["anthropic", "openai"],
  resolvedDefault: {
    model: "claude-opus-4-5",
    provider: "anthropic",
  },
};

describe("Mattermost model picker", () => {
  it("resolves bare /model and /models entry points", () => {
    expect(resolveMattermostModelPickerEntry("/model")).toEqual({ kind: "summary" });
    expect(resolveMattermostModelPickerEntry("/models")).toEqual({ kind: "providers" });
    expect(resolveMattermostModelPickerEntry("/models OpenAI")).toEqual({
      kind: "models",
      provider: "openai",
    });
    expect(resolveMattermostModelPickerEntry("/model openai/gpt-5")).toBeNull();
  });

  it("builds the allowed model refs set", () => {
    expect(buildMattermostAllowedModelRefs(data)).toEqual(
      new Set([
        "anthropic/claude-opus-4-5",
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-4.1",
        "openai/gpt-5",
      ]),
    );
  });

  it("renders the summary view with a browse button", () => {
    const view = renderMattermostModelSummaryView({
      currentModel: "openai/gpt-5",
      ownerUserId: "user-1",
    });

    expect(view.text).toContain("Current: openai/gpt-5");
    expect(view.text).toContain("Tap below to browse models");
    expect(view.text).toContain("/oc_model <provider/model> to switch");
    expect(view.buttons[0]?.[0]?.text).toBe("Browse providers");
  });

  it("trims accidental model spacing in Mattermost current-model text", () => {
    const view = renderMattermostModelSummaryView({
      currentModel: " OpenAI/ gpt-5 ",
      ownerUserId: "user-1",
    });

    expect(view.text).toContain("Current: openai/gpt-5");
  });

  it("renders providers and models with Telegram-style navigation", () => {
    const providersView = renderMattermostProviderPickerView({
      currentModel: "openai/gpt-5",
      data,
      ownerUserId: "user-1",
    });
    const providerTexts = providersView.buttons.flat().map((button) => button.text);
    expect(providerTexts).toContain("anthropic (2)");
    expect(providerTexts).toContain("openai (2)");

    const modelsView = renderMattermostModelsPickerView({
      currentModel: "openai/gpt-5",
      data,
      ownerUserId: "user-1",
      page: 1,
      provider: "openai",
    });
    const modelTexts = modelsView.buttons.flat().map((button) => button.text);
    expect(modelsView.text).toContain("Models (openai) - 2 available");
    expect(modelTexts).toContain("gpt-5 [current]");
    expect(modelTexts).toContain("Back to providers");
  });

  it("renders unique alphanumeric action ids per button", () => {
    const modelsView = renderMattermostModelsPickerView({
      currentModel: "openai/gpt-5",
      data,
      ownerUserId: "user-1",
      page: 1,
      provider: "openai",
    });

    const ids = modelsView.buttons.flat().map((button) => button.id);
    expect(ids.every((id) => typeof id === "string" && /^[a-z0-9]+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses signed picker contexts", () => {
    expect(
      parseMattermostModelPickerContext({
        action: "select",
        model: "gpt-5",
        oc_model_picker: true,
        ownerUserId: "user-1",
        page: 2,
        provider: "openai",
      }),
    ).toEqual({
      action: "select",
      model: "gpt-5",
      ownerUserId: "user-1",
      page: 2,
      provider: "openai",
    });
    expect(parseMattermostModelPickerContext({ action: "select" })).toBeNull();
  });

  it("falls back to the routed agent default model when no override is stored", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-model-picker-"));
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
          },
          list: [
            {
              id: "support",
              model: "openai/gpt-5",
            },
          ],
        },
        session: {
          store: path.join(testDir, "{agentId}.json"),
        },
      };
      const providerData = {
        byProvider: new Map<string, Set<string>>([
          ["anthropic", new Set(["claude-opus-4-5"])],
          ["openai", new Set(["gpt-5"])],
        ]),
        modelNames: new Map<string, string>(),
        providers: ["anthropic", "openai"],
        resolvedDefault: {
          model: "gpt-5",
          provider: "openai",
        },
      };

      expect(
        resolveMattermostModelPickerCurrentModel({
          cfg,
          data: providerData,
          route: {
            agentId: "support",
            sessionKey: "agent:support:main",
          },
        }),
      ).toBe("openai/gpt-5");
    } finally {
      fs.rmSync(testDir, { force: true, recursive: true });
    }
  });
});
