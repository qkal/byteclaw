import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWhatsAppAccount, resolveWhatsAppAuthDir } from "./accounts.js";

describe("resolveWhatsAppAuthDir", () => {
  const stubCfg = { channels: { whatsapp: { accounts: {} } } } as Parameters<
    typeof resolveWhatsAppAuthDir
  >[0]["cfg"];

  it("sanitizes path traversal sequences in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      accountId: "../../../etc/passwd",
      cfg: stubCfg,
    });
    // Sanitized accountId must not escape the whatsapp auth directory.
    expect(authDir).not.toContain("..");
    expect(path.basename(authDir)).not.toContain("/");
  });

  it("sanitizes special characters in accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      accountId: "foo/bar\\baz",
      cfg: stubCfg,
    });
    // Sprawdzaj sanityzacje na segmencie accountId, nie na calej sciezce
    // (Windows uzywa backslash jako separator katalogow).
    const segment = path.basename(authDir);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
  });

  it("returns default directory for empty accountId", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      accountId: "",
      cfg: stubCfg,
    });
    expect(authDir).toMatch(/whatsapp[/\\]default$/);
  });

  it("preserves valid accountId unchanged", () => {
    const { authDir } = resolveWhatsAppAuthDir({
      accountId: "my-account-1",
      cfg: stubCfg,
    });
    expect(authDir).toMatch(/whatsapp[/\\]my-account-1$/);
  });

  it("merges top-level and account-specific config through shared helpers", () => {
    const resolved = resolveWhatsAppAccount({
      accountId: "work",
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {
                debounceMs: 250,
              },
            },
            debounceMs: 100,
            messagePrefix: "[root]",
            sendReadReceipts: false,
          },
        },
        messages: {
          messagePrefix: "[global]",
        },
      } as Parameters<typeof resolveWhatsAppAccount>[0]["cfg"],
    });

    expect(resolved.sendReadReceipts).toBe(false);
    expect(resolved.messagePrefix).toBe("[root]");
    expect(resolved.debounceMs).toBe(250);
  });
});
