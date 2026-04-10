import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardCoreAuthOptionKey = Extract<keyof OnboardOptions, string>;

export interface OnboardCoreAuthFlag {
  optionKey: OnboardCoreAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <key>`;
  description: string;
}

export const CORE_ONBOARD_AUTH_FLAGS: readonly OnboardCoreAuthFlag[] = [];
