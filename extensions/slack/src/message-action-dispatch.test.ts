import { describe, expect, it, vi } from "vitest";
import { handleSlackMessageAction } from "./message-action-dispatch.js";

function createInvokeSpy() {
  return vi.fn(async (action: Record<string, unknown>) => ({
    content: action,
    ok: true,
  }));
}

describe("handleSlackMessageAction", () => {
  it("maps upload-file to the internal uploadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          filePath: "/tmp/report.png",
          filename: "build.png",
          initialComment: "fresh build",
          threadId: "111.222",
          title: "Build Screenshot",
          to: "user:U1",
        },
      } as never,
      invoke: invoke as never,
      providerId: "slack",
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        filePath: "/tmp/report.png",
        filename: "build.png",
        initialComment: "fresh build",
        threadTs: "111.222",
        title: "Build Screenshot",
        to: "user:U1",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("maps upload-file aliases to upload params", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          channelId: "C1",
          media: "/tmp/chart.png",
          message: "chart attached",
          replyTo: "333.444",
        },
      } as never,
      invoke: invoke as never,
      providerId: "slack",
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        filePath: "/tmp/chart.png",
        initialComment: "chart attached",
        threadTs: "333.444",
        to: "C1",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("maps upload-file path alias to filePath", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      ctx: {
        action: "upload-file",
        cfg: {},
        params: {
          initialComment: "path alias",
          path: "/tmp/report.txt",
          to: "channel:C1",
        },
      } as never,
      invoke: invoke as never,
      providerId: "slack",
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "uploadFile",
        filePath: "/tmp/report.txt",
        initialComment: "path alias",
        to: "channel:C1",
      }),
      expect.any(Object),
      undefined,
    );
  });

  it("requires filePath, path, or media for upload-file", async () => {
    await expect(
      handleSlackMessageAction({
        ctx: {
          action: "upload-file",
          cfg: {},
          params: {
            to: "channel:C1",
          },
        } as never,
        invoke: createInvokeSpy() as never,
        providerId: "slack",
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);
  });

  it("maps download-file to the internal downloadFile action", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          channelId: "C1",
          fileId: "F123",
          threadId: "111.222",
        },
      } as never,
      invoke: invoke as never,
      providerId: "slack",
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        channelId: "C1",
        fileId: "F123",
        threadId: "111.222",
      }),
      expect.any(Object),
    );
  });

  it("maps download-file target aliases to scope fields", async () => {
    const invoke = createInvokeSpy();

    await handleSlackMessageAction({
      ctx: {
        action: "download-file",
        cfg: {},
        params: {
          fileId: "F999",
          replyTo: "333.444",
          to: "channel:C2",
        },
      } as never,
      invoke: invoke as never,
      providerId: "slack",
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "downloadFile",
        channelId: "channel:C2",
        fileId: "F999",
        threadId: "333.444",
      }),
      expect.any(Object),
    );
  });
});
