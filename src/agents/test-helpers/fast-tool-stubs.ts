import { vi } from "vitest";

export interface StubTool {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown> };
  // Keep the exported type portable: don't leak Vitest's mock types into .d.ts.
  execute: (...args: unknown[]) => unknown;
}

export const stubTool = (name: string): StubTool => ({
  description: `${name} stub`,
  execute: vi.fn() as unknown as (...args: unknown[]) => unknown,
  name,
  parameters: { properties: {}, type: "object" },
});

vi.mock("../tools/image-tool.js", () => ({
  createImageTool: () => stubTool("image"),
}));

vi.mock("../tools/image-generate-tool.js", () => ({
  createImageGenerateTool: () => stubTool("image_generate"),
}));

vi.mock("../tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: () => stubTool("video_generate"),
}));

vi.mock("../tools/web-tools.js", () => ({
  createWebFetchTool: () => null,
  createWebSearchTool: () => null,
}));

vi.mock("../../plugins/tools.js", async () => {
  const mod =
    await vi.importActual<typeof import("../../plugins/tools.js")>("../../plugins/tools.js");
  return {
    ...mod,
    getPluginToolMeta: () => undefined,
    resolvePluginTools: () => [],
  };
});
