import { describe, expect, it } from "vitest";
import { resolveCanvasHostUrl } from "./canvas-host-url.js";

describe("resolveCanvasHostUrl", () => {
  it.each([
    {
      expected: undefined,
      name: "returns undefined when no canvas port is available",
      params: {},
    },
    {
      expected: undefined,
      name: "returns undefined when only a loopback host override is available",
      params: { canvasPort: 3000, hostOverride: "127.0.0.1" },
    },
    {
      expected: "http://canvas.openclaw.ai:3000",
      name: "prefers non-loopback host overrides and preserves explicit ports",
      params: {
        canvasPort: 3000,
        hostOverride: " canvas.openclaw.ai ",
        localAddress: "192.168.1.10",
        requestHost: "gateway.local:9000",
      },
    },
    {
      expected: "http://example.com:3000",
      name: "falls back from rejected loopback overrides to request hosts",
      params: {
        canvasPort: 3000,
        hostOverride: "127.0.0.1",
        requestHost: "example.com:8443",
      },
    },
    {
      expected: "https://gateway.example.com:9443",
      name: "maps proxied default gateway ports to request-host ports",
      params: {
        canvasPort: 18_789,
        forwardedProto: "https",
        requestHost: "gateway.example.com:9443",
      },
    },
    {
      expected: "https://gateway.example.com:443",
      name: "maps proxied default gateway ports to scheme defaults",
      params: {
        canvasPort: 18_789,
        forwardedProto: ["https", "http"],
        requestHost: "gateway.example.com",
      },
    },
    {
      expected: "http://gateway.example.com:80",
      name: "uses http scheme defaults without forwarded proto",
      params: {
        canvasPort: 18_789,
        requestHost: "gateway.example.com",
      },
    },
    {
      expected: "https://[2001:db8::1]:3000",
      name: "brackets ipv6 hosts and can fall back to local addresses",
      params: {
        canvasPort: 3000,
        localAddress: "2001:db8::1",
        requestHost: "not a host",
        scheme: "https",
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveCanvasHostUrl(params as Parameters<typeof resolveCanvasHostUrl>[0])).toBe(
      expected,
    );
  });
});
