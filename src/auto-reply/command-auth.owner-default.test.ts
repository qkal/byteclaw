import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

describe("senderIsOwner only reflects explicit owner authorization", () => {
  it("does not treat direct-message senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      ChatType: "direct",
      From: "discord:123",
      Provider: "discord",
      SenderId: "123",
      Surface: "discord",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not treat group-chat senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      ChatType: "group",
      From: "discord:123",
      Provider: "discord",
      SenderId: "123",
      Surface: "discord",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("senderIsOwner is false when ownerAllowFrom is configured and sender does not match", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      From: "discord:789",
      Provider: "discord",
      SenderId: "789",
      Surface: "discord",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("senderIsOwner is true when ownerAllowFrom matches sender", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      From: "discord:456",
      Provider: "discord",
      SenderId: "456",
      Surface: "discord",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(true);
  });

  it("senderIsOwner is true when ownerAllowFrom is wildcard (*)", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["*"] },
    } as OpenClawConfig;

    const ctx = {
      From: "discord:anyone",
      Provider: "discord",
      SenderId: "anyone",
      Surface: "discord",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(true);
  });

  it("senderIsOwner is true for internal operator.admin sessions", () => {
    const cfg = {} as OpenClawConfig;

    const ctx = {
      GatewayClientScopes: ["operator.admin"],
      Provider: "webchat",
      Surface: "webchat",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(auth.senderIsOwner).toBe(true);
  });
});
