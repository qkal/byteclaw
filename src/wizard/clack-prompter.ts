import {
  type Option,
  autocompleteMultiselect,
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { createCliProgress } from "../cli/progress.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { stripAnsi } from "../terminal/ansi.js";
import { note as emitNote } from "../terminal/note.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import type { WizardProgress, WizardPrompter } from "./prompts.js";
import { WizardCancelledError } from "./prompts.js";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
}

function normalizeSearchTokens(search: string): string[] {
  return normalizeLowercaseStringOrEmpty(search)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function buildOptionSearchText<T>(option: Option<T>): string {
  const label = stripAnsi(option.label ?? "");
  const hint = stripAnsi(option.hint ?? "");
  const value = String(option.value ?? "");
  return normalizeLowercaseStringOrEmpty(`${label} ${hint} ${value}`);
}

export function tokenizedOptionFilter<T>(search: string, option: Option<T>): boolean {
  const tokens = normalizeSearchTokens(search);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = buildOptionSearchText(option);
  return tokens.every((token) => haystack.includes(token));
}

export function createClackPrompter(): WizardPrompter {
  return {
    confirm: async (params) =>
      guardCancel(
        await confirm({
          initialValue: params.initialValue,
          message: stylePromptMessage(params.message),
        }),
      ),
    intro: async (title) => {
      intro(stylePromptTitle(title) ?? title);
    },
    multiselect: async (params) => {
      const options = params.options.map((opt) => {
        const base = { label: opt.label, value: opt.value };
        return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
      }) as Option<(typeof params.options)[number]["value"]>[];

      if (params.searchable) {
        return guardCancel(
          await autocompleteMultiselect({
            filter: tokenizedOptionFilter,
            initialValues: params.initialValues,
            message: stylePromptMessage(params.message),
            options,
          }),
        );
      }

      return guardCancel(
        await multiselect({
          initialValues: params.initialValues,
          message: stylePromptMessage(params.message),
          options,
        }),
      );
    },
    note: async (message, title) => {
      emitNote(message, title);
    },
    outro: async (message) => {
      outro(stylePromptTitle(message) ?? message);
    },
    progress: (label: string): WizardProgress => {
      const spin = spinner();
      spin.start(theme.accent(label));
      const osc = createCliProgress({
        enabled: true,
        fallback: "none",
        indeterminate: true,
        label,
      });
      return {
        stop: (message) => {
          osc.done();
          spin.stop(message);
        },
        update: (message) => {
          spin.message(theme.accent(message));
          osc.setLabel(message);
        },
      };
    },
    select: async (params) =>
      guardCancel(
        await select({
          initialValue: params.initialValue,
          message: stylePromptMessage(params.message),
          options: params.options.map((opt) => {
            const base = { value: opt.value, label: opt.label };
            return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
          }) as Option<(typeof params.options)[number]["value"]>[],
        }),
      ),
    text: async (params) => {
      const { validate } = params;
      return guardCancel(
        await text({
          initialValue: params.initialValue,
          message: stylePromptMessage(params.message),
          placeholder: params.placeholder,
          validate: validate ? (value) => validate(value ?? "") : undefined,
        }),
      );
    },
  };
}
