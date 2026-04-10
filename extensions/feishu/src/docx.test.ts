import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolLike, createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuToolAccountMock = vi.hoisted(() => vi.fn());
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.hoisted(() => vi.fn());
const convertMock = vi.hoisted(() => vi.fn());
const documentCreateMock = vi.hoisted(() => vi.fn());
const blockListMock = vi.hoisted(() => vi.fn());
const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
const blockChildrenGetMock = vi.hoisted(() => vi.fn());
const blockChildrenBatchDeleteMock = vi.hoisted(() => vi.fn());
const blockDescendantCreateMock = vi.hoisted(() => vi.fn());
const driveUploadAllMock = vi.hoisted(() => vi.fn());
const permissionMemberCreateMock = vi.hoisted(() => vi.fn());
const blockPatchMock = vi.hoisted(() => vi.fn());
const scopeListMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");
const runtimeModule = await import("./runtime.js");

vi.spyOn(toolAccountModule, "createFeishuToolClient").mockImplementation(() =>
  createFeishuClientMock(),
);
vi.spyOn(toolAccountModule, "resolveAnyEnabledFeishuToolsConfig").mockReturnValue({
  chat: false,
  doc: true,
  drive: false,
  perm: false,
  scopes: false,
  wiki: false,
});
vi.spyOn(toolAccountModule, "resolveFeishuToolAccount").mockImplementation((...args) =>
  resolveFeishuToolAccountMock(...args),
);
vi.spyOn(runtimeModule, "getFeishuRuntime").mockImplementation(
  () =>
    ({
      channel: {
        media: {
          fetchRemoteMedia: fetchRemoteMediaMock,
          saveMediaBuffer: vi.fn(),
        },
      },
      media: {
        detectMime: vi.fn(async () => "application/octet-stream"),
        getImageMetadata: vi.fn(async () => null),
        isVoiceCompatibleAudio: vi.fn(() => false),
        loadWebMedia: loadWebMediaMock,
        mediaKindFromMime: vi.fn(() => "image"),
        resizeToJpeg: vi.fn(async () => Buffer.alloc(0)),
      },
    }) as unknown as ReturnType<typeof runtimeModule.getFeishuRuntime>,
);

const { registerFeishuDocTools } = await import("./docx.js");

interface ToolResultWithDetails {
  details: Record<string, unknown>;
}

describe("feishu_doc image fetch hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      application: {
        scope: {
          list: scopeListMock,
        },
      },
      docx: {
        document: {
          convert: convertMock,
          create: documentCreateMock,
        },
        documentBlock: {
          list: blockListMock,
          patch: blockPatchMock,
        },
        documentBlockChildren: {
          batchDelete: blockChildrenBatchDeleteMock,
          create: blockChildrenCreateMock,
          get: blockChildrenGetMock,
        },
        documentBlockDescendant: {
          create: blockDescendantCreateMock,
        },
      },
      drive: {
        media: {
          uploadAll: driveUploadAllMock,
        },
        permissionMember: {
          create: permissionMemberCreateMock,
        },
      },
    });
    resolveFeishuToolAccountMock.mockReturnValue({
      config: { mediaMaxMb: 30 },
    });

    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks: [{ block_type: 27 }],
        first_level_block_ids: [],
      },
    });

    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: [],
      },
    });

    blockChildrenCreateMock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_id: "img_block_1", block_type: 27 }],
      },
    });

    blockChildrenGetMock.mockResolvedValue({
      code: 0,
      data: { items: [{ block_id: "placeholder_block_1" }] },
    });
    blockChildrenBatchDeleteMock.mockResolvedValue({ code: 0 });
    // Write/append use Descendant API; return image block so processImages runs
    blockDescendantCreateMock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_id: "img_block_1", block_type: 27 }] },
    });
    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
    documentCreateMock.mockResolvedValue({
      code: 0,
      data: { document: { document_id: "doc_created", title: "Created Doc" } },
    });
    permissionMemberCreateMock.mockResolvedValue({ code: 0 });
    blockPatchMock.mockResolvedValue({ code: 0 });
    scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });
  });

  function resolveFeishuDocTool(context: Record<string, unknown> = {}) {
    const harness = createToolFactoryHarness({
      channels: {
        feishu: {
          appId: "app_id",
          appSecret: "app_secret",
          enabled: true,
        },
      },
    });
    registerFeishuDocTools(harness.api);
    const tool = harness.resolveTool("feishu_doc", context);
    expect(tool).toBeDefined();
    return tool;
  }

  async function executeFeishuDocTool(
    tool: ToolLike,
    params: Record<string, unknown>,
  ): Promise<ToolResultWithDetails> {
    return (await tool.execute("tool-call", params)) as ToolResultWithDetails;
  }

  it("inserts blocks sequentially to preserve document order", async () => {
    const blocks = [
      { block_id: "h1", block_type: 3 },
      { block_id: "t1", block_type: 2 },
      { block_id: "h2", block_type: 3 },
    ];
    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks,
        first_level_block_ids: ["h1", "t1", "h2"],
      },
    });

    blockListMock.mockResolvedValue({ code: 0, data: { items: [] } });

    blockDescendantCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { children: [{ block_id: "h1", block_type: 3 }] },
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "append",
      content: "plain text body",
      doc_token: "doc_1",
    });

    expect(blockDescendantCreateMock).toHaveBeenCalledTimes(1);
    const call = blockDescendantCreateMock.mock.calls[0]?.[0];
    expect(call?.data.children_id).toEqual(["h1", "t1", "h2"]);
    expect(call?.data.descendants).toBeDefined();
    expect(call?.data.descendants.length).toBeGreaterThanOrEqual(3);

    expect(result.details.blocks_added).toBe(3);
  });

  it("reorders convert output by document tree instead of raw block array order", async () => {
    const blocks = [
      { block_id: "li2", block_type: 13, parent_id: "list1" },
      { block_id: "h2", block_type: 4 },
      { block_id: "li1", block_type: 13, parent_id: "list1" },
      { block_id: "h1", block_type: 3 },
      { block_id: "list1", block_type: 12, children: ["li1", "li2"] },
      { block_id: "p1", block_type: 2 },
    ];
    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks,
        first_level_block_ids: ["h1", "p1", "h2", "list1"],
      },
    });

    blockDescendantCreateMock.mockImplementationOnce(async ({ data }) => ({
      code: 0,
      data: {
        children: (data.children_id as string[]).map((id) => ({ block_id: id })),
      },
    }));

    const feishuDocTool = resolveFeishuDocTool();

    await feishuDocTool.execute("tool-call", {
      action: "append",
      content: "tree reorder",
      doc_token: "doc_1",
    });

    const call = blockDescendantCreateMock.mock.calls[0]?.[0];
    expect(call?.data.children_id).toEqual(["h1", "p1", "h2", "list1"]);
    expect((call?.data.descendants as { block_id: string }[]).map((b) => b.block_id)).toEqual([
      "h1",
      "p1",
      "h2",
      "list1",
      "li1",
      "li2",
    ]);
  });

  it("falls back to size-based convert chunking for long no-heading markdown", async () => {
    let successChunkCount = 0;
    convertMock.mockImplementation(async ({ data }) => {
      const content = data.content as string;
      if (content.length > 280) {
        return { code: 999, msg: "content too large" };
      }
      successChunkCount++;
      const blockId = `b_${successChunkCount}`;
      return {
        code: 0,
        data: {
          blocks: [{ block_id: blockId, block_type: 2 }],
          first_level_block_ids: [blockId],
        },
      };
    });

    blockDescendantCreateMock.mockImplementation(async ({ data }) => ({
      code: 0,
      data: {
        children: (data.children_id as string[]).map((id) => ({
          block_id: id,
        })),
      },
    }));

    const feishuDocTool = resolveFeishuDocTool();

    const longMarkdown = Array.from(
      { length: 120 },
      (_, i) => `line ${i} with enough content to trigger fallback chunking`,
    ).join("\n");

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "append",
      content: longMarkdown,
      doc_token: "doc_1",
    });

    expect(convertMock.mock.calls.length).toBeGreaterThan(1);
    expect(successChunkCount).toBeGreaterThan(1);
    expect(result.details.blocks_added).toBe(successChunkCount);
  });

  it("keeps fenced code blocks balanced when size fallback split is needed", async () => {
    const convertedChunks: string[] = [];
    let successChunkCount = 0;
    let failFirstConvert = true;
    convertMock.mockImplementation(async ({ data }) => {
      const content = data.content as string;
      convertedChunks.push(content);
      if (failFirstConvert) {
        failFirstConvert = false;
        return { code: 999, msg: "content too large" };
      }
      successChunkCount++;
      const blockId = `c_${successChunkCount}`;
      return {
        code: 0,
        data: {
          blocks: [{ block_id: blockId, block_type: 2 }],
          first_level_block_ids: [blockId],
        },
      };
    });

    blockChildrenCreateMock.mockImplementation(async ({ data }) => ({
      code: 0,
      data: { children: data.children },
    }));

    const feishuDocTool = resolveFeishuDocTool();

    const fencedMarkdown = [
      "## Section",
      "```ts",
      "const alpha = 1;",
      "const beta = 2;",
      "const gamma = alpha + beta;",
      "console.log(gamma);",
      "```",
      "",
      "Tail paragraph one with enough text to exceed API limits when combined. ".repeat(8),
      "Tail paragraph two with enough text to exceed API limits when combined. ".repeat(8),
      "Tail paragraph three with enough text to exceed API limits when combined. ".repeat(8),
    ].join("\n");

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "append",
      content: fencedMarkdown,
      doc_token: "doc_1",
    });

    expect(convertMock.mock.calls.length).toBeGreaterThan(1);
    expect(successChunkCount).toBeGreaterThan(1);
    for (const chunk of convertedChunks) {
      const fenceCount = chunk.match(/```/g)?.length ?? 0;
      expect(fenceCount % 2).toBe(0);
    }
    expect(result.details.blocks_added).toBe(successChunkCount);
  });

  it("skips image upload when markdown image URL is blocked", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchRemoteMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "write",
      content: "![x](https://x.test/image.png)",
      doc_token: "doc_1",
    });

    expect(fetchRemoteMediaMock).toHaveBeenCalled();
    expect(driveUploadAllMock).not.toHaveBeenCalled();
    expect(blockPatchMock).not.toHaveBeenCalled();
    expect(result.details.images_processed).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("create grants permission only to trusted Feishu requester", async () => {
    const feishuDocTool = resolveFeishuDocTool({
      messageChannel: "feishu",
      requesterSenderId: "ou_123",
    });

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
    });

    expect(result.details.document_id).toBe("doc_created");
    expect(result.details.requester_permission_added).toBe(true);
    expect(result.details.requester_open_id).toBe("ou_123");
    expect(result.details.requester_perm_type).toBe("edit");
    expect(permissionMemberCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          member_id: "ou_123",
          member_type: "openid",
          perm: "edit",
        }),
      }),
    );
  });

  it("create skips requester grant when trusted requester identity is unavailable", async () => {
    const feishuDocTool = resolveFeishuDocTool({
      messageChannel: "feishu",
    });

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
    });

    expect(permissionMemberCreateMock).not.toHaveBeenCalled();
    expect(result.details.requester_permission_added).toBe(false);
    expect(result.details.requester_permission_skipped_reason).toContain("trusted requester");
  });

  it("create never grants permissions when grant_to_requester is false", async () => {
    const feishuDocTool = resolveFeishuDocTool({
      messageChannel: "feishu",
      requesterSenderId: "ou_123",
    });

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      grant_to_requester: false,
      title: "Demo",
    });

    expect(permissionMemberCreateMock).not.toHaveBeenCalled();
    expect(result.details.requester_permission_added).toBeUndefined();
  });

  it("returns an error when create response omits document_id", async () => {
    documentCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { document: { title: "Created Doc" } },
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "create",
      title: "Demo",
    });

    expect(result.details.error).toContain("no document_id");
  });

  it("uploads local file to doc via upload_file action", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_id: "file_block_1", block_type: 23 }],
      },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/allowed/test-local.txt",
      filename: "test-local.txt",
    });

    expect(result.details.success).toBe(true);
    expect(result.details.file_token).toBe("token_1");
    expect(result.details.file_name).toBe("test-local.txt");

    // Without workspace-only policy, localRoots stays undefined so loadWebMedia
    // Applies its default managed-root access behavior.
    expect(loadWebMediaMock).toHaveBeenCalledWith(
      expect.stringContaining("test-local.txt"),
      expect.objectContaining({ localRoots: undefined, optimizeImages: false }),
    );

    expect(driveUploadAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          file_name: "test-local.txt",
          parent_node: "doc_1",
          parent_type: "docx_file",
        }),
      }),
    );
  });

  it("passes workspace localRoots for upload_file when workspace-only policy is active", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_id: "file_block_1", block_type: 23 }],
      },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool({
      fsPolicy: { workspaceOnly: true },
      workspaceDir: "/workspace",
    });

    await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/openclaw-1000/test-local.txt",
      filename: "test-local.txt",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      expect.stringContaining("test-local.txt"),
      expect.objectContaining({ localRoots: ["/workspace"], optimizeImages: false }),
    );
  });

  it("passes empty localRoots when workspace-only policy is active without workspaceDir", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_id: "file_block_1", block_type: 23 }],
      },
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool({
      fsPolicy: { workspaceOnly: true },
    });

    await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/openclaw-1000/test-local.txt",
      filename: "test-local.txt",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      expect.stringContaining("test-local.txt"),
      expect.objectContaining({ localRoots: [], optimizeImages: false }),
    );
  });

  it("passes workspace localRoots for upload_image local paths when workspace-only policy is active", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.png",
    });

    const feishuDocTool = resolveFeishuDocTool({
      fsPolicy: { workspaceOnly: true },
      workspaceDir: "/workspace",
    });

    await executeFeishuDocTool(feishuDocTool, {
      action: "upload_image",
      doc_token: "doc_1",
      filename: "test-local.png",
      image: "./test-local.png",
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith(
      expect.stringContaining("test-local.png"),
      expect.objectContaining({ localRoots: ["/workspace"], optimizeImages: false }),
    );
  });

  it("passes workspace localRoots for upload_image absolute local paths when workspace-only policy is active", async () => {
    const fixtureDir = path.join(process.cwd(), ".tmp-docx-upload-image-absolute");
    const absoluteImagePath = path.join(fixtureDir, "absolute-image.png");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(absoluteImagePath, "not-real-image");

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "absolute-image.png",
    });

    const feishuDocTool = resolveFeishuDocTool({
      fsPolicy: { workspaceOnly: true },
      workspaceDir: "/workspace",
    });

    try {
      await executeFeishuDocTool(feishuDocTool, {
        action: "upload_image",
        doc_token: "doc_1",
        filename: "absolute-image.png",
        image: absoluteImagePath,
      });

      expect(loadWebMediaMock).toHaveBeenCalledWith(
        expect.stringContaining("absolute-image.png"),
        expect.objectContaining({ localRoots: ["/workspace"], optimizeImages: false }),
      );
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });

  it("returns an error when upload_file cannot list placeholder siblings", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_id: "file_block_1", block_type: 23 }],
      },
    });
    blockChildrenGetMock.mockResolvedValueOnce({
      code: 999,
      data: { items: [] },
      msg: "list failed",
    });

    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("hello from local file", "utf8"),
      fileName: "test-local.txt",
    });

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/tmp/allowed/test-local.txt",
      filename: "test-local.txt",
    });

    expect(result.details.error).toBe("list failed");
    expect(driveUploadAllMock).not.toHaveBeenCalled();
  });

  it("rejects traversal paths in upload_file via loadWebMedia sandbox", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Local media path is not under an allowed directory: /etc/passwd"),
    );

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_file",
      doc_token: "doc_1",
      file_path: "/etc/passwd",
    });

    expect(result.details.error).toContain("not under an allowed directory");
    expect(driveUploadAllMock).not.toHaveBeenCalled();
  });

  it("rejects traversal paths in upload_image via loadWebMedia sandbox", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_id: "img_block_1", block_type: 27 }],
      },
    });

    loadWebMediaMock.mockRejectedValueOnce(
      new Error(
        "Local media path is not under an allowed directory: /home/admin/.openclaw/openclaw.json",
      ),
    );

    const feishuDocTool = resolveFeishuDocTool();

    const result = await executeFeishuDocTool(feishuDocTool, {
      action: "upload_image",
      doc_token: "doc_1",
      file_path: "/home/admin/.openclaw/openclaw.json",
    });

    expect(result.details.error).toContain("not under an allowed directory");
    expect(driveUploadAllMock).not.toHaveBeenCalled();
  });
});
