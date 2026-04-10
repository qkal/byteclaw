import { describe, expect, it } from "vitest";
import { resolveMessageSecretScope } from "./message-secret-scope.js";

describe("resolveMessageSecretScope", () => {
  it("prefers explicit channel/account inputs", () => {
    expect(
      resolveMessageSecretScope({
        accountId: "Ops",
        channel: "Signal",
      }),
    ).toEqual({
      accountId: "ops",
      channel: "signal",
    });
  });

  it("infers channel from a prefixed target", () => {
    expect(
      resolveMessageSecretScope({
        target: "signal:12345",
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("infers a shared channel from target arrays", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["signal:one", "signal:two"],
      }),
    ).toEqual({
      channel: "signal",
    });
  });

  it("does not infer a channel when target arrays mix channels", () => {
    expect(
      resolveMessageSecretScope({
        targets: ["signal:one", "imessage:two"],
      }),
    ).toEqual({});
  });

  it("uses fallback channel/account when direct inputs are missing", () => {
    expect(
      resolveMessageSecretScope({
        fallbackAccountId: "Chat",
        fallbackChannel: "Signal",
      }),
    ).toEqual({
      accountId: "chat",
      channel: "signal",
    });
  });
});
