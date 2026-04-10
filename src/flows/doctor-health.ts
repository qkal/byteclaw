import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { loadAndMaybeMigrateDoctorConfig } from "../commands/doctor-config-flow.js";
import { noteSourceInstallIssues } from "../commands/doctor-install.js";
import { noteStartupOptimizationHints } from "../commands/doctor-platform-notes.js";
import { type DoctorOptions, createDoctorPrompter } from "../commands/doctor-prompter.js";
import { maybeRepairUiProtocolFreshness } from "../commands/doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "../commands/doctor-update.js";
import { printWizardHeader } from "../commands/onboard-helpers.js";
import { CONFIG_PATH } from "../config/config.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { runDoctorHealthContributions } from "./doctor-health-contributions.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const prompter = createDoctorPrompter({ options, runtime });
  printWizardHeader(runtime);
  intro("OpenClaw doctor");

  const root = await resolveOpenClawPackageRoot({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });

  const updateResult = await maybeOfferUpdateBeforeDoctor({
    confirm: (p) => prompter.confirm(p),
    options,
    outro,
    root,
    runtime,
  });
  if (updateResult.handled) {
    return;
  }

  await maybeRepairUiProtocolFreshness(runtime, prompter);
  noteSourceInstallIssues(root);
  noteStartupOptimizationHints();

  const configResult = await loadAndMaybeMigrateDoctorConfig({
    confirm: (p) => prompter.confirm(p),
    options,
  });
  const ctx = {
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    configPath: configResult.path ?? CONFIG_PATH,
    configResult,
    options,
    prompter,
    runtime,
    sourceConfigValid: configResult.sourceConfigValid ?? true,
  };
  await runDoctorHealthContributions(ctx);

  outro("Doctor complete.");
}
