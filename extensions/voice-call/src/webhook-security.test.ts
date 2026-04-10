import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyPlivoWebhook,
  verifyTelnyxWebhook,
  verifyTwilioWebhook,
} from "./webhook-security.js";

function canonicalizeBase64(input: string): string {
  return Buffer.from(input, "base64").toString("base64");
}

function plivoV2Signature(params: {
  authToken: string;
  urlNoQuery: string;
  nonce: string;
}): string {
  const digest = crypto
    .createHmac("sha256", params.authToken)
    .update(params.urlNoQuery + params.nonce)
    .digest("base64");
  return canonicalizeBase64(digest);
}

function plivoV3Signature(params: {
  authToken: string;
  urlWithQuery: string;
  postBody: string;
  nonce: string;
}): string {
  const u = new URL(params.urlWithQuery);
  const baseNoQuery = `${u.protocol}//${u.host}${u.pathname}`;
  const queryPairs: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    queryPairs.push([k, v]);
  }

  const queryMap = new Map<string, string[]>();
  for (const [k, v] of queryPairs) {
    queryMap.set(k, (queryMap.get(k) ?? []).concat(v));
  }

  const sortedQuery = [...queryMap.keys()]
    .toSorted()
    .flatMap((k) => [...(queryMap.get(k) ?? [])].toSorted().map((v) => `${k}=${v}`))
    .join("&");

  const postParams = new URLSearchParams(params.postBody);
  const postMap = new Map<string, string[]>();
  for (const [k, v] of postParams.entries()) {
    postMap.set(k, (postMap.get(k) ?? []).concat(v));
  }

  const sortedPost = [...postMap.keys()]
    .toSorted()
    .flatMap((k) => [...(postMap.get(k) ?? [])].toSorted().map((v) => `${k}${v}`))
    .join("");

  const hasPost = sortedPost.length > 0;
  let baseUrl = baseNoQuery;
  if (sortedQuery.length > 0 || hasPost) {
    baseUrl = `${baseNoQuery}?${sortedQuery}`;
  }
  if (sortedQuery.length > 0 && hasPost) {
    baseUrl = `${baseUrl}.`;
  }
  baseUrl = `${baseUrl}${sortedPost}`;

  const digest = crypto
    .createHmac("sha256", params.authToken)
    .update(`${baseUrl}.${params.nonce}`)
    .digest("base64");
  return canonicalizeBase64(digest);
}

function twilioSignature(params: { authToken: string; url: string; postBody: string }): string {
  let dataToSign = params.url;
  const sortedParams = [...new URLSearchParams(params.postBody).entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  );

  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }

  return crypto.createHmac("sha1", params.authToken).update(dataToSign).digest("base64");
}

function expectReplayResultPair(
  first: { ok: boolean; isReplay?: boolean; verifiedRequestKey?: string },
  second: { ok: boolean; isReplay?: boolean; verifiedRequestKey?: string },
) {
  expect(first.ok).toBe(true);
  expect(first.isReplay).toBeFalsy();
  if (!first.verifiedRequestKey) {
    throw new Error("verified webhook request did not produce a request key");
  }
  expect(second.ok).toBe(true);
  expect(second.isReplay).toBe(true);
  expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
}

function expectAcceptedWebhookVersion(
  result: { ok: boolean; version?: string },
  version: "v2" | "v3",
) {
  expect(result).toMatchObject({ ok: true, version });
}

function verifyTwilioNgrokLoopback(signature: string) {
  return verifyTwilioWebhook(
    {
      headers: {
        host: "127.0.0.1:3334",
        "x-forwarded-host": "local.ngrok-free.app",
        "x-forwarded-proto": "https",
        "x-twilio-signature": signature,
      },
      method: "POST",
      rawBody: "CallSid=CS123&CallStatus=completed&From=%2B15550000000",
      remoteAddress: "127.0.0.1",
      url: "http://127.0.0.1:3334/voice/webhook",
    },
    "test-auth-token",
    { allowNgrokFreeTierLoopbackBypass: true },
  );
}

function verifyTwilioSignedRequest(params: {
  headers: Record<string, string>;
  rawBody: string;
  authToken: string;
  publicUrl: string;
}) {
  return verifyTwilioWebhook(
    {
      headers: params.headers,
      method: "POST",
      query: { callId: "abc" },
      rawBody: params.rawBody,
      url: "http://local/voice/webhook?callId=abc",
    },
    params.authToken,
    { publicUrl: params.publicUrl },
  );
}

describe("verifyPlivoWebhook", () => {
  it("accepts valid V2 signature", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-123";

    const ctxUrl = "http://local/voice/webhook?flow=answer&callId=abc";
    const verificationUrl = "https://example.com/voice/webhook";
    const signature = plivoV2Signature({
      authToken,
      nonce,
      urlNoQuery: verificationUrl,
    });

    const result = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v2": signature,
          "x-plivo-signature-v2-nonce": nonce,
        },
        method: "POST",
        query: { callId: "abc", flow: "answer" },
        rawBody: "CallUUID=uuid&CallStatus=in-progress",
        url: ctxUrl,
      },
      authToken,
    );

    expectAcceptedWebhookVersion(result, "v2");
  });

  it("accepts valid V3 signature (including multi-signature header)", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-456";

    const urlWithQuery = "https://example.com/voice/webhook?flow=answer&callId=abc";
    const postBody = "CallUUID=uuid&CallStatus=in-progress&From=%2B15550000000";

    const good = plivoV3Signature({
      authToken,
      nonce,
      postBody,
      urlWithQuery,
    });

    const result = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v3": `bad, ${good}`,
          "x-plivo-signature-v3-nonce": nonce,
        },
        method: "POST",
        query: { callId: "abc", flow: "answer" },
        rawBody: postBody,
        url: urlWithQuery,
      },
      authToken,
    );

    expectAcceptedWebhookVersion(result, "v3");
  });

  it("rejects missing signatures", () => {
    const result = verifyPlivoWebhook(
      {
        headers: { host: "example.com", "x-forwarded-proto": "https" },
        method: "POST",
        rawBody: "",
        url: "https://example.com/voice/webhook",
      },
      "token",
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Missing Plivo signature headers/);
  });

  it("marks replayed valid V3 requests as replay without failing auth", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-replay-v3";
    const urlWithQuery = "https://example.com/voice/webhook?flow=answer&callId=abc";
    const postBody = "CallUUID=uuid&CallStatus=in-progress&From=%2B15550000000";
    const signature = plivoV3Signature({
      authToken,
      nonce,
      postBody,
      urlWithQuery,
    });

    const ctx = {
      headers: {
        host: "example.com",
        "x-forwarded-proto": "https",
        "x-plivo-signature-v3": signature,
        "x-plivo-signature-v3-nonce": nonce,
      },
      method: "POST" as const,
      query: { callId: "abc", flow: "answer" },
      rawBody: postBody,
      url: urlWithQuery,
    };

    const first = verifyPlivoWebhook(ctx, authToken);
    const second = verifyPlivoWebhook(ctx, authToken);

    expectReplayResultPair(first, second);
  });

  it("treats query-only V2 variants as the same verified request", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-replay-v2";
    const verificationUrl = "https://example.com/voice/webhook";
    const signature = plivoV2Signature({
      authToken,
      nonce,
      urlNoQuery: verificationUrl,
    });

    const baseHeaders = {
      host: "example.com",
      "x-forwarded-proto": "https",
      "x-plivo-signature-v2": signature,
      "x-plivo-signature-v2-nonce": nonce,
    };
    const rawBody = "CallUUID=uuid&CallStatus=in-progress";

    const first = verifyPlivoWebhook(
      {
        headers: baseHeaders,
        method: "POST",
        query: { callId: "abc", flow: "answer" },
        rawBody,
        url: `${verificationUrl}?flow=answer&callId=abc`,
      },
      authToken,
    );
    const second = verifyPlivoWebhook(
      {
        headers: baseHeaders,
        method: "POST",
        query: { callId: "abc", flow: "getinput" },
        rawBody,
        url: `${verificationUrl}?flow=getinput&callId=abc`,
      },
      authToken,
    );

    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toBeDefined();
    expect(second.ok).toBe(true);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });

  it("returns a stable request key when verification is skipped", () => {
    const ctx = {
      headers: {},
      method: "POST" as const,
      rawBody: "CallUUID=uuid&CallStatus=in-progress",
      url: "https://example.com/voice/webhook",
    };
    const first = verifyPlivoWebhook(ctx, "token", { skipVerification: true });
    const second = verifyPlivoWebhook(ctx, "token", { skipVerification: true });

    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toMatch(/^plivo:skip:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });

  it("detects V3 replay when query parameters are reordered", () => {
    const authToken = "test-auth-token";
    const nonce = "nonce-v3-reorder";
    const postBody = "CallUUID=uuid&CallStatus=in-progress";

    const urlA = "https://example.com/voice/webhook?flow=answer&callId=abc";
    const urlB = "https://example.com/voice/webhook?callId=abc&flow=answer";

    const signatureA = plivoV3Signature({ authToken, nonce, postBody, urlWithQuery: urlA });
    const signatureB = plivoV3Signature({ authToken, nonce, postBody, urlWithQuery: urlB });
    expect(signatureA).toBe(signatureB);

    const first = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v3": signatureA,
          "x-plivo-signature-v3-nonce": nonce,
        },
        method: "POST",
        query: { callId: "abc", flow: "answer" },
        rawBody: postBody,
        url: urlA,
      },
      authToken,
    );

    const second = verifyPlivoWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-plivo-signature-v3": signatureB,
          "x-plivo-signature-v3-nonce": nonce,
        },
        method: "POST",
        query: { callId: "abc", flow: "answer" },
        rawBody: postBody,
        url: urlB,
      },
      authToken,
    );

    expectReplayResultPair(first, second);
  });
});

describe("verifyTelnyxWebhook", () => {
  it("marks replayed valid requests as replay without failing auth", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pemPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      data: { event_type: "call.initiated", payload: { call_control_id: "call-1" } },
      nonce: crypto.randomUUID(),
    });
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");
    const ctx = {
      headers: {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp,
      },
      method: "POST" as const,
      rawBody,
      url: "https://example.com/voice/webhook",
    };

    const first = verifyTelnyxWebhook(ctx, pemPublicKey);
    const second = verifyTelnyxWebhook(ctx, pemPublicKey);

    expectReplayResultPair(first, second);
  });

  it("treats Base64 and Base64URL signatures as the same replayed request", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pemPublicKey = publicKey.export({ format: "pem", type: "spki" }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      data: { event_type: "call.initiated", payload: { call_control_id: "call-1" } },
      nonce: crypto.randomUUID(),
    });
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = crypto.sign(null, Buffer.from(signedPayload), privateKey).toString("base64");
    const urlSafeSignature = signature.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const first = verifyTelnyxWebhook(
      {
        headers: {
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
        },
        method: "POST" as const,
        rawBody,
        url: "https://example.com/voice/webhook",
      },
      pemPublicKey,
    );
    const second = verifyTelnyxWebhook(
      {
        headers: {
          "telnyx-signature-ed25519": urlSafeSignature,
          "telnyx-timestamp": timestamp,
        },
        method: "POST" as const,
        rawBody,
        url: "https://example.com/voice/webhook",
      },
      pemPublicKey,
    );

    expectReplayResultPair(first, second);
  });

  it("returns a stable request key when verification is skipped", () => {
    const ctx = {
      headers: {},
      method: "POST" as const,
      rawBody: JSON.stringify({ data: { event_type: "call.initiated" } }),
      url: "https://example.com/voice/webhook",
    };
    const first = verifyTelnyxWebhook(ctx, undefined, { skipVerification: true });
    const second = verifyTelnyxWebhook(ctx, undefined, { skipVerification: true });

    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toMatch(/^telnyx:skip:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });
});

describe("verifyTwilioWebhook", () => {
  it("uses request query when publicUrl omits it", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const signature = twilioSignature({
      authToken,
      postBody,
      url: urlWithQuery,
    });

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "example.com",
          "x-forwarded-proto": "https",
          "x-twilio-signature": signature,
        },
        method: "POST",
        query: { callId: "abc" },
        rawBody: postBody,
        url: "http://local/voice/webhook?callId=abc",
      },
      authToken,
      { publicUrl },
    );

    expect(result.ok).toBe(true);
  });

  it("marks replayed valid requests as replay without failing auth", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS777&CallStatus=completed&From=%2B15550000000";
    const signature = twilioSignature({ authToken, postBody, url: urlWithQuery });
    const headers = {
      host: "example.com",
      "i-twilio-idempotency-token": "idem-replay-1",
      "x-forwarded-proto": "https",
      "x-twilio-signature": signature,
    };

    const first = verifyTwilioSignedRequest({ authToken, headers, publicUrl, rawBody: postBody });
    const second = verifyTwilioSignedRequest({ authToken, headers, publicUrl, rawBody: postBody });

    expectReplayResultPair(first, second);
  });

  it("treats changed idempotency header as replay for identical signed requests", () => {
    const authToken = "test-auth-token";
    const publicUrl = "https://example.com/voice/webhook";
    const urlWithQuery = `${publicUrl}?callId=abc`;
    const postBody = "CallSid=CS778&CallStatus=completed&From=%2B15550000000";
    const signature = twilioSignature({ authToken, postBody, url: urlWithQuery });

    const first = verifyTwilioSignedRequest({
      authToken,
      headers: {
        host: "example.com",
        "i-twilio-idempotency-token": "idem-replay-a",
        "x-forwarded-proto": "https",
        "x-twilio-signature": signature,
      },
      publicUrl,
      rawBody: postBody,
    });
    const second = verifyTwilioSignedRequest({
      authToken,
      headers: {
        host: "example.com",
        "i-twilio-idempotency-token": "idem-replay-b",
        "x-forwarded-proto": "https",
        "x-twilio-signature": signature,
      },
      publicUrl,
      rawBody: postBody,
    });

    expectReplayResultPair(first, second);
  });

  it("rejects invalid signatures even when attacker injects forwarded host", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "127.0.0.1:3334",
          "x-forwarded-host": "attacker.ngrok-free.app",
          "x-forwarded-proto": "https",
          "x-twilio-signature": "invalid",
        },
        method: "POST",
        rawBody: postBody,
        url: "http://127.0.0.1:3334/voice/webhook",
      },
      authToken,
    );

    expect(result.ok).toBe(false);
    // X-Forwarded-Host is ignored by default, so URL uses Host header
    expect(result.isNgrokFreeTier).toBe(false);
    expect(result.reason).toMatch(/Invalid signature/);
  });

  it("accepts valid signatures for ngrok free tier on loopback when compatibility mode is enabled", () => {
    const webhookUrl = "https://local.ngrok-free.app/voice/webhook";

    const signature = twilioSignature({
      authToken: "test-auth-token",
      postBody: "CallSid=CS123&CallStatus=completed&From=%2B15550000000",
      url: webhookUrl,
    });

    const result = verifyTwilioNgrokLoopback(signature);

    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(webhookUrl);
  });

  it("does not allow invalid signatures for ngrok free tier on loopback", () => {
    const result = verifyTwilioNgrokLoopback("invalid");

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Invalid signature/);
    expect(result.isNgrokFreeTier).toBe(true);
  });

  it("ignores attacker X-Forwarded-Host without allowedHosts or trustForwardingHeaders", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    // Attacker tries to inject their host - should be ignored
    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "legitimate.example.com",
          "x-forwarded-host": "attacker.evil.com",
          "x-twilio-signature": "invalid",
        },
        method: "POST",
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
      },
      authToken,
    );

    expect(result.ok).toBe(false);
    // Attacker's host is ignored - uses Host header instead
    expect(result.verificationUrl).toBe("https://legitimate.example.com/voice/webhook");
  });

  it("uses X-Forwarded-Host when allowedHosts whitelist is provided", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const webhookUrl = "https://myapp.ngrok.io/voice/webhook";

    const signature = twilioSignature({ authToken, postBody, url: webhookUrl });

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "myapp.ngrok.io",
          "x-forwarded-proto": "https",
          "x-twilio-signature": signature,
        },
        method: "POST",
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
      },
      authToken,
      { allowedHosts: ["myapp.ngrok.io"] },
    );

    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(webhookUrl);
  });

  it("rejects X-Forwarded-Host not in allowedHosts whitelist", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "attacker.evil.com",
          "x-twilio-signature": "invalid",
        },
        method: "POST",
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
      },
      authToken,
      { allowedHosts: ["myapp.ngrok.io", "webhook.example.com"] },
    );

    expect(result.ok).toBe(false);
    // Attacker's host not in whitelist, falls back to Host header
    expect(result.verificationUrl).toBe("https://localhost/voice/webhook");
  });

  it("trusts forwarding headers only from trusted proxy IPs", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    const webhookUrl = "https://proxy.example.com/voice/webhook";

    const signature = twilioSignature({ authToken, postBody, url: webhookUrl });

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "proxy.example.com",
          "x-forwarded-proto": "https",
          "x-twilio-signature": signature,
        },
        method: "POST",
        rawBody: postBody,
        remoteAddress: "203.0.113.10",
        url: "http://localhost:3000/voice/webhook",
      },
      authToken,
      { trustForwardingHeaders: true, trustedProxyIPs: ["203.0.113.10"] },
    );

    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(webhookUrl);
  });

  it("ignores forwarding headers when trustedProxyIPs are set but remote IP is missing", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "legitimate.example.com",
          "x-forwarded-host": "proxy.example.com",
          "x-forwarded-proto": "https",
          "x-twilio-signature": "invalid",
        },
        method: "POST",
        rawBody: postBody,
        url: "http://localhost:3000/voice/webhook",
      },
      authToken,
      { trustForwardingHeaders: true, trustedProxyIPs: ["203.0.113.10"] },
    );

    expect(result.ok).toBe(false);
    expect(result.verificationUrl).toBe("https://legitimate.example.com/voice/webhook");
  });
  it("returns a stable request key when verification is skipped", () => {
    const ctx = {
      headers: {},
      method: "POST" as const,
      rawBody: "CallSid=CS123&CallStatus=completed",
      url: "https://example.com/voice/webhook",
    };
    const first = verifyTwilioWebhook(ctx, "token", { skipVerification: true });
    const second = verifyTwilioWebhook(ctx, "token", { skipVerification: true });

    expect(first.ok).toBe(true);
    expect(first.verifiedRequestKey).toMatch(/^twilio:skip:/);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
    expect(second.isReplay).toBe(true);
  });

  it("succeeds when Twilio signs URL without port but server URL has port", () => {
    const authToken = "test-auth-token";
    const postBody = "CallSid=CS123&CallStatus=completed&From=%2B15550000000";
    // Twilio signs using URL without port.
    const urlWithPort = "https://example.com:8443/voice/webhook";
    const signedUrl = "https://example.com/voice/webhook";

    const signature = twilioSignature({ authToken, postBody, url: signedUrl });

    const result = verifyTwilioWebhook(
      {
        headers: {
          host: "example.com:8443",
          "x-twilio-signature": signature,
        },
        method: "POST",
        rawBody: postBody,
        url: urlWithPort,
      },
      authToken,
      { publicUrl: urlWithPort },
    );

    expect(result.ok).toBe(true);
    expect(result.verificationUrl).toBe(signedUrl);
    expect(result.verifiedRequestKey).toMatch(/^twilio:req:/);
  });
});
