import { beforeEach, vi } from "vitest";

const graphMessagesMockState = vi.hoisted(() => ({
  deleteGraphRequest: vi.fn(),
  fetchGraphJson: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
  postGraphBetaJson: vi.fn(),
  postGraphJson: vi.fn(),
  resolveGraphToken: vi.fn(),
}));

vi.mock("./graph.js", () => ({
    deleteGraphRequest: graphMessagesMockState.deleteGraphRequest,
    escapeOData: vi.fn((value: string) => value.replaceAll("'", "''")),
    fetchGraphJson: graphMessagesMockState.fetchGraphJson,
    postGraphBetaJson: graphMessagesMockState.postGraphBetaJson,
    postGraphJson: graphMessagesMockState.postGraphJson,
    resolveGraphToken: graphMessagesMockState.resolveGraphToken,
  }));

vi.mock("./conversation-store-fs.js", () => ({
  createMSTeamsConversationStoreFs: () => ({
    findPreferredDmByUserId: graphMessagesMockState.findPreferredDmByUserId,
  }),
}));

export const TOKEN = "test-graph-token";
export const CHAT_ID = "19:abc@thread.tacv2";
export const CHANNEL_TO = "team-id-1/channel-id-1";

export function getGraphMessagesMockState(): typeof graphMessagesMockState {
  return graphMessagesMockState;
}

export type GraphMessagesTestModule = typeof import("./graph-messages.js");

export function loadGraphMessagesTestModule(): Promise<GraphMessagesTestModule> {
  return import("./graph-messages.js");
}

export function installGraphMessagesMockDefaults(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    graphMessagesMockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });
}
