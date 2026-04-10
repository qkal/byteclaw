import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import {
  reserveSkillCommandNames,
  resolveConfiguredDirectiveAliases,
} from "./get-reply-directive-aliases.js";

function configWithModelAlias(alias: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-6": { alias },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("reply directive aliases", () => {
  it("does not expose skill command names as inline model aliases", () => {
    const reservedCommands = new Set<string>();
    const cfg = configWithModelAlias("demo_skill");

    expect(
      parseInlineDirectives("/demo_skill", {
        modelAliases: resolveConfiguredDirectiveAliases({
          cfg,
          commandTextHasSlash: true,
          reservedCommands,
        }),
      }),
    ).toEqual(expect.objectContaining({ cleaned: "", hasModelDirective: true }));

    reserveSkillCommandNames({
      reservedCommands,
      skillCommands: [
        {
          description: "Demo skill",
          name: "demo_skill",
          skillName: "demo-skill",
          sourceFilePath: "/tmp/demo/SKILL.md",
        },
      ],
    });

    expect(
      parseInlineDirectives("/demo_skill", {
        modelAliases: resolveConfiguredDirectiveAliases({
          cfg,
          commandTextHasSlash: true,
          reservedCommands,
        }),
      }),
    ).toEqual(expect.objectContaining({ cleaned: "/demo_skill", hasModelDirective: false }));
  });
});
