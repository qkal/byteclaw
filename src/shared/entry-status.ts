import { resolveEmojiAndHomepage } from "./entry-metadata.js";
import {
  type RequirementConfigCheck,
  type RequirementRemote,
  type Requirements,
  type RequirementsMetadata,
  evaluateRequirementsFromMetadataWithRemote,
} from "./requirements.js";

export type EntryMetadataRequirementsParams = Parameters<
  typeof evaluateEntryMetadataRequirements
>[0];

export function evaluateEntryMetadataRequirements(params: {
  always: boolean;
  metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
  frontmatter?: {
    emoji?: string;
    homepage?: string;
    website?: string;
    url?: string;
  } | null;
  hasLocalBin: (bin: string) => boolean;
  localPlatform: string;
  remote?: RequirementRemote;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}): {
  emoji?: string;
  homepage?: string;
  required: Requirements;
  missing: Requirements;
  requirementsSatisfied: boolean;
  configChecks: RequirementConfigCheck[];
} {
  const { emoji, homepage } = resolveEmojiAndHomepage({
    frontmatter: params.frontmatter,
    metadata: params.metadata,
  });
  const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
    always: params.always,
    hasLocalBin: params.hasLocalBin,
    isConfigSatisfied: params.isConfigSatisfied,
    isEnvSatisfied: params.isEnvSatisfied,
    localPlatform: params.localPlatform,
    metadata: params.metadata ?? undefined,
    remote: params.remote,
  });
  return {
    ...(emoji ? { emoji } : {}),
    ...(homepage ? { homepage } : {}),
    configChecks,
    missing,
    required,
    requirementsSatisfied: eligible,
  };
}

export function evaluateEntryMetadataRequirementsForCurrentPlatform(
  params: Omit<EntryMetadataRequirementsParams, "localPlatform">,
): ReturnType<typeof evaluateEntryMetadataRequirements> {
  return evaluateEntryMetadataRequirements({
    ...params,
    localPlatform: process.platform,
  });
}

export function evaluateEntryRequirementsForCurrentPlatform(params: {
  always: boolean;
  entry: {
    metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
    frontmatter?: {
      emoji?: string;
      homepage?: string;
      website?: string;
      url?: string;
    } | null;
  };
  hasLocalBin: (bin: string) => boolean;
  remote?: RequirementRemote;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}): ReturnType<typeof evaluateEntryMetadataRequirements> {
  return evaluateEntryMetadataRequirementsForCurrentPlatform({
    always: params.always,
    frontmatter: params.entry.frontmatter,
    hasLocalBin: params.hasLocalBin,
    isConfigSatisfied: params.isConfigSatisfied,
    isEnvSatisfied: params.isEnvSatisfied,
    metadata: params.entry.metadata,
    remote: params.remote,
  });
}
