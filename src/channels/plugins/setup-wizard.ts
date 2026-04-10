import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { configureChannelAccessWithAllowlist } from "./setup-group-access-configure.js";
import type { ChannelAccessPolicy } from "./setup-group-access.js";
import {
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  runSingleChannelSecretStep,
  splitSetupEntries,
} from "./setup-wizard-helpers.js";
import type {
  ChannelSetupConfigureContext,
  ChannelSetupDmPolicy,
  ChannelSetupPlugin,
  ChannelSetupStatus,
  ChannelSetupStatusContext,
  ChannelSetupWizardAdapter,
} from "./setup-wizard-types.js";
import type { ChannelSetupInput } from "./types.core.js";

export interface ChannelSetupWizardStatus {
  configuredLabel: string;
  unconfiguredLabel: string;
  configuredHint?: string;
  unconfiguredHint?: string;
  configuredScore?: number;
  unconfiguredScore?: number;
  resolveConfigured: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => boolean | Promise<boolean>;
  resolveStatusLines?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    configured: boolean;
  }) => string[] | Promise<string[]>;
  resolveSelectionHint?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    configured: boolean;
  }) => string | undefined | Promise<string | undefined>;
  resolveQuickstartScore?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    configured: boolean;
  }) => number | undefined | Promise<number | undefined>;
}

export interface ChannelSetupWizardCredentialState {
  accountConfigured: boolean;
  hasConfiguredValue: boolean;
  resolvedValue?: string;
  envValue?: string;
}

type ChannelSetupWizardCredentialValues = Partial<Record<string, string>>;

export interface ChannelSetupWizardNote {
  title: string;
  lines: string[];
  shouldShow?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => boolean | Promise<boolean>;
}

export interface ChannelSetupWizardEnvShortcut {
  prompt: string;
  preferredEnvVar?: string;
  isAvailable: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
}

export interface ChannelSetupWizardCredential {
  inputKey: keyof ChannelSetupInput;
  providerHint: string;
  credentialLabel: string;
  preferredEnvVar?: string;
  helpTitle?: string;
  helpLines?: string[];
  envPrompt: string;
  keepPrompt: string;
  inputPrompt: string;
  allowEnv?: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  inspect: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => ChannelSetupWizardCredentialState;
  shouldPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    currentValue?: string;
    state: ChannelSetupWizardCredentialState;
  }) => boolean | Promise<boolean>;
  applyUseEnv?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    value: unknown;
    resolvedValue: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
}

export interface ChannelSetupWizardTextInput {
  inputKey: keyof ChannelSetupInput;
  message: string;
  placeholder?: string;
  required?: boolean;
  applyEmptyValue?: boolean;
  helpTitle?: string;
  helpLines?: string[];
  confirmCurrentValue?: boolean;
  keepPrompt?: string | ((value: string) => string);
  currentValue?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined | Promise<string | undefined>;
  initialValue?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined | Promise<string | undefined>;
  shouldPrompt?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    currentValue?: string;
  }) => boolean | Promise<boolean>;
  applyCurrentValue?: boolean;
  validate?: (params: {
    value: string;
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string | undefined;
  normalizeValue?: (params: {
    value: string;
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
  }) => string;
  applySet?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    value: string;
  }) => OpenClawConfig | Promise<OpenClawConfig>;
}

export interface ChannelSetupWizardAllowFromEntry {
  input: string;
  resolved: boolean;
  id: string | null;
}

export interface ChannelSetupWizardAllowFrom {
  helpTitle?: string;
  helpLines?: string[];
  credentialInputKey?: keyof ChannelSetupInput;
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseInputs?: (raw: string) => string[];
  parseId: (raw: string) => string | null;
  resolveEntries: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    entries: string[];
  }) => Promise<ChannelSetupWizardAllowFromEntry[]>;
  apply: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    allowFrom: string[];
  }) => OpenClawConfig | Promise<OpenClawConfig>;
}

export interface ChannelSetupWizardGroupAccess {
  label: string;
  placeholder: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: (params: { cfg: OpenClawConfig; accountId: string }) => ChannelAccessPolicy;
  currentEntries: (params: { cfg: OpenClawConfig; accountId: string }) => string[];
  updatePrompt: (params: { cfg: OpenClawConfig; accountId: string }) => boolean;
  setPolicy: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    policy: ChannelAccessPolicy;
  }) => OpenClawConfig;
  resolveAllowlist?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: ChannelSetupWizardCredentialValues;
    entries: string[];
    prompter: Pick<WizardPrompter, "note">;
  }) => Promise<unknown>;
  applyAllowlist?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: unknown;
  }) => OpenClawConfig;
}

export type ChannelSetupWizardPrepare = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: ChannelSetupWizardCredentialValues;
  runtime: ChannelSetupConfigureContext["runtime"];
  prompter: WizardPrompter;
  options?: ChannelSetupConfigureContext["options"];
}) =>
  | {
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    }
  | void
  | Promise<{
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    } | void>;

export type ChannelSetupWizardFinalize = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: ChannelSetupWizardCredentialValues;
  runtime: ChannelSetupConfigureContext["runtime"];
  prompter: WizardPrompter;
  options?: ChannelSetupConfigureContext["options"];
  forceAllowFrom: boolean;
}) =>
  | {
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    }
  | void
  | Promise<{
      cfg?: OpenClawConfig;
      credentialValues?: ChannelSetupWizardCredentialValues;
    } | void>;

export interface ChannelSetupWizard {
  channel: string;
  status: ChannelSetupWizardStatus;
  introNote?: ChannelSetupWizardNote;
  envShortcut?: ChannelSetupWizardEnvShortcut;
  resolveAccountIdForConfigure?: (params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    options?: ChannelSetupConfigureContext["options"];
    accountOverride?: string;
    shouldPromptAccountIds: boolean;
    listAccountIds: ChannelSetupWizardPlugin["config"]["listAccountIds"];
    defaultAccountId: string;
  }) => string | Promise<string>;
  resolveShouldPromptAccountIds?: (params: {
    cfg: OpenClawConfig;
    options?: ChannelSetupConfigureContext["options"];
    shouldPromptAccountIds: boolean;
  }) => boolean;
  prepare?: ChannelSetupWizardPrepare;
  stepOrder?: "credentials-first" | "text-first";
  credentials: ChannelSetupWizardCredential[];
  textInputs?: ChannelSetupWizardTextInput[];
  finalize?: ChannelSetupWizardFinalize;
  completionNote?: ChannelSetupWizardNote;
  dmPolicy?: ChannelSetupDmPolicy;
  allowFrom?: ChannelSetupWizardAllowFrom;
  groupAccess?: ChannelSetupWizardGroupAccess;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  onAccountRecorded?: ChannelSetupWizardAdapter["onAccountRecorded"];
}

type ChannelSetupWizardPlugin = ChannelSetupPlugin;

async function buildStatus(
  plugin: ChannelSetupWizardPlugin,
  wizard: ChannelSetupWizard,
  ctx: ChannelSetupStatusContext,
): Promise<ChannelSetupStatus> {
  const accountId = ctx.accountOverrides[plugin.id];
  const configured = await wizard.status.resolveConfigured({ accountId, cfg: ctx.cfg });
  const statusLines = (await wizard.status.resolveStatusLines?.({
    accountId,
    cfg: ctx.cfg,
    configured,
  })) ?? [
    `${plugin.meta.label}: ${configured ? wizard.status.configuredLabel : wizard.status.unconfiguredLabel}`,
  ];
  const selectionHint =
    (await wizard.status.resolveSelectionHint?.({
      accountId,
      cfg: ctx.cfg,
      configured,
    })) ?? (configured ? wizard.status.configuredHint : wizard.status.unconfiguredHint);
  const quickstartScore =
    (await wizard.status.resolveQuickstartScore?.({
      accountId,
      cfg: ctx.cfg,
      configured,
    })) ?? (configured ? wizard.status.configuredScore : wizard.status.unconfiguredScore);
  return {
    channel: plugin.id,
    configured,
    quickstartScore,
    selectionHint,
    statusLines,
  };
}

function applySetupInput(params: {
  plugin: ChannelSetupWizardPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}) {
  const { setup } = params.plugin;
  if (!setup?.applyAccountConfig) {
    throw new Error(`${params.plugin.id} does not support setup`);
  }
  const resolvedAccountId =
    setup.resolveAccountId?.({
      accountId: params.accountId,
      cfg: params.cfg,
      input: params.input,
    }) ?? params.accountId;
  const validationError = setup.validateInput?.({
    accountId: resolvedAccountId,
    cfg: params.cfg,
    input: params.input,
  });
  if (validationError) {
    throw new Error(validationError);
  }
  let next = setup.applyAccountConfig({
    accountId: resolvedAccountId,
    cfg: params.cfg,
    input: params.input,
  });
  if (params.input.name?.trim() && setup.applyAccountName) {
    next = setup.applyAccountName({
      accountId: resolvedAccountId,
      cfg: next,
      name: params.input.name,
    });
  }
  return {
    accountId: resolvedAccountId,
    cfg: next,
  };
}

function collectCredentialValues(params: {
  wizard: ChannelSetupWizard;
  cfg: OpenClawConfig;
  accountId: string;
}): ChannelSetupWizardCredentialValues {
  const values: ChannelSetupWizardCredentialValues = {};
  for (const credential of params.wizard.credentials) {
    const resolvedValue = normalizeOptionalString(
      credential.inspect({
        accountId: params.accountId,
        cfg: params.cfg,
      }).resolvedValue,
    );
    if (resolvedValue) {
      values[credential.inputKey] = resolvedValue;
    }
  }
  return values;
}

async function applyWizardTextInputValue(params: {
  plugin: ChannelSetupWizardPlugin;
  input: ChannelSetupWizardTextInput;
  cfg: OpenClawConfig;
  accountId: string;
  value: string;
}) {
  return params.input.applySet
    ? await params.input.applySet({
        accountId: params.accountId,
        cfg: params.cfg,
        value: params.value,
      })
    : applySetupInput({
        accountId: params.accountId,
        cfg: params.cfg,
        input: {
          [params.input.inputKey]: params.value,
        },
        plugin: params.plugin,
      }).cfg;
}

export function buildChannelSetupWizardAdapterFromSetupWizard(params: {
  plugin: ChannelSetupWizardPlugin;
  wizard: ChannelSetupWizard;
}): ChannelSetupWizardAdapter {
  const { plugin, wizard } = params;
  return {
    channel: plugin.id,
    configure: async ({
      cfg,
      runtime,
      prompter,
      options,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom,
    }) => {
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        plugin.config.listAccountIds(cfg)[0] ??
        DEFAULT_ACCOUNT_ID;
      const resolvedShouldPromptAccountIds =
        wizard.resolveShouldPromptAccountIds?.({
          cfg,
          options,
          shouldPromptAccountIds,
        }) ?? shouldPromptAccountIds;
      const accountId = await (wizard.resolveAccountIdForConfigure
        ? wizard.resolveAccountIdForConfigure({
            accountOverride: accountOverrides[plugin.id],
            cfg,
            defaultAccountId,
            listAccountIds: plugin.config.listAccountIds,
            options,
            prompter,
            shouldPromptAccountIds: resolvedShouldPromptAccountIds,
          })
        : resolveAccountIdForConfigure({
            accountOverride: accountOverrides[plugin.id],
            cfg,
            defaultAccountId,
            label: plugin.meta.label,
            listAccountIds: plugin.config.listAccountIds,
            prompter,
            shouldPromptAccountIds: resolvedShouldPromptAccountIds,
          }));

      let next = cfg;
      let credentialValues = collectCredentialValues({
        accountId,
        cfg: next,
        wizard,
      });
      let usedEnvShortcut = false;

      if (wizard.envShortcut?.isAvailable({ accountId, cfg: next })) {
        const useEnvShortcut = await prompter.confirm({
          initialValue: true,
          message: wizard.envShortcut.prompt,
        });
        if (useEnvShortcut) {
          next = await wizard.envShortcut.apply({ accountId, cfg: next });
          credentialValues = collectCredentialValues({
            accountId,
            cfg: next,
            wizard,
          });
          usedEnvShortcut = true;
        }
      }

      const shouldShowIntro =
        !usedEnvShortcut &&
        (wizard.introNote?.shouldShow
          ? await wizard.introNote.shouldShow({
              accountId,
              cfg: next,
              credentialValues,
            })
          : Boolean(wizard.introNote));
      if (shouldShowIntro && wizard.introNote) {
        await prompter.note(wizard.introNote.lines.join("\n"), wizard.introNote.title);
      }

      if (wizard.prepare) {
        const prepared = await wizard.prepare({
          accountId,
          cfg: next,
          credentialValues,
          options,
          prompter,
          runtime,
        });
        if (prepared?.cfg) {
          next = prepared.cfg;
        }
        if (prepared?.credentialValues) {
          credentialValues = {
            ...credentialValues,
            ...prepared.credentialValues,
          };
        }
      }

      const runCredentialSteps = async () => {
        if (usedEnvShortcut) {
          return;
        }
        for (const credential of wizard.credentials) {
          let credentialState = credential.inspect({ accountId, cfg: next });
          let resolvedCredentialValue = normalizeOptionalString(credentialState.resolvedValue);
          const shouldPrompt = credential.shouldPrompt
            ? await credential.shouldPrompt({
                accountId,
                cfg: next,
                credentialValues,
                currentValue: resolvedCredentialValue,
                state: credentialState,
              })
            : true;
          if (!shouldPrompt) {
            if (resolvedCredentialValue) {
              credentialValues[credential.inputKey] = resolvedCredentialValue;
            } else {
              delete credentialValues[credential.inputKey];
            }
            continue;
          }
          const allowEnv = credential.allowEnv?.({ accountId, cfg: next }) ?? false;

          const credentialResult = await runSingleChannelSecretStep({
            accountConfigured: credentialState.accountConfigured,
            allowEnv,
            applySet: async (currentCfg, value, resolvedValue) => {
              resolvedCredentialValue = resolvedValue;
              return credential.applySet
                ? await credential.applySet({
                    cfg: currentCfg,
                    accountId,
                    credentialValues,
                    value,
                    resolvedValue,
                  })
                : applySetupInput({
                    plugin,
                    cfg: currentCfg,
                    accountId,
                    input: {
                      [credential.inputKey]: value,
                      useEnv: false,
                    },
                  }).cfg;
            },
            applyUseEnv: async (currentCfg) =>
              credential.applyUseEnv
                ? await credential.applyUseEnv({
                    cfg: currentCfg,
                    accountId,
                  })
                : applySetupInput({
                    plugin,
                    cfg: currentCfg,
                    accountId,
                    input: {
                      [credential.inputKey]: undefined,
                      useEnv: true,
                    },
                  }).cfg,
            cfg: next,
            credentialLabel: credential.credentialLabel,
            envPrompt: credential.envPrompt,
            envValue: credentialState.envValue,
            hasConfigToken: credentialState.hasConfiguredValue,
            inputPrompt: credential.inputPrompt,
            keepPrompt: credential.keepPrompt,
            onMissingConfigured:
              credential.helpLines && credential.helpLines.length > 0
                ? async () => {
                    await prompter.note(
                      credential.helpLines!.join("\n"),
                      credential.helpTitle ?? credential.credentialLabel,
                    );
                  }
                : undefined,
            preferredEnvVar: credential.preferredEnvVar,
            prompter,
            providerHint: credential.providerHint,
            secretInputMode: options?.secretInputMode,
          });

          next = credentialResult.cfg;
          credentialState = credential.inspect({ accountId, cfg: next });
          resolvedCredentialValue =
            normalizeOptionalString(credentialResult.resolvedValue) ||
            normalizeOptionalString(credentialState.resolvedValue);
          if (resolvedCredentialValue) {
            credentialValues[credential.inputKey] = resolvedCredentialValue;
          } else {
            delete credentialValues[credential.inputKey];
          }
        }
      };

      const runTextInputSteps = async () => {
        for (const textInput of wizard.textInputs ?? []) {
          let currentValue = normalizeOptionalString(
            typeof credentialValues[textInput.inputKey] === "string"
              ? credentialValues[textInput.inputKey]
              : undefined,
          );
          if (!currentValue && textInput.currentValue) {
            currentValue = normalizeOptionalString(
              await textInput.currentValue({
                accountId,
                cfg: next,
                credentialValues,
              }),
            );
          }
          const shouldPrompt = textInput.shouldPrompt
            ? await textInput.shouldPrompt({
                accountId,
                cfg: next,
                credentialValues,
                currentValue,
              })
            : true;

          if (!shouldPrompt) {
            if (currentValue) {
              credentialValues[textInput.inputKey] = currentValue;
              if (textInput.applyCurrentValue) {
                next = await applyWizardTextInputValue({
                  accountId,
                  cfg: next,
                  input: textInput,
                  plugin,
                  value: currentValue,
                });
              }
            }
            continue;
          }

          if (textInput.helpLines && textInput.helpLines.length > 0) {
            await prompter.note(
              textInput.helpLines.join("\n"),
              textInput.helpTitle ?? textInput.message,
            );
          }

          if (currentValue && textInput.confirmCurrentValue !== false) {
            const keep = await prompter.confirm({
              initialValue: true,
              message:
                typeof textInput.keepPrompt === "function"
                  ? textInput.keepPrompt(currentValue)
                  : (textInput.keepPrompt ??
                    `${textInput.message} set (${currentValue}). Keep it?`),
            });
            if (keep) {
              credentialValues[textInput.inputKey] = currentValue;
              if (textInput.applyCurrentValue) {
                next = await applyWizardTextInputValue({
                  accountId,
                  cfg: next,
                  input: textInput,
                  plugin,
                  value: currentValue,
                });
              }
              continue;
            }
          }

          const initialValue = normalizeOptionalString(
            (await textInput.initialValue?.({
              accountId,
              cfg: next,
              credentialValues,
            })) ?? currentValue,
          );
          const rawValue = String(
            await prompter.text({
              initialValue,
              message: textInput.message,
              placeholder: textInput.placeholder,
              validate: (value) => {
                const trimmed = normalizeOptionalString(value) ?? "";
                if (!trimmed && textInput.required !== false) {
                  return "Required";
                }
                return textInput.validate?.({
                  value: trimmed,
                  cfg: next,
                  accountId,
                  credentialValues,
                });
              },
            }),
          );
          const trimmedValue = rawValue.trim();
          if (!trimmedValue && textInput.required === false) {
            if (textInput.applyEmptyValue) {
              next = await applyWizardTextInputValue({
                accountId,
                cfg: next,
                input: textInput,
                plugin,
                value: "",
              });
            }
            delete credentialValues[textInput.inputKey];
            continue;
          }
          const normalizedValue = normalizeOptionalString(
            textInput.normalizeValue?.({
              accountId,
              cfg: next,
              credentialValues,
              value: trimmedValue,
            }) ?? trimmedValue,
          );
          if (!normalizedValue) {
            delete credentialValues[textInput.inputKey];
            continue;
          }
          next = await applyWizardTextInputValue({
            accountId,
            cfg: next,
            input: textInput,
            plugin,
            value: normalizedValue,
          });
          credentialValues[textInput.inputKey] = normalizedValue;
        }
      };

      if (wizard.stepOrder === "text-first") {
        await runTextInputSteps();
        await runCredentialSteps();
      } else {
        await runCredentialSteps();
        await runTextInputSteps();
      }

      if (wizard.groupAccess) {
        const access = wizard.groupAccess;
        if (access.helpLines && access.helpLines.length > 0) {
          await prompter.note(access.helpLines.join("\n"), access.helpTitle ?? access.label);
        }
        next = await configureChannelAccessWithAllowlist({
          applyAllowlist: access.applyAllowlist
            ? ({ cfg: currentCfg, resolved }) =>
                access.applyAllowlist!({
                  cfg: currentCfg,
                  accountId,
                  resolved,
                })
            : undefined,
          cfg: next,
          currentEntries: access.currentEntries({ cfg: next, accountId }),
          currentPolicy: access.currentPolicy({ cfg: next, accountId }),
          label: access.label,
          placeholder: access.placeholder,
          prompter,
          resolveAllowlist: access.resolveAllowlist
            ? async ({ cfg: currentCfg, entries }) =>
                await access.resolveAllowlist!({
                  cfg: currentCfg,
                  accountId,
                  credentialValues,
                  entries,
                  prompter,
                })
            : undefined,
          setPolicy: (currentCfg, policy) =>
            access.setPolicy({
              cfg: currentCfg,
              accountId,
              policy,
            }),
          skipAllowlistEntries: access.skipAllowlistEntries,
          updatePrompt: access.updatePrompt({ cfg: next, accountId }),
        });
      }

      if (forceAllowFrom && wizard.allowFrom) {
        const { allowFrom } = wizard;
        const allowFromCredentialValue = normalizeOptionalString(
          credentialValues[allowFrom.credentialInputKey ?? wizard.credentials[0]?.inputKey],
        );
        if (allowFrom.helpLines && allowFrom.helpLines.length > 0) {
          await prompter.note(
            allowFrom.helpLines.join("\n"),
            allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          );
        }
        const existingAllowFrom =
          plugin.config.resolveAllowFrom?.({
            accountId,
            cfg: next,
          }) ?? [];
        const unique = await promptResolvedAllowFrom({
          existing: existingAllowFrom,
          invalidWithoutTokenNote: allowFrom.invalidWithoutCredentialNote,
          label: allowFrom.helpTitle ?? `${plugin.meta.label} allowlist`,
          message: allowFrom.message,
          parseId: allowFrom.parseId,
          parseInputs: allowFrom.parseInputs ?? splitSetupEntries,
          placeholder: allowFrom.placeholder,
          prompter,
          resolveEntries: async ({ entries }) =>
            allowFrom.resolveEntries({
              cfg: next,
              accountId,
              credentialValues,
              entries,
            }),
          token: allowFromCredentialValue,
        });
        next = await allowFrom.apply({
          accountId,
          allowFrom: unique,
          cfg: next,
        });
      }

      if (wizard.finalize) {
        const finalized = await wizard.finalize({
          accountId,
          cfg: next,
          credentialValues,
          forceAllowFrom,
          options,
          prompter,
          runtime,
        });
        if (finalized?.cfg) {
          next = finalized.cfg;
        }
        if (finalized?.credentialValues) {
          credentialValues = {
            ...credentialValues,
            ...finalized.credentialValues,
          };
        }
      }

      const shouldShowCompletionNote =
        wizard.completionNote &&
        (wizard.completionNote.shouldShow
          ? await wizard.completionNote.shouldShow({
              accountId,
              cfg: next,
              credentialValues,
            })
          : true);
      if (shouldShowCompletionNote && wizard.completionNote) {
        await prompter.note(wizard.completionNote.lines.join("\n"), wizard.completionNote.title);
      }

      return { accountId, cfg: next };
    },
    disable: wizard.disable,
    dmPolicy: wizard.dmPolicy,
    getStatus: async (ctx) => buildStatus(plugin, wizard, ctx),
    onAccountRecorded: wizard.onAccountRecorded,
  };
}
