import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it.each([
    {
      expected: { matchedBy: "host-header-fallback" as const, ok: true as const },
      input: {
        allowHostHeaderOriginFallback: true,
        origin: "http://127.0.0.1:18789",
        requestHost: "127.0.0.1:18789",
      },
      name: "accepts host-header fallback when explicitly enabled",
    },
    {
      expected: { ok: false as const, reason: "origin not allowed" },
      input: {
        origin: "https://gateway.example.com:18789",
        requestHost: "gateway.example.com:18789",
      },
      name: "rejects same-origin host matches when fallback is disabled",
    },
    {
      expected: { matchedBy: "local-loopback" as const, ok: true as const },
      input: {
        isLocalClient: true,
        origin: "http://localhost:5173",
        requestHost: "127.0.0.1:18789",
      },
      name: "accepts local loopback mismatches for local clients",
    },
    {
      expected: { ok: false as const, reason: "origin not allowed" },
      input: {
        isLocalClient: false,
        origin: "http://localhost:5173",
        requestHost: "127.0.0.1:18789",
      },
      name: "rejects loopback mismatches for non-local clients",
    },
    {
      expected: { matchedBy: "allowlist" as const, ok: true as const },
      input: {
        allowedOrigins: [" https://control.example.com "],
        origin: "https://CONTROL.example.com",
        requestHost: "gateway.example.com:18789",
      },
      name: "accepts trimmed lowercase-normalized allowlist matches",
    },
    {
      expected: { matchedBy: "allowlist" as const, ok: true as const },
      input: {
        allowedOrigins: ["https://control.example.com", " * "],
        origin: "https://any-origin.example.com",
        requestHost: "gateway.tailnet.ts.net:18789",
      },
      name: "accepts wildcard allowlists even alongside specific entries",
    },
    {
      expected: { ok: false as const, reason: "origin missing or invalid" },
      input: {
        origin: "",
        requestHost: "gateway.example.com:18789",
      },
      name: "rejects missing origin",
    },
    {
      expected: { ok: false as const, reason: "origin missing or invalid" },
      input: {
        origin: "null",
        requestHost: "gateway.example.com:18789",
      },
      name: 'rejects literal "null" origin',
    },
    {
      expected: { ok: false as const, reason: "origin missing or invalid" },
      input: {
        origin: "not a url",
        requestHost: "gateway.example.com:18789",
      },
      name: "rejects malformed origin URLs",
    },
    {
      expected: { ok: false as const, reason: "origin not allowed" },
      input: {
        origin: "https://attacker.example.com",
        requestHost: "gateway.example.com:18789",
      },
      name: "rejects mismatched origins",
    },
  ])("$name", ({ input, expected }) => {
    expect(checkBrowserOrigin(input)).toEqual(expected);
  });
});
