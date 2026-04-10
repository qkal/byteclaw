import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";

interface MediaGenerateActionResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

type TaskStatusTextBuilder<Task> = (task: Task, params?: { duplicateGuard?: boolean }) => string;
interface MediaGenerateProvider {
  id: string;
  defaultModel?: string;
  models?: string[];
  capabilities: unknown;
}

export type { MediaGenerateActionResult };

export function createMediaGenerateProviderListActionResult<
  TProvider extends MediaGenerateProvider,
>(params: {
  providers: TProvider[];
  emptyText: string;
  listModes: (provider: TProvider) => string[];
  summarizeCapabilities: (provider: TProvider) => string;
}): MediaGenerateActionResult {
  if (params.providers.length === 0) {
    return {
      content: [{ text: params.emptyText, type: "text" }],
      details: { providers: [] },
    };
  }

  const lines = params.providers.map((provider) => {
    const authHints = getProviderEnvVars(provider.id);
    const capabilities = params.summarizeCapabilities(provider);
    return [
      `${provider.id}: default=${provider.defaultModel ?? "none"}`,
      provider.models?.length ? `models=${provider.models.join(", ")}` : null,
      capabilities ? `capabilities=${capabilities}` : null,
      authHints.length > 0 ? `auth=${authHints.join(" / ")}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" | ");
  });

  return {
    content: [{ text: lines.join("\n"), type: "text" }],
    details: {
      providers: params.providers.map((provider) => ({
        authEnvVars: getProviderEnvVars(provider.id),
        capabilities: provider.capabilities,
        defaultModel: provider.defaultModel,
        id: provider.id,
        models: provider.models ?? [],
        modes: params.listModes(provider),
      })),
    },
  };
}

export function createMediaGenerateTaskStatusActions<Task>(params: {
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}) {
  return {
    createDuplicateGuardResult(sessionKey?: string): MediaGenerateActionResult | undefined {
      return createMediaGenerateDuplicateGuardResult({
        buildStatusDetails: params.buildStatusDetails,
        buildStatusText: params.buildStatusText,
        findActiveTask: params.findActiveTask,
        sessionKey,
      });
    },

    createStatusActionResult(sessionKey?: string): MediaGenerateActionResult {
      return createMediaGenerateStatusActionResult({
        buildStatusDetails: params.buildStatusDetails,
        buildStatusText: params.buildStatusText,
        findActiveTask: params.findActiveTask,
        inactiveText: params.inactiveText,
        sessionKey,
      });
    },
  };
}

export function createMediaGenerateStatusActionResult<Task>(params: {
  sessionKey?: string;
  inactiveText: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return {
      content: [{ text: params.inactiveText, type: "text" }],
      details: {
        action: "status",
        active: false,
      },
    };
  }
  return {
    content: [{ text: params.buildStatusText(activeTask), type: "text" }],
    details: {
      action: "status",
      ...params.buildStatusDetails(activeTask),
    },
  };
}

export function createMediaGenerateDuplicateGuardResult<Task>(params: {
  sessionKey?: string;
  findActiveTask: (sessionKey?: string) => Task | undefined;
  buildStatusText: TaskStatusTextBuilder<Task>;
  buildStatusDetails: (task: Task) => Record<string, unknown>;
}): MediaGenerateActionResult | undefined {
  const activeTask = params.findActiveTask(params.sessionKey);
  if (!activeTask) {
    return undefined;
  }
  return {
    content: [
      {
        text: params.buildStatusText(activeTask, { duplicateGuard: true }),
        type: "text",
      },
    ],
    details: {
      action: "status",
      duplicateGuard: true,
      ...params.buildStatusDetails(activeTask),
    },
  };
}
