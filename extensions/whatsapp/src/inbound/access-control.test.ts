import { beforeAll, describe, expect, it } from "vitest";
import {
  readAllowFromStoreMock,
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";

setupAccessControlTestHarness();
let checkInboundAccessControl: typeof import("./access-control.js").checkInboundAccessControl;

beforeAll(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
});

async function checkUnauthorizedWorkDmSender() {
  return checkInboundAccessControl({
    accountId: "work",
    from: "+15550001111",
    group: false,
    isFromMe: false,
    pushName: "Stranger",
    remoteJid: "15550001111@s.whatsapp.net",
    selfE164: "+15550009999",
    senderE164: "+15550001111",
    sock: { sendMessage: sendMessageMock },
  });
}

function expectSilentlyBlocked(result: { allowed: boolean }) {
  expect(result.allowed).toBe(false);
  expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  expect(sendMessageMock).not.toHaveBeenCalled();
}

describe("checkInboundAccessControl pairing grace", () => {
  async function runPairingGraceCase(messageTimestampMs: number) {
    const connectedAtMs = 1_000_000;
    return await checkInboundAccessControl({
      accountId: "default",
      connectedAtMs,
      from: "+15550001111",
      group: false,
      isFromMe: false,
      messageTimestampMs,
      pairingGraceMs: 30_000,
      pushName: "Sam",
      remoteJid: "15550001111@s.whatsapp.net",
      selfE164: "+15550009999",
      senderE164: "+15550001111",
      sock: { sendMessage: sendMessageMock },
    });
  }

  it("suppresses pairing replies for historical DMs on connect", async () => {
    const result = await runPairingGraceCase(1_000_000 - 31_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends pairing replies for live DMs", async () => {
    const result = await runPairingGraceCase(1_000_000 - 10_000);

    expect(result.allowed).toBe(false);
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
});

describe("WhatsApp dmPolicy precedence", () => {
  it("uses account-level dmPolicy instead of channel-level (#8736)", async () => {
    // Channel-level says "pairing" but the account-level says "allowlist".
    // The account-level override should take precedence, so an unauthorized
    // Sender should be blocked silently (no pairing reply).
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
              dmPolicy: "allowlist",
            },
          },
          dmPolicy: "pairing",
        },
      },
    });

    const result = await checkUnauthorizedWorkDmSender();
    expectSilentlyBlocked(result);
  });

  it("inherits channel-level dmPolicy when account-level dmPolicy is unset", async () => {
    // Account has allowFrom set, but no dmPolicy override. Should inherit the channel default.
    // With dmPolicy=allowlist, unauthorized senders are silently blocked.
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
          dmPolicy: "allowlist",
        },
      },
    });

    const result = await checkUnauthorizedWorkDmSender();
    expectSilentlyBlocked(result);
  });

  it("does not merge persisted pairing approvals in allowlist mode", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              allowFrom: ["+15559999999"],
            },
          },
          dmPolicy: "allowlist",
        },
      },
    });
    readAllowFromStoreMock.mockResolvedValue(["+15550001111"]);

    const result = await checkUnauthorizedWorkDmSender();

    expectSilentlyBlocked(result);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("always allows same-phone DMs even when allowFrom is restrictive", async () => {
    setAccessControlTestConfig({
      channels: {
        whatsapp: {
          allowFrom: ["+15550001111"],
          dmPolicy: "pairing",
        },
      },
    });

    const result = await checkInboundAccessControl({
      accountId: "default",
      from: "+15550009999",
      group: false,
      isFromMe: false,
      pushName: "Owner",
      remoteJid: "15550009999@s.whatsapp.net",
      selfE164: "+15550009999",
      senderE164: "+15550009999",
      sock: { sendMessage: sendMessageMock },
    });

    expect(result.allowed).toBe(true);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
