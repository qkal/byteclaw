import { describe, expect, it } from "vitest";
import { IrcConfigSchema } from "./config-schema.js";

describe("irc config schema", () => {
  it("accepts numeric allowFrom and groupAllowFrom entries", () => {
    const parsed = IrcConfigSchema.parse({
      allowFrom: [12_345, "alice"],
      dmPolicy: "allowlist",
      groupAllowFrom: [67_890, "alice!ident@example.org"],
    });

    expect(parsed.allowFrom).toEqual([12_345, "alice"]);
    expect(parsed.groupAllowFrom).toEqual([67_890, "alice!ident@example.org"]);
  });

  it("accepts numeric per-channel allowFrom entries", () => {
    const parsed = IrcConfigSchema.parse({
      groups: {
        "#ops": {
          allowFrom: [42, "alice"],
        },
      },
    });

    expect(parsed.groups?.["#ops"]?.allowFrom).toEqual([42, "alice"]);
  });
});
