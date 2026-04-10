import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildCommandContext } from "./commands-context.js";
import { buildTestCtx } from "./test-ctx.js";

describe("buildCommandContext", () => {
  it("canonicalizes registered aliases like /id to their primary command", () => {
    const ctx = buildTestCtx({
      Body: "/id",
      BodyForCommands: "/id",
      CommandBody: "/id",
      From: "user",
      Provider: "discord",
      RawBody: "/id",
      Surface: "discord",
      To: "bot",
    });

    const result = buildCommandContext({
      cfg: {} as OpenClawConfig,
      commandAuthorized: true,
      ctx,
      isGroup: false,
      triggerBodyNormalized: "/id",
    });

    expect(result.commandBodyNormalized).toBe("/whoami");
  });
});
