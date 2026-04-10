import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { closePlaywrightBrowserConnection, listPagesViaPlaywright } from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

interface BrowserMockBundle {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
}

function makeBrowser(targetId: string, url: string): BrowserMockBundle {
  let context: import("playwright-core").BrowserContext;
  const browserClose = vi.fn(async () => {});
  const page = {
    context: () => context,
    on: vi.fn(),
    title: vi.fn(async () => `title:${targetId}`),
    url: vi.fn(() => url),
  } as unknown as import("playwright-core").Page;

  context = {
    newCDPSession: vi.fn(async () => ({
      detach: vi.fn(async () => {}),
      send: vi.fn(async (method: string) =>
        method === "Target.getTargetInfo" ? { targetInfo: { targetId } } : {},
      ),
    })),
    on: vi.fn(),
    pages: () => [page],
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    close: browserClose,
    contexts: () => [context],
    off: vi.fn(),
    on: vi.fn(),
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose };
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session connection scoping", () => {
  it("does not share in-flight connectOverCDP promises across different cdpUrls", async () => {
    const browserA = makeBrowser("A", "https://a.example");
    const browserB = makeBrowser("B", "https://b.example");
    let resolveA: ((value: import("playwright-core").Browser) => void) | undefined;

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        return await new Promise<import("playwright-core").Browser>((resolve) => {
          resolveA = resolve;
        });
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const pendingA = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await Promise.resolve();
    const pendingB = listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await vi.waitFor(() => {
      expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    });
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:9222",
      expect.any(Object),
    );
    expect(connectOverCdpSpy).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:9333",
      expect.any(Object),
    );

    resolveA?.(browserA.browser);
    const [pagesA, pagesB] = await Promise.all([pendingA, pendingB]);
    expect(pagesA.map((page) => page.targetId)).toEqual(["A"]);
    expect(pagesB.map((page) => page.targetId)).toEqual(["B"]);
  });

  it("closes only the requested scoped connection", async () => {
    const browserA = makeBrowser("A", "https://a.example");
    const browserB = makeBrowser("B", "https://b.example");

    connectOverCdpSpy.mockImplementation((async (...args: unknown[]) => {
      const endpointText = String(args[0]);
      if (endpointText === "http://127.0.0.1:9222") {
        return browserA.browser;
      }
      if (endpointText === "http://127.0.0.1:9333") {
        return browserB.browser;
      }
      throw new Error(`unexpected endpoint: ${endpointText}`);
    }) as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });
    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9333" });

    await closePlaywrightBrowserConnection({ cdpUrl: "http://127.0.0.1:9222" });

    expect(browserA.browserClose).toHaveBeenCalledTimes(1);
    expect(browserB.browserClose).not.toHaveBeenCalled();
  });
});
