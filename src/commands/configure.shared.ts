import {
  confirm as clackConfirm,
  intro as clackIntro,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";

export const CONFIGURE_WIZARD_SECTIONS = [
  "workspace",
  "model",
  "web",
  "gateway",
  "daemon",
  "channels",
  "plugins",
  "skills",
  "health",
] as const;

export type WizardSection = (typeof CONFIGURE_WIZARD_SECTIONS)[number];

export function parseConfigureWizardSections(raw: unknown): {
  sections: WizardSection[];
  invalid: string[];
} {
  const sectionsRaw: string[] = Array.isArray(raw) ? normalizeStringEntries(raw) : [];
  if (sectionsRaw.length === 0) {
    return { invalid: [], sections: [] };
  }

  const invalid = sectionsRaw.filter((s) => !CONFIGURE_WIZARD_SECTIONS.includes(s as never));
  const sections = sectionsRaw.filter((s): s is WizardSection =>
    CONFIGURE_WIZARD_SECTIONS.includes(s as never),
  );
  return { invalid, sections };
}

export type ChannelsWizardMode = "configure" | "remove";

export interface ConfigureWizardParams {
  command: "configure" | "update";
  sections?: WizardSection[];
}

export const CONFIGURE_SECTION_OPTIONS: {
  value: WizardSection;
  label: string;
  hint: string;
}[] = [
  { hint: "Set workspace + sessions", label: "Workspace", value: "workspace" },
  { hint: "Pick provider + credentials", label: "Model", value: "model" },
  { hint: "Configure web search (Perplexity/Brave) + fetch", label: "Web tools", value: "web" },
  { hint: "Port, bind, auth, tailscale", label: "Gateway", value: "gateway" },
  {
    hint: "Install/manage the background service",
    label: "Daemon",
    value: "daemon",
  },
  {
    hint: "Link WhatsApp/Telegram/etc and defaults",
    label: "Channels",
    value: "channels",
  },
  { hint: "Configure plugin settings (sandbox, tools, etc.)", label: "Plugins", value: "plugins" },
  { hint: "Install/enable workspace skills", label: "Skills", value: "skills" },
  {
    hint: "Run gateway + channel checks",
    label: "Health check",
    value: "health",
  },
];

export const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
export const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);
export const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
export const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });
