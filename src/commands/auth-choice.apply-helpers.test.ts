import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  ensureApiKeyFromEnvOrPrompt,
  ensureApiKeyFromOptionEnvOrPrompt,
  maybeApplyApiKeyFromOption,
  normalizeTokenProviderInput,
} from "./auth-choice.apply-helpers.js";

const ORIGINAL_MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ORIGINAL_MINIMAX_OAUTH_TOKEN = process.env.MINIMAX_OAUTH_TOKEN;

function restoreMinimaxEnv(): void {
  if (ORIGINAL_MINIMAX_API_KEY === undefined) {
    delete process.env.MINIMAX_API_KEY;
  } else {
    process.env.MINIMAX_API_KEY = ORIGINAL_MINIMAX_API_KEY;
  }
  if (ORIGINAL_MINIMAX_OAUTH_TOKEN === undefined) {
    delete process.env.MINIMAX_OAUTH_TOKEN;
  } else {
    process.env.MINIMAX_OAUTH_TOKEN = ORIGINAL_MINIMAX_OAUTH_TOKEN;
  }
}

function createPrompter(params?: {
  confirm?: WizardPrompter["confirm"];
  note?: WizardPrompter["note"];
  select?: WizardPrompter["select"];
  text?: WizardPrompter["text"];
}): WizardPrompter {
  return {
    confirm: params?.confirm ?? (vi.fn(async () => true) as WizardPrompter["confirm"]),
    note: params?.note ?? (vi.fn(async () => undefined) as WizardPrompter["note"]),
    ...(params?.select ? { select: params.select } : {}),
    text: params?.text ?? (vi.fn(async () => "prompt-key") as WizardPrompter["text"]),
  } as unknown as WizardPrompter;
}

function createPromptSpies(params?: { confirmResult?: boolean; textResult?: string }) {
  const confirm = vi.fn(async () => params?.confirmResult ?? true);
  const note = vi.fn(async () => undefined);
  const text = vi.fn(async () => params?.textResult ?? "prompt-key");
  return { confirm, note, text };
}

function createPromptAndCredentialSpies(params?: { confirmResult?: boolean; textResult?: string }) {
  return {
    ...createPromptSpies(params),
    setCredential: vi.fn(async () => undefined),
  };
}

function setMinimaxEnv(params: { apiKey?: string; oauthToken?: string } = {}) {
  if (params.apiKey === undefined) {
    delete process.env.MINIMAX_API_KEY;
  } else {
    process.env.MINIMAX_API_KEY = params.apiKey; // Pragma: allowlist secret
  }
  if (params.oauthToken === undefined) {
    delete process.env.MINIMAX_OAUTH_TOKEN;
  } else {
    process.env.MINIMAX_OAUTH_TOKEN = params.oauthToken; // Pragma: allowlist secret
  }
}

async function ensureMinimaxApiKey(params: {
  config?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["config"];
  env?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["env"];
  confirm: WizardPrompter["confirm"];
  note?: WizardPrompter["note"];
  select?: WizardPrompter["select"];
  text: WizardPrompter["text"];
  setCredential: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["setCredential"];
  secretInputMode?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["secretInputMode"];
}) {
  return await ensureMinimaxApiKeyInternal({
    config: params.config,
    env: params.env,
    prompter: createPrompter({
      confirm: params.confirm,
      note: params.note,
      select: params.select,
      text: params.text,
    }),
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
  });
}

async function ensureMinimaxApiKeyInternal(params: {
  config?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["config"];
  env?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["env"];
  prompter: WizardPrompter;
  secretInputMode?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["secretInputMode"];
  setCredential: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["setCredential"];
}) {
  return await ensureApiKeyFromEnvOrPrompt({
    config: params.config ?? {},
    env: params.env,
    envLabel: "MINIMAX_API_KEY",
    normalize: (value) => value.trim(),
    promptMessage: "Enter key",
    prompter: params.prompter,
    provider: "minimax",
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
    validate: () => undefined,
  });
}

async function ensureMinimaxApiKeyWithEnvRefPrompter(params: {
  config?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["config"];
  env?: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["env"];
  note: WizardPrompter["note"];
  select: WizardPrompter["select"];
  setCredential: Parameters<typeof ensureApiKeyFromEnvOrPrompt>[0]["setCredential"];
  text: WizardPrompter["text"];
}) {
  return await ensureMinimaxApiKeyInternal({
    config: params.config,
    env: params.env,
    prompter: createPrompter({ note: params.note, select: params.select, text: params.text }),
    secretInputMode: "ref", // Pragma: allowlist secret
    setCredential: params.setCredential,
  });
}

async function runEnsureMinimaxApiKeyFlow(params: { confirmResult: boolean; textResult: string }) {
  setMinimaxEnv({ apiKey: "env-key" });

  const { confirm, text } = createPromptSpies({
    confirmResult: params.confirmResult,
    textResult: params.textResult,
  });
  const setCredential = vi.fn(async () => undefined);
  const result = await ensureMinimaxApiKey({
    confirm,
    setCredential,
    text,
  });

  return { confirm, result, setCredential, text };
}

async function runMaybeApplyDemoToken(tokenProvider: string) {
  const setCredential = vi.fn(async () => undefined);
  const result = await maybeApplyApiKeyFromOption({
    expectedProviders: ["demo-provider"],
    normalize: (value) => value.trim(),
    setCredential,
    token: "  opt-key  ",
    tokenProvider,
  });
  return { result, setCredential };
}

function expectMinimaxEnvRefCredentialStored(setCredential: ReturnType<typeof vi.fn>) {
  expect(setCredential).toHaveBeenCalledWith(
    { id: "MINIMAX_API_KEY", provider: "default", source: "env" },
    "ref",
  );
}

async function ensureWithOptionEnvOrPrompt(params: {
  token: string;
  tokenProvider: string;
  expectedProviders: string[];
  provider: string;
  envLabel: string;
  confirm: WizardPrompter["confirm"];
  note: WizardPrompter["note"];
  noteMessage: string;
  noteTitle: string;
  setCredential: Parameters<typeof ensureApiKeyFromOptionEnvOrPrompt>[0]["setCredential"];
  text: WizardPrompter["text"];
}) {
  return await ensureApiKeyFromOptionEnvOrPrompt({
    config: {},
    envLabel: params.envLabel,
    expectedProviders: params.expectedProviders,
    normalize: (value) => value.trim(),
    noteMessage: params.noteMessage,
    noteTitle: params.noteTitle,
    promptMessage: "Enter key",
    prompter: createPrompter({ confirm: params.confirm, note: params.note, text: params.text }),
    provider: params.provider,
    setCredential: params.setCredential,
    token: params.token,
    tokenProvider: params.tokenProvider,
    validate: () => undefined,
  });
}

afterEach(() => {
  restoreMinimaxEnv();
  vi.restoreAllMocks();
});

describe("normalizeTokenProviderInput", () => {
  it("trims and lowercases non-empty values", () => {
    expect(normalizeTokenProviderInput("  DeMo-PrOvIdEr  ")).toBe("demo-provider");
    expect(normalizeTokenProviderInput("")).toBeUndefined();
  });
});

describe("maybeApplyApiKeyFromOption", () => {
  it.each(["demo-provider", "  DeMo-PrOvIdEr  "])(
    "stores normalized token when provider %p matches",
    async (tokenProvider) => {
      const { result, setCredential } = await runMaybeApplyDemoToken(tokenProvider);

      expect(result).toBe("opt-key");
      expect(setCredential).toHaveBeenCalledWith("opt-key", undefined);
    },
  );

  it("skips when provider does not match", async () => {
    const setCredential = vi.fn(async () => undefined);

    const result = await maybeApplyApiKeyFromOption({
      expectedProviders: ["demo-provider"],
      normalize: (value) => value.trim(),
      setCredential,
      token: "opt-key",
      tokenProvider: "other-provider",
    });

    expect(result).toBeUndefined();
    expect(setCredential).not.toHaveBeenCalled();
  });
});

describe("ensureApiKeyFromEnvOrPrompt", () => {
  it("uses env credential when user confirms", async () => {
    const { result, setCredential, text } = await runEnsureMinimaxApiKeyFlow({
      confirmResult: true,
      textResult: "prompt-key",
    });

    expect(result).toBe("env-key");
    expect(setCredential).toHaveBeenCalledWith("env-key", "plaintext");
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to prompt when env is declined", async () => {
    const { result, setCredential, text } = await runEnsureMinimaxApiKeyFlow({
      confirmResult: false,
      textResult: "  prompted-key  ",
    });

    expect(result).toBe("prompted-key");
    expect(setCredential).toHaveBeenCalledWith("prompted-key", "plaintext");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter key",
      }),
    );
  });

  it("uses explicit inline env ref when secret-input-mode=ref selects existing env key", async () => {
    setMinimaxEnv({ apiKey: "env-key" });

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureMinimaxApiKey({
      confirm,
      text,
      secretInputMode: "ref", // Pragma: allowlist secret
      setCredential,
    });

    expect(result).toBe("env-key");
    expectMinimaxEnvRefCredentialStored(setCredential);
    expect(text).not.toHaveBeenCalled();
  });

  it("fails ref mode without select when fallback env var is missing", async () => {
    setMinimaxEnv();

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    await expect(
      ensureMinimaxApiKey({
        confirm,
        text,
        secretInputMode: "ref", // Pragma: allowlist secret
        setCredential,
      }),
    ).rejects.toThrow(
      'Environment variable "MINIMAX_API_KEY" is required for --secret-input-mode ref in non-interactive setup.',
    );
    expect(setCredential).not.toHaveBeenCalled();
  });

  it("uses explicit env for ref fallback instead of host process env", async () => {
    setMinimaxEnv({ apiKey: "host-key" });
    const env = { MINIMAX_API_KEY: "explicit-key" } as NodeJS.ProcessEnv;

    const { confirm, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureMinimaxApiKey({
      confirm,
      text,
      env,
      secretInputMode: "ref", // Pragma: allowlist secret
      setCredential,
    });

    expect(result).toBe("explicit-key");
    expectMinimaxEnvRefCredentialStored(setCredential);
  });

  it("re-prompts after provider ref validation failure and succeeds with env ref", async () => {
    setMinimaxEnv({ apiKey: "env-key" });

    const selectValues: ("provider" | "env" | "filemain")[] = ["provider", "filemain", "env"];
    const select = vi.fn(async () => selectValues.shift() ?? "env") as WizardPrompter["select"];
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("/providers/minimax/apiKey")
      .mockResolvedValueOnce("MINIMAX_API_KEY");
    const note = vi.fn(async () => undefined);
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureMinimaxApiKeyWithEnvRefPrompter({
      config: {
        secrets: {
          providers: {
            filemain: {
              mode: "json",
              path: "/tmp/does-not-exist-secrets.json",
              source: "file",
            },
          },
        },
      },
      note,
      select,
      setCredential,
      text,
    });

    expect(result).toBe("env-key");
    expectMinimaxEnvRefCredentialStored(setCredential);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
  });

  it("never includes resolved env secret values in reference validation notes", async () => {
    setMinimaxEnv({ apiKey: "sk-minimax-redacted-value" });

    const select = vi.fn(async () => "env") as WizardPrompter["select"];
    const text = vi.fn<WizardPrompter["text"]>().mockResolvedValue("MINIMAX_API_KEY");
    const note = vi.fn(async () => undefined);
    const setCredential = vi.fn(async () => undefined);

    const result = await ensureMinimaxApiKeyWithEnvRefPrompter({
      config: {},
      note,
      select,
      setCredential,
      text,
    });

    expect(result).toBe("sk-minimax-redacted-value");
    const noteMessages = note.mock.calls.map((call) => String(call.at(0) ?? "")).join("\n");
    expect(noteMessages).toContain("Validated environment variable MINIMAX_API_KEY.");
    expect(noteMessages).not.toContain("sk-minimax-redacted-value");
  });
});

describe("ensureApiKeyFromOptionEnvOrPrompt", () => {
  it("uses opts token and skips note/env/prompt", async () => {
    const { confirm, note, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureWithOptionEnvOrPrompt({
      confirm,
      envLabel: "DEMO_TOKEN",
      expectedProviders: ["demo-provider"],
      note,
      noteMessage: "Demo note",
      noteTitle: "Demo",
      provider: "demo-provider",
      setCredential,
      text,
      token: "  opts-key  ",
      tokenProvider: " DEMO-PROVIDER ",
    });

    expect(result).toBe("opts-key");
    expect(setCredential).toHaveBeenCalledWith("opts-key", undefined);
    expect(note).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("falls back to env flow and shows note when opts provider does not match", async () => {
    setMinimaxEnv({ apiKey: "env-key" });

    const { confirm, note, text, setCredential } = createPromptAndCredentialSpies({
      confirmResult: true,
      textResult: "prompt-key",
    });

    const result = await ensureWithOptionEnvOrPrompt({
      confirm,
      envLabel: "MINIMAX_API_KEY",
      expectedProviders: ["minimax"],
      note,
      noteMessage: "Demo provider note",
      noteTitle: "Demo provider",
      provider: "minimax",
      setCredential,
      text,
      token: "opts-key",
      tokenProvider: "other-provider",
    });

    expect(result).toBe("env-key");
    expect(note).toHaveBeenCalledWith("Demo provider note", "Demo provider");
    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith("env-key", "plaintext");
  });
});
