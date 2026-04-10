import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./client-actions.js";
import { browserOpenTab, browserSnapshot, browserStatus, browserTabs } from "./client.js";

describe("browser client", () => {
  function stubSnapshotFetch(calls: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          json: async () => ({
            format: "ai",
            ok: true,
            snapshot: "ok",
            targetId: "t1",
            url: "https://x",
          }),
          ok: true,
        } as unknown as Response;
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps connection failures with a sandbox hint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: refused,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed));

    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(/sandboxed session/i);
  });

  it("adds useful timeout messaging for abort-like failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(/timed out/i);
  });

  it("surfaces non-2xx responses with body text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => "conflict",
      } as unknown as Response),
    );

    await expect(
      browserSnapshot("http://127.0.0.1:18791", { format: "aria", limit: 1 }),
    ).rejects.toThrow(/conflict/i);
  });

  it("adds labels + efficient mode query params to snapshots", async () => {
    const calls: string[] = [];
    stubSnapshotFetch(calls);

    await expect(
      browserSnapshot("http://127.0.0.1:18791", {
        format: "ai",
        labels: true,
        mode: "efficient",
      }),
    ).resolves.toMatchObject({ format: "ai", ok: true });

    const snapshotCall = calls.find((url) => url.includes("/snapshot?"));
    expect(snapshotCall).toBeTruthy();
    const parsed = new URL(snapshotCall as string);
    expect(parsed.searchParams.get("labels")).toBe("1");
    expect(parsed.searchParams.get("mode")).toBe("efficient");
  });

  it("adds refs=aria to snapshots when requested", async () => {
    const calls: string[] = [];
    stubSnapshotFetch(calls);

    await browserSnapshot("http://127.0.0.1:18791", {
      format: "ai",
      refs: "aria",
    });

    const snapshotCall = calls.find((url) => url.includes("/snapshot?"));
    expect(snapshotCall).toBeTruthy();
    const parsed = new URL(snapshotCall as string);
    expect(parsed.searchParams.get("refs")).toBe("aria");
  });

  it("omits format when the caller wants server-side snapshot capability defaults", async () => {
    const calls: string[] = [];
    stubSnapshotFetch(calls);

    await browserSnapshot("http://127.0.0.1:18791", {
      profile: "chrome",
    });

    const snapshotCall = calls.find((url) => url.includes("/snapshot?"));
    expect(snapshotCall).toBeTruthy();
    const parsed = new URL(snapshotCall as string);
    expect(parsed.searchParams.get("format")).toBeNull();
    expect(parsed.searchParams.get("profile")).toBe("chrome");
  });

  it("uses the expected endpoints + methods for common calls", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ init, url });
        if (url.endsWith("/tabs") && (!init || init.method === undefined)) {
          return {
            json: async () => ({
              running: true,
              tabs: [{ targetId: "t1", title: "T", url: "https://x" }],
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/tabs/open")) {
          return {
            json: async () => ({
              targetId: "t2",
              title: "N",
              url: "https://y",
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/navigate")) {
          return {
            json: async () => ({
              ok: true,
              targetId: "t1",
              url: "https://y",
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/act")) {
          return {
            json: async () => ({
              ok: true,
              result: 1,
              results: [{ ok: true }],
              targetId: "t1",
              url: "https://x",
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/hooks/file-chooser")) {
          return {
            json: async () => ({ ok: true }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/hooks/dialog")) {
          return {
            json: async () => ({ ok: true }),
            ok: true,
          } as unknown as Response;
        }
        if (url.includes("/console?")) {
          return {
            json: async () => ({
              messages: [],
              ok: true,
              targetId: "t1",
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/pdf")) {
          return {
            json: async () => ({
              ok: true,
              path: "/tmp/a.pdf",
              targetId: "t1",
              url: "https://x",
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.endsWith("/screenshot")) {
          return {
            json: async () => ({
              ok: true,
              path: "/tmp/a.png",
              targetId: "t1",
              url: "https://x",
            }),
            ok: true,
          } as unknown as Response;
        }
        if (url.includes("/snapshot?")) {
          return {
            json: async () => ({
              format: "aria",
              nodes: [],
              ok: true,
              targetId: "t1",
              url: "https://x",
            }),
            ok: true,
          } as unknown as Response;
        }
        return {
          json: async () => ({
            attachOnly: false,
            cdpPort: 18792,
            cdpUrl: "http://127.0.0.1:18792",
            chosenBrowser: "chrome",
            color: "#FF4500",
            enabled: true,
            executablePath: null,
            headless: false,
            noSandbox: false,
            pid: 1,
            running: true,
            userDataDir: "/tmp",
          }),
          ok: true,
        } as unknown as Response;
      }),
    );

    await expect(browserStatus("http://127.0.0.1:18791")).resolves.toMatchObject({
      cdpPort: 18_792,
      running: true,
    });

    await expect(browserTabs("http://127.0.0.1:18791")).resolves.toHaveLength(1);
    await expect(
      browserOpenTab("http://127.0.0.1:18791", "https://example.com"),
    ).resolves.toMatchObject({ targetId: "t2" });

    await expect(
      browserSnapshot("http://127.0.0.1:18791", { format: "aria", limit: 1 }),
    ).resolves.toMatchObject({ format: "aria", ok: true });

    await expect(
      browserNavigate("http://127.0.0.1:18791", { url: "https://example.com" }),
    ).resolves.toMatchObject({ ok: true, targetId: "t1" });
    await expect(
      browserAct("http://127.0.0.1:18791", { kind: "click", ref: "1" }),
    ).resolves.toMatchObject({ ok: true, results: [{ ok: true }], targetId: "t1" });
    await expect(
      browserArmFileChooser("http://127.0.0.1:18791", {
        paths: ["/tmp/a.txt"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browserArmDialog("http://127.0.0.1:18791", { accept: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browserConsoleMessages("http://127.0.0.1:18791", { level: "error" }),
    ).resolves.toMatchObject({ ok: true, targetId: "t1" });
    await expect(browserPdfSave("http://127.0.0.1:18791")).resolves.toMatchObject({
      ok: true,
      path: "/tmp/a.pdf",
    });
    await expect(
      browserScreenshotAction("http://127.0.0.1:18791", { fullPage: true }),
    ).resolves.toMatchObject({ ok: true, path: "/tmp/a.png" });

    expect(calls.some((c) => c.url.endsWith("/tabs"))).toBe(true);
    const open = calls.find((c) => c.url.endsWith("/tabs/open"));
    expect(open?.init?.method).toBe("POST");

    const screenshot = calls.find((c) => c.url.endsWith("/screenshot"));
    expect(screenshot?.init?.method).toBe("POST");
  });
});
