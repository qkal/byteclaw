import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  formatOpenAIOAuthTlsPreflightFix: vi.fn(),
  loginOpenAICodex: vi.fn(),
  runOpenAIOAuthTlsPreflight: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    loginOpenAICodex: mocks.loginOpenAICodex,
  };
});

vi.mock("../plugins/provider-openai-codex-oauth-tls.js", () => ({
  formatOpenAIOAuthTlsPreflightFix: mocks.formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight: mocks.runOpenAIOAuthTlsPreflight,
}));

import { loginOpenAICodexOAuth } from "../plugins/provider-openai-codex-oauth.js";

function createPrompter() {
  const spin = { stop: vi.fn(), update: vi.fn() };
  const prompter: Pick<WizardPrompter, "note" | "progress" | "text"> = {
    note: vi.fn(async () => {}),
    progress: vi.fn(() => spin),
    text: vi.fn(async () => "http://localhost:1455/auth/callback?code=test"),
  };
  return { prompter: prompter as unknown as WizardPrompter, spin };
}

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
    log: vi.fn(),
  };
}

async function runCodexOAuth(params: {
  isRemote: boolean;
  openUrl?: (url: string) => Promise<void>;
}) {
  const { prompter, spin } = createPrompter();
  const runtime = createRuntime();
  const result = await loginOpenAICodexOAuth({
    isRemote: params.isRemote,
    openUrl: params.openUrl ?? (async () => {}),
    prompter,
    runtime,
  });
  return { prompter, result, runtime, spin };
}

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({ ok: true });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("tls fix");
  });

  it("returns credentials on successful oauth login", async () => {
    const creds = {
      access: "access-token",
      email: "user@example.com",
      expires: Date.now() + 60_000,
      provider: "openai-codex" as const,
      refresh: "refresh-token",
    };
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { result, spin, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth complete");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("passes through Pi-provided OAuth authorize URL without mutation", async () => {
    const creds = {
      access: "access-token",
      email: "user@example.com",
      expires: Date.now() + 60_000,
      provider: "openai-codex" as const,
      refresh: "refresh-token",
    };
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: { onAuth: (event: { url: string }) => Promise<void> }) => {
        await opts.onAuth({
          url: "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
        });
        return creds;
      },
    );

    const openUrl = vi.fn(async () => {});
    const { runtime } = await runCodexOAuth({ isRemote: false, openUrl });

    expect(openUrl).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Open: https://auth.openai.com/oauth/authorize?scope=openid+profile+email+offline_access&state=abc",
    );
  });

  it("reports oauth errors and rethrows", async () => {
    mocks.loginOpenAICodex.mockRejectedValue(new Error("oauth failed"));

    const { prompter, spin } = createPrompter();
    const runtime = createRuntime();
    await expect(
      loginOpenAICodexOAuth({
        isRemote: true,
        openUrl: async () => {},
        prompter,
        runtime,
      }),
    ).rejects.toThrow("oauth failed");

    expect(spin.stop).toHaveBeenCalledWith("OpenAI OAuth failed");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("oauth failed"));
    expect(prompter.note).toHaveBeenCalledWith(
      "Trouble with OAuth? See https://docs.openclaw.ai/start/faq",
      "OAuth help",
    );
  });

  it("passes manual code input hook for remote oauth flows", async () => {
    const creds = {
      access: "access-token",
      email: "user@example.com",
      expires: Date.now() + 60_000,
      provider: "openai-codex" as const,
      refresh: "refresh-token",
    };
    mocks.loginOpenAICodex.mockImplementation(
      async (opts: {
        onAuth: (event: { url: string }) => Promise<void>;
        onManualCodeInput?: () => Promise<string>;
      }) => {
        await opts.onAuth({
          url: "https://auth.openai.com/oauth/authorize?state=abc",
        });
        expect(opts.onManualCodeInput).toBeTypeOf("function");
        await expect(opts.onManualCodeInput?.()).resolves.toContain("code=test");
        return creds;
      },
    );

    const { result, prompter } = await runCodexOAuth({ isRemote: true });

    expect(result).toEqual(creds);
    expect(prompter.text).toHaveBeenCalledWith({
      message: "Paste the authorization code (or full redirect URL):",
      validate: expect.any(Function),
    });
  });

  it("continues OAuth flow on non-certificate preflight failures", async () => {
    const creds = {
      access: "access-token",
      email: "user@example.com",
      expires: Date.now() + 60_000,
      provider: "openai-codex" as const,
      refresh: "refresh-token",
    };
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      kind: "network",
      message: "Client network socket disconnected before secure TLS connection was established",
      ok: false,
    });
    mocks.loginOpenAICodex.mockResolvedValue(creds);

    const { result, prompter, runtime } = await runCodexOAuth({ isRemote: false });

    expect(result).toEqual(creds);
    expect(mocks.loginOpenAICodex).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalledWith("tls fix");
    expect(prompter.note).not.toHaveBeenCalledWith("tls fix", "OAuth prerequisites");
  });

  it("fails early with actionable message when TLS preflight fails", async () => {
    mocks.runOpenAIOAuthTlsPreflight.mockResolvedValue({
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      kind: "tls-cert",
      message: "unable to get local issuer certificate",
      ok: false,
    });
    mocks.formatOpenAIOAuthTlsPreflightFix.mockReturnValue("Run brew postinstall openssl@3");

    const { prompter } = createPrompter();
    const runtime = createRuntime();

    await expect(
      loginOpenAICodexOAuth({
        isRemote: false,
        openUrl: async () => {},
        prompter,
        runtime,
      }),
    ).rejects.toThrow("unable to get local issuer certificate");

    expect(mocks.loginOpenAICodex).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Run brew postinstall openssl@3");
    expect(prompter.note).toHaveBeenCalledWith(
      "Run brew postinstall openssl@3",
      "OAuth prerequisites",
    );
  });
});
