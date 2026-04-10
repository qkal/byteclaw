import { describe, expect, it } from "vitest";
import { createManagerHarness } from "./manager.test-harness.js";

describe("CallManager inbound allowlist", () => {
  it("rejects inbound calls with missing caller ID when allowlist enabled", async () => {
    const { manager, provider } = await createManagerHarness({
      allowFrom: ["+15550001234"],
      inboundPolicy: "allowlist",
    });

    manager.processEvent({
      callId: "call-missing",
      direction: "inbound",
      id: "evt-allowlist-missing",
      providerCallId: "provider-missing",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.initiated",
    });

    expect(manager.getCallByProviderCallId("provider-missing")).toBeUndefined();
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({ providerCallId: "provider-missing" }),
    ]);
  });

  it("rejects inbound calls with anonymous caller ID when allowlist enabled", async () => {
    const { manager, provider } = await createManagerHarness({
      allowFrom: ["+15550001234"],
      inboundPolicy: "allowlist",
    });

    manager.processEvent({
      callId: "call-anon",
      direction: "inbound",
      from: "anonymous",
      id: "evt-allowlist-anon",
      providerCallId: "provider-anon",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.initiated",
    });

    expect(manager.getCallByProviderCallId("provider-anon")).toBeUndefined();
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({ providerCallId: "provider-anon" }),
    ]);
  });

  it("rejects inbound calls that only match allowlist suffixes", async () => {
    const { manager, provider } = await createManagerHarness({
      allowFrom: ["+15550001234"],
      inboundPolicy: "allowlist",
    });

    manager.processEvent({
      callId: "call-suffix",
      direction: "inbound",
      from: "+99915550001234",
      id: "evt-allowlist-suffix",
      providerCallId: "provider-suffix",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.initiated",
    });

    expect(manager.getCallByProviderCallId("provider-suffix")).toBeUndefined();
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({ providerCallId: "provider-suffix" }),
    ]);
  });

  it("rejects duplicate inbound events with a single hangup call", async () => {
    const { manager, provider } = await createManagerHarness({
      inboundPolicy: "disabled",
    });

    manager.processEvent({
      callId: "provider-dup",
      direction: "inbound",
      from: "+15552222222",
      id: "evt-reject-init",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.initiated",
    });

    manager.processEvent({
      callId: "provider-dup",
      direction: "inbound",
      from: "+15552222222",
      id: "evt-reject-ring",
      providerCallId: "provider-dup",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.ringing",
    });

    expect(manager.getCallByProviderCallId("provider-dup")).toBeUndefined();
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({ providerCallId: "provider-dup" }),
    ]);
  });

  it("accepts inbound calls that exactly match the allowlist", async () => {
    const { manager } = await createManagerHarness({
      allowFrom: ["+15550001234"],
      inboundPolicy: "allowlist",
    });

    manager.processEvent({
      callId: "call-exact",
      direction: "inbound",
      from: "+15550001234",
      id: "evt-allowlist-exact",
      providerCallId: "provider-exact",
      timestamp: Date.now(),
      to: "+15550000000",
      type: "call.initiated",
    });

    const call = manager.getCallByProviderCallId("provider-exact");
    if (!call) {
      throw new Error("expected exact allowlist match to keep the inbound call");
    }
    expect(call).toMatchObject({
      direction: "inbound",
      from: "+15550001234",
      providerCallId: "provider-exact",
      to: "+15550000000",
    });
    expect(call.callId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
