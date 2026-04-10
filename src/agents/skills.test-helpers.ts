import fs from "node:fs/promises";
import path from "node:path";
import { type Skill, createSyntheticSourceInfo } from "./skills/skill-contract.js";

export async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  body?: string;
}) {
  const { dir, name, description, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

${body ?? `# ${name}\n`}
`,
    "utf8",
  );
}

export function createCanonicalFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): Skill {
  return {
    baseDir: params.baseDir,
    description: params.description,
    disableModelInvocation: params.disableModelInvocation ?? false,
    filePath: params.filePath,
    name: params.name,
    source: params.source,
    sourceInfo: createSyntheticSourceInfo(params.filePath, {
      baseDir: params.baseDir,
      origin: "top-level",
      scope: "project",
      source: params.source,
    }),
  };
}
