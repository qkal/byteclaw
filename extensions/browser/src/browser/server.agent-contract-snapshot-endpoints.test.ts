import { describe, expect, it } from "vitest";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./constants.js";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  getBrowserControlServerTestState,
  getCdpMocks,
  getPwMocks,
} from "./server.control-server.test-harness.js";
import { getBrowserTestFetch } from "./test-fetch.js";

const state = getBrowserControlServerTestState();
const cdpMocks = getCdpMocks();
const pwMocks = getPwMocks();

describe("browser control server", () => {
  installAgentContractHooks();

  it("agent contract: snapshot endpoints", async () => {
    const base = await startServerAndBase();
    const realFetch = getBrowserTestFetch();

    const snapAria = (await realFetch(`${base}/snapshot?format=aria&limit=1`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAria.ok).toBe(true);
    expect(snapAria.format).toBe("aria");
    expect(cdpMocks.snapshotAria).toHaveBeenCalledWith({
      limit: 1,
      wsUrl: "ws://127.0.0.1/devtools/page/abcd1234",
    });

    const snapAi = (await realFetch(`${base}/snapshot?format=ai`).then((r) => r.json())) as {
      ok: boolean;
      format?: string;
    };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: state.cdpBaseUrl,
      maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
      targetId: "abcd1234",
    });

    const snapAiZero = (await realFetch(`${base}/snapshot?format=ai&maxChars=0`).then((r) =>
      r.json(),
    )) as { ok: boolean; format?: string };
    expect(snapAiZero.ok).toBe(true);
    expect(snapAiZero.format).toBe("ai");
    const [lastCall] = pwMocks.snapshotAiViaPlaywright.mock.calls.at(-1) ?? [];
    expect(lastCall).toEqual({
      cdpUrl: state.cdpBaseUrl,
      ssrfPolicy: {
        dangerouslyAllowPrivateNetwork: true,
      },
      targetId: "abcd1234",
    });
  });

  it("agent contract: navigation + common act commands", async () => {
    const base = await startServerAndBase();
    const realFetch = getBrowserTestFetch();

    const nav = await postJson<{ ok: boolean; targetId?: string }>(`${base}/navigate`, {
      url: "https://example.com",
    });
    expect(nav.ok).toBe(true);
    expect(typeof nav.targetId).toBe("string");
    expect(pwMocks.navigateViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
        targetId: "abcd1234",
        url: "https://example.com",
      }),
    );

    const click = await postJson<{ ok: boolean }>(`${base}/act`, {
      button: "left",
      kind: "click",
      modifiers: ["Shift"],
      ref: "1",
    });
    expect(click.ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        button: "left",
        cdpUrl: state.cdpBaseUrl,
        modifiers: ["Shift"],
        ref: "1",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
        targetId: "abcd1234",
      }),
    );
    const [clickArgs] = pwMocks.clickViaPlaywright.mock.calls[0] ?? [];
    expect((clickArgs as { doubleClick?: boolean }).doubleClick).toBeUndefined();

    const clickSelector = await realFetch(`${base}/act`, {
      body: JSON.stringify({ kind: "click", selector: "button.save" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(clickSelector.status).toBe(200);
    expect(((await clickSelector.json()) as { ok?: boolean }).ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        selector: "button.save",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
        targetId: "abcd1234",
      }),
    );
    const [clickSelectorArgs] = pwMocks.clickViaPlaywright.mock.calls[1] ?? [];
    expect((clickSelectorArgs as { doubleClick?: boolean }).doubleClick).toBeUndefined();

    const type = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "type",
      ref: "1",
      text: "",
    });
    expect(type.ok).toBe(true);
    expect(pwMocks.typeViaPlaywright).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        ref: "1",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
        targetId: "abcd1234",
        text: "",
      }),
    );
    const [typeArgs] = pwMocks.typeViaPlaywright.mock.calls[0] ?? [];
    expect((typeArgs as { submit?: boolean }).submit).toBeUndefined();
    expect((typeArgs as { slowly?: boolean }).slowly).toBeUndefined();

    const press = await postJson<{ ok: boolean }>(`${base}/act`, {
      key: "Enter",
      kind: "press",
    });
    expect(press.ok).toBe(true);
    expect(pwMocks.pressKeyViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        key: "Enter",
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
        targetId: "abcd1234",
      }),
    );
    const [pressArgs] = pwMocks.pressKeyViaPlaywright.mock.calls[0] ?? [];
    expect((pressArgs as { delayMs?: number }).delayMs).toBeUndefined();

    const hover = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "hover",
      ref: "2",
    });
    expect(hover.ok).toBe(true);
    expect(pwMocks.hoverViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        ref: "2",
        targetId: "abcd1234",
      }),
    );
    const [hoverArgs] = pwMocks.hoverViaPlaywright.mock.calls[0] ?? [];
    expect((hoverArgs as { timeoutMs?: number }).timeoutMs).toBeUndefined();

    const scroll = await postJson<{ ok: boolean }>(`${base}/act`, {
      kind: "scrollIntoView",
      ref: "2",
    });
    expect(scroll.ok).toBe(true);
    expect(pwMocks.scrollIntoViewViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        ref: "2",
        targetId: "abcd1234",
      }),
    );
    const [scrollArgs] = pwMocks.scrollIntoViewViaPlaywright.mock.calls[0] ?? [];
    expect((scrollArgs as { timeoutMs?: number }).timeoutMs).toBeUndefined();

    const drag = await postJson<{ ok: boolean }>(`${base}/act`, {
      endRef: "4",
      kind: "drag",
      startRef: "3",
    });
    expect(drag.ok).toBe(true);
    expect(pwMocks.dragViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: state.cdpBaseUrl,
        endRef: "4",
        startRef: "3",
        targetId: "abcd1234",
      }),
    );
    const [dragArgs] = pwMocks.dragViaPlaywright.mock.calls[0] ?? [];
    expect((dragArgs as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });
});
