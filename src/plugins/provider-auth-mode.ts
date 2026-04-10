import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./provider-auth-types.js";

export interface SecretInputModePromptCopy {
  modeMessage?: string;
  plaintextLabel?: string;
  plaintextHint?: string;
  refLabel?: string;
  refHint?: string;
}

export async function resolveSecretInputModeForEnvSelection(params: {
  prompter: Pick<WizardPrompter, "select">;
  explicitMode?: SecretInputMode;
  copy?: SecretInputModePromptCopy;
}): Promise<SecretInputMode> {
  if (params.explicitMode) {
    return params.explicitMode;
  }
  if (typeof params.prompter.select !== "function") {
    return "plaintext";
  }
  const selected = await params.prompter.select<SecretInputMode>({
    initialValue: "plaintext",
    message: params.copy?.modeMessage ?? "How do you want to provide this API key?",
    options: [
      {
        hint: params.copy?.plaintextHint ?? "Stores the key directly in OpenClaw config",
        label: params.copy?.plaintextLabel ?? "Paste API key now",
        value: "plaintext",
      },
      {
        hint:
          params.copy?.refHint ??
          "Stores a reference to env or configured external secret providers",
        label: params.copy?.refLabel ?? "Use external secret provider",
        value: "ref",
      },
    ],
  });
  return selected === "ref" ? "ref" : "plaintext";
}
