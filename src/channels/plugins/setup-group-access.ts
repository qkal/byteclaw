import type { WizardPrompter } from "../../wizard/prompts.js";
import { splitSetupEntries } from "./setup-wizard-helpers.js";

export type ChannelAccessPolicy = "allowlist" | "open" | "disabled";

export function parseAllowlistEntries(raw: string): string[] {
  return splitSetupEntries(String(raw ?? ""));
}

export function formatAllowlistEntries(entries: string[]): string {
  return entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(", ");
}

export async function promptChannelAccessPolicy(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  allowOpen?: boolean;
  allowDisabled?: boolean;
}): Promise<ChannelAccessPolicy> {
  const options: { value: ChannelAccessPolicy; label: string }[] = [
    { label: "Allowlist (recommended)", value: "allowlist" },
  ];
  if (params.allowOpen !== false) {
    options.push({ label: "Open (allow all channels)", value: "open" });
  }
  if (params.allowDisabled !== false) {
    options.push({ label: "Disabled (block all channels)", value: "disabled" });
  }
  const initialValue = params.currentPolicy ?? "allowlist";
  return await params.prompter.select({
    initialValue,
    message: `${params.label} access`,
    options,
  });
}

export async function promptChannelAllowlist(params: {
  prompter: WizardPrompter;
  label: string;
  currentEntries?: string[];
  placeholder?: string;
}): Promise<string[]> {
  const initialValue =
    params.currentEntries && params.currentEntries.length > 0
      ? formatAllowlistEntries(params.currentEntries)
      : undefined;
  const raw = await params.prompter.text({
    initialValue,
    message: `${params.label} allowlist (comma-separated)`,
    placeholder: params.placeholder,
  });
  return parseAllowlistEntries(raw);
}

export async function promptChannelAccessConfig(params: {
  prompter: WizardPrompter;
  label: string;
  currentPolicy?: ChannelAccessPolicy;
  currentEntries?: string[];
  placeholder?: string;
  allowOpen?: boolean;
  allowDisabled?: boolean;
  skipAllowlistEntries?: boolean;
  defaultPrompt?: boolean;
  updatePrompt?: boolean;
}): Promise<{ policy: ChannelAccessPolicy; entries: string[] } | null> {
  const hasEntries = (params.currentEntries ?? []).length > 0;
  const shouldPrompt = params.defaultPrompt ?? !hasEntries;
  const wants = await params.prompter.confirm({
    initialValue: shouldPrompt,
    message: params.updatePrompt
      ? `Update ${params.label} access?`
      : `Configure ${params.label} access?`,
  });
  if (!wants) {
    return null;
  }
  const policy = await promptChannelAccessPolicy({
    allowDisabled: params.allowDisabled,
    allowOpen: params.allowOpen,
    currentPolicy: params.currentPolicy,
    label: params.label,
    prompter: params.prompter,
  });
  if (policy !== "allowlist") {
    return { entries: [], policy };
  }
  if (params.skipAllowlistEntries) {
    return { entries: [], policy };
  }
  const entries = await promptChannelAllowlist({
    currentEntries: params.currentEntries,
    label: params.label,
    placeholder: params.placeholder,
    prompter: params.prompter,
  });
  return { entries, policy };
}
