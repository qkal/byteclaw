import { describe, expect, it, vi } from "vitest";
import { resolveGatewayBindUrl } from "./gateway-bind-url.js";

describe("shared/gateway-bind-url", () => {
  it("returns null for loopback/default binds", () => {
    const pickTailnetHost = vi.fn(() => "100.64.0.1");
    const pickLanHost = vi.fn(() => "192.168.1.2");

    expect(
      resolveGatewayBindUrl({
        pickLanHost,
        pickTailnetHost,
        port: 18_789,
        scheme: "ws",
      }),
    ).toBeNull();
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  });

  it("resolves custom binds only when custom host is present after trimming", () => {
    const pickTailnetHost = vi.fn();
    const pickLanHost = vi.fn();

    expect(
      resolveGatewayBindUrl({
        bind: "custom",
        customBindHost: " gateway.local ",
        pickLanHost,
        pickTailnetHost,
        port: 443,
        scheme: "wss",
      }),
    ).toEqual({
      source: "gateway.bind=custom",
      url: "wss://gateway.local:443",
    });

    expect(
      resolveGatewayBindUrl({
        bind: "custom",
        customBindHost: "   ",
        pickLanHost,
        pickTailnetHost,
        port: 18_789,
        scheme: "ws",
      }),
    ).toEqual({
      error: "gateway.bind=custom requires gateway.customBindHost.",
    });
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  });

  it("resolves tailnet and lan binds or returns clear errors", () => {
    expect(
      resolveGatewayBindUrl({
        bind: "tailnet",
        pickLanHost: vi.fn(),
        pickTailnetHost: () => "100.64.0.1",
        port: 18_789,
        scheme: "ws",
      }),
    ).toEqual({
      source: "gateway.bind=tailnet",
      url: "ws://100.64.0.1:18789",
    });
    expect(
      resolveGatewayBindUrl({
        bind: "tailnet",
        pickLanHost: vi.fn(),
        pickTailnetHost: () => null,
        port: 18_789,
        scheme: "ws",
      }),
    ).toEqual({
      error: "gateway.bind=tailnet set, but no tailnet IP was found.",
    });

    expect(
      resolveGatewayBindUrl({
        bind: "lan",
        pickLanHost: () => "192.168.1.2",
        pickTailnetHost: vi.fn(),
        port: 8443,
        scheme: "wss",
      }),
    ).toEqual({
      source: "gateway.bind=lan",
      url: "wss://192.168.1.2:8443",
    });
    expect(
      resolveGatewayBindUrl({
        bind: "lan",
        pickLanHost: () => null,
        pickTailnetHost: vi.fn(),
        port: 18_789,
        scheme: "ws",
      }),
    ).toEqual({
      error: "gateway.bind=lan set, but no private LAN IP was found.",
    });
  });

  it("returns null for unrecognized bind values without probing pickers", () => {
    const pickTailnetHost = vi.fn(() => "100.64.0.1");
    const pickLanHost = vi.fn(() => "192.168.1.2");

    expect(
      resolveGatewayBindUrl({
        bind: "loopbackish",
        pickLanHost,
        pickTailnetHost,
        port: 18_789,
        scheme: "ws",
      }),
    ).toBeNull();
    expect(pickTailnetHost).not.toHaveBeenCalled();
    expect(pickLanHost).not.toHaveBeenCalled();
  });
});
