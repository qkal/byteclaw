import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginTools } from "../../plugins/tools.js";
import { ErrorCodes } from "../protocol/index.js";
import { toolsCatalogHandlers } from "./tools-catalog.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

const pluginToolMetaState = new Map<string, { pluginId: string; optional: boolean }>();

vi.mock("../../plugins/tools.js", () => ({
  getPluginToolMeta: vi.fn((tool: { name: string }) => pluginToolMetaState.get(tool.name)),
  resolvePluginTools: vi.fn(() => [
    { description: "Plugin calling tool", label: "voice_call", name: "voice_call" },
    {
      description: "Matrix room helper\n\nACTIONS:\n- join\n- leave",
      displaySummary: "Summarized Matrix room helper.",
      label: "matrix_room",
      name: "matrix_room",
    },
  ]),
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    invoke: async () =>
      await toolsCatalogHandlers["tools.catalog"]({
        client: null,
        context: {} as never,
        isWebchatConnect: () => false,
        params,
        req: { id: "req-1", method: "tools.catalog", type: "req" },
        respond: respond as never,
      }),
    respond,
  };
}

describe("tools.catalog handler", () => {
  beforeEach(() => {
    pluginToolMetaState.clear();
    pluginToolMetaState.set("voice_call", { optional: true, pluginId: "voice-call" });
    pluginToolMetaState.set("matrix_room", { optional: false, pluginId: "matrix" });
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ extra: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.catalog params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({ agentId: "unknown-agent" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
  });

  it("returns core groups including tts and excludes plugins when includePlugins=false", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          agentId: string;
          groups: {
            id: string;
            source: "core" | "plugin";
            tools: { id: string; source: "core" | "plugin" }[];
          }[];
        }
      | undefined;
    expect(payload?.agentId).toBe("main");
    expect(payload?.groups.some((group) => group.source === "plugin")).toBe(false);
    const media = payload?.groups.find((group) => group.id === "media");
    expect(media?.tools.some((tool) => tool.id === "tts" && tool.source === "core")).toBe(true);
  });

  it("includes plugin groups with plugin metadata", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          groups: {
            source: "core" | "plugin";
            pluginId?: string;
            tools: {
              id: string;
              source: "core" | "plugin";
              pluginId?: string;
              optional?: boolean;
            }[];
          }[];
        }
      | undefined;
    const pluginGroups = (payload?.groups ?? []).filter((group) => group.source === "plugin");
    expect(pluginGroups.length).toBeGreaterThan(0);
    const voiceCall = pluginGroups
      .flatMap((group) => group.tools)
      .find((tool) => tool.id === "voice_call");
    expect(voiceCall).toMatchObject({
      optional: true,
      pluginId: "voice-call",
      source: "plugin",
    });
  });

  it("summarizes plugin tool descriptions the same way as the effective inventory", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    const payload = call?.[1] as
      | {
          groups: {
            source: "core" | "plugin";
            tools: {
              id: string;
              description: string;
            }[];
          }[];
        }
      | undefined;
    const matrixRoom = (payload?.groups ?? [])
      .filter((group) => group.source === "plugin")
      .flatMap((group) => group.tools)
      .find((tool) => tool.id === "matrix_room");
    expect(matrixRoom?.description).toBe("Summarized Matrix room helper.");
  });

  it("opts plugin tool catalog loads into gateway subagent binding", async () => {
    const { invoke } = createInvokeParams({});

    await invoke();

    expect(vi.mocked(resolvePluginTools)).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
      }),
    );
  });
});
