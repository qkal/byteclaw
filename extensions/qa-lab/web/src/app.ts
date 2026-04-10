import { defaultQaModelForMode, isQaFastModeEnabled } from "../../model-selection.js";
import { formatErrorMessage } from "./errors.js";
import {
  type Bootstrap,
  type OutcomesEnvelope,
  type ReportEnvelope,
  type RunnerSelection,
  type Snapshot,
  type TabId,
  type UiState,
  renderQaLabUi,
} from "./ui-render.js";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function getJsonNoStore<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function defaultModelsForProviderMode(
  mode: RunnerSelection["providerMode"],
  bootstrap?: Bootstrap | null,
): Pick<RunnerSelection, "primaryModel" | "alternateModel" | "fastMode"> {
  const preferredLiveModel = bootstrap?.runnerCatalog.real[0]?.key;
  if (mode === "live-frontier") {
    const primaryModel = defaultQaModelForMode(mode, { preferredLiveModel });
    const alternateModel = defaultQaModelForMode(mode, { alternate: true, preferredLiveModel });
    return {
      alternateModel,
      fastMode: isQaFastModeEnabled({ alternateModel, primaryModel }),
      primaryModel,
    };
  }
  const primaryModel = defaultQaModelForMode(mode);
  const alternateModel = defaultQaModelForMode(mode, { alternate: true });
  return {
    alternateModel,
    fastMode: isQaFastModeEnabled({ alternateModel, primaryModel }),
    primaryModel,
  };
}

function detectTheme(): "light" | "dark" {
  const stored = localStorage.getItem("qa-lab-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export async function createQaLabApp(root: HTMLDivElement) {
  const state: UiState = {
    activeTab: "chat",
    bootstrap: null,
    busy: false,
    composer: {
      conversationId: "alice",
      conversationKind: "direct",
      senderId: "alice",
      senderName: "Alice",
      text: "",
    },
    error: null,
    latestReport: null,
    runnerDraft: null,
    runnerDraftDirty: false,
    scenarioRun: null,
    selectedConversationId: null,
    selectedScenarioId: null,
    selectedThreadId: null,
    snapshot: null,
    theme: detectTheme(),
  };

  /* Track whether user has scrolled up in the chat */
  let chatScrollLocked = true;
  let previousMessageCount = 0;

  /* ---------- Render guards (avoid DOM churn during polling) ---------- */

  let lastFingerprint = "";
  let renderDeferred = false;
  let previousRunnerStatus: string | null = null;
  let currentUiVersion: string | null = null;

  function stateFingerprint(): string {
    const msgs = state.snapshot?.messages;
    const ev = state.snapshot?.events;
    return JSON.stringify({
      cc: state.snapshot?.conversations.length ?? 0,
      cl: state.bootstrap?.runnerCatalog.real.length ?? 0,
      cs: state.bootstrap?.runnerCatalog.status,
      ec: ev?.length ?? 0,
      er: state.error,
      lc: ev && ev.length > 0 ? ev[ev.length - 1].cursor : -1,
      lm: msgs && msgs.length > 0 ? msgs[msgs.length - 1].id : null,
      mc: msgs?.length ?? 0,
      ra: state.bootstrap?.runner.startedAt,
      re: state.bootstrap?.runner.error,
      rf: state.bootstrap?.runner.finishedAt,
      rp: state.latestReport?.generatedAt,
      rs: state.bootstrap?.runner.status,
      sc: state.scenarioRun?.counts,
      so: state.scenarioRun?.scenarios.map((o) => o.status).join(","),
      ss: state.scenarioRun?.status,
      tc: state.snapshot?.threads.length ?? 0,
    });
  }

  function isSelectOpen(): boolean {
    const active = document.activeElement;
    return Boolean(active) && root.contains(active) && active.tagName === "SELECT";
  }

  /* ---------- Data fetching ---------- */

  async function refresh() {
    try {
      const [bootstrap, snapshot, report, outcomes] = await Promise.all([
        getJson<Bootstrap>("/api/bootstrap"),
        getJson<Snapshot>("/api/state"),
        getJson<ReportEnvelope>("/api/report"),
        getJson<OutcomesEnvelope>("/api/outcomes"),
      ]);
      state.bootstrap = bootstrap;
      state.snapshot = snapshot;
      state.latestReport = report.report ?? bootstrap.latestReport;
      state.scenarioRun = outcomes.run;
      if (!state.runnerDraft || !state.runnerDraftDirty) {
        state.runnerDraft = {
          ...bootstrap.runner.selection,
          scenarioIds: [...bootstrap.runner.selection.scenarioIds],
        };
        state.runnerDraftDirty = false;
      }
      if (!state.selectedConversationId) {
        state.selectedConversationId = snapshot.conversations[0]?.id ?? null;
      }
      if (!state.selectedScenarioId) {
        state.selectedScenarioId = bootstrap.scenarios[0]?.id ?? null;
      }
      if (!state.composer.conversationId) {
        state.composer = {
          ...state.composer,
          conversationId: bootstrap.defaults.conversationId,
          conversationKind: bootstrap.defaults.conversationKind,
          senderId: bootstrap.defaults.senderId,
          senderName: bootstrap.defaults.senderName,
        };
      }
      state.error = null;
    } catch (error) {
      state.error = formatErrorMessage(error);
    }

    /* Auto-switch to chat when a run starts so user can watch live */
    const currentRunnerStatus = state.bootstrap?.runner.status ?? null;
    if (currentRunnerStatus === "running" && previousRunnerStatus !== "running") {
      state.activeTab = "chat";
      chatScrollLocked = true;
    }
    previousRunnerStatus = currentRunnerStatus;

    /* Only re-render when data actually changed; defer if a <select> is open */
    const fp = stateFingerprint();
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      renderDeferred = true;
    }
    if (renderDeferred && !isSelectOpen()) {
      renderDeferred = false;
      render();
    }
  }

  async function pollUiVersion() {
    if (document.visibilityState === "hidden") {
      return;
    }
    try {
      const payload = await getJsonNoStore<{ version: string | null }>("/api/ui-version");
      if (!currentUiVersion) {
        currentUiVersion = payload.version;
        return;
      }
      if (payload.version && payload.version !== currentUiVersion) {
        window.location.reload();
      }
    } catch {
      // Ignore transient rebuild windows while the dist dir is being rewritten.
    }
  }

  /* ---------- Draft mutations ---------- */

  function updateRunnerDraft(mutator: (draft: RunnerSelection) => RunnerSelection) {
    const fallback = state.bootstrap?.runner.selection;
    if (!state.runnerDraft && fallback) {
      state.runnerDraft = { ...fallback, scenarioIds: [...fallback.scenarioIds] };
    }
    if (!state.runnerDraft) {
      return;
    }
    state.runnerDraft = mutator(state.runnerDraft);
    state.runnerDraftDirty = true;
    render();
  }

  /* ---------- Actions ---------- */

  async function runSelfCheck() {
    state.busy = true;
    state.error = null;
    render();
    try {
      const result = await postJson<{ report: string; outputPath: string }>(
        "/api/scenario/self-check",
        {},
      );
      state.latestReport = {
        generatedAt: new Date().toISOString(),
        markdown: result.report,
        outputPath: result.outputPath,
      };
      state.activeTab = "report";
      await refresh();
    } catch (error) {
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function resetState() {
    state.busy = true;
    render();
    try {
      await postJson("/api/reset", {});
      state.latestReport = null;
      state.selectedThreadId = null;
      await refresh();
    } catch (error) {
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function sendInbound() {
    const conversationId = state.composer.conversationId.trim();
    const text = state.composer.text.trim();
    if (!conversationId || !text) {
      state.error = "Conversation id and text are required.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      await postJson("/api/inbound/message", {
        conversation: {
          id: conversationId,
          kind: state.composer.conversationKind,
          ...(state.composer.conversationKind === "channel" ? { title: conversationId } : {}),
        },
        senderId: state.composer.senderId.trim() || "alice",
        senderName: state.composer.senderName.trim() || undefined,
        text,
        ...(state.selectedThreadId ? { threadId: state.selectedThreadId } : {}),
      });
      state.selectedConversationId = conversationId;
      state.composer.text = "";
      chatScrollLocked = true;
      await refresh();
    } catch (error) {
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runSuite() {
    if (!state.runnerDraft) {
      state.error = "Runner selection not ready yet.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      const result = await postJson<{ runner: { selection: RunnerSelection } }>(
        "/api/scenario/suite",
        {
          alternateModel: state.runnerDraft.alternateModel,
          primaryModel: state.runnerDraft.primaryModel,
          providerMode: state.runnerDraft.providerMode,
          scenarioIds: state.runnerDraft.scenarioIds,
        },
      );
      state.runnerDraft = {
        ...result.runner.selection,
        scenarioIds: [...result.runner.selection.scenarioIds],
      };
      state.runnerDraftDirty = false;
      state.activeTab = "chat";
      await refresh();
    } catch (error) {
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function sendKickoff() {
    state.busy = true;
    state.error = null;
    render();
    try {
      await postJson("/api/kickoff", {});
      state.activeTab = "chat";
      chatScrollLocked = true;
      await refresh();
    } catch (error) {
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  function downloadReport() {
    if (!state.latestReport?.markdown) {
      return;
    }
    const blob = new Blob([state.latestReport.markdown], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "qa-report.md";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("qa-lab-theme", state.theme);
    render();
  }

  /* ---------- Chat scroll tracking ---------- */

  function trackChatScroll() {
    const el = root.querySelector<HTMLElement>("#chat-messages");
    if (!el) {
      return;
    }
    el.addEventListener("scroll", () => {
      const threshold = 40;
      chatScrollLocked = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    });
  }

  function scrollChatToBottom(force?: boolean) {
    const el = root.querySelector<HTMLElement>("#chat-messages");
    if (!el) {
      return;
    }
    const newCount = state.snapshot?.messages.length ?? 0;
    if (force || (chatScrollLocked && newCount !== previousMessageCount)) {
      el.scrollTop = el.scrollHeight;
    }
    previousMessageCount = newCount;
  }

  /* ---------- Event binding ---------- */

  function bindEvents() {
    /* Tabs */
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((node) => {
      node.addEventListener("click", () => {
        const nextTab = node.dataset.tab as TabId | undefined;
        if (nextTab) {
          state.activeTab = nextTab;
          render();
        }
      });
    });

    /* Conversation chips */
    root.querySelectorAll<HTMLElement>("[data-conversation-id]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedConversationId = node.dataset.conversationId ?? null;
        state.selectedThreadId = null;
        if (state.activeTab !== "chat") {
          state.activeTab = "chat";
        }
        render();
      });
    });

    /* Thread chips */
    root.querySelectorAll<HTMLElement>("[data-thread-select]").forEach((node) => {
      node.addEventListener("click", () => {
        const val = node.dataset.threadSelect;
        if (val === "root") {
          state.selectedThreadId = null;
        } else {
          state.selectedThreadId = val ?? null;
          const conv = node.dataset.threadConv;
          if (conv) {
            state.selectedConversationId = conv;
          }
        }
        render();
      });
    });

    /* Scenario selection (results tab + sidebar) */
    root.querySelectorAll<HTMLElement>("[data-scenario-id]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedScenarioId = node.dataset.scenarioId ?? null;
        if (state.activeTab !== "results") {
          state.activeTab = "results";
        }
        render();
      });
    });

    /* Header / sidebar buttons */
    root
      .querySelector<HTMLElement>("[data-action='refresh']")
      ?.addEventListener("click", () => void refresh());
    root
      .querySelector<HTMLElement>("[data-action='reset']")
      ?.addEventListener("click", () => void resetState());
    root
      .querySelector<HTMLElement>("[data-action='toggle-theme']")
      ?.addEventListener("click", toggleTheme);
    root
      .querySelector<HTMLElement>("[data-action='self-check']")
      ?.addEventListener("click", () => void runSelfCheck());
    root
      .querySelector<HTMLElement>("[data-action='run-suite']")
      ?.addEventListener("click", () => void runSuite());
    root
      .querySelector<HTMLElement>("[data-action='kickoff']")
      ?.addEventListener("click", () => void sendKickoff());
    root
      .querySelector<HTMLElement>("[data-action='send']")
      ?.addEventListener("click", () => void sendInbound());
    root
      .querySelector<HTMLElement>("[data-action='download-report']")
      ?.addEventListener("click", downloadReport);

    /* Scenario All/None */
    root
      .querySelector<HTMLElement>("[data-action='select-all-scenarios']")
      ?.addEventListener("click", () => {
        updateRunnerDraft((d) => ({
          ...d,
          scenarioIds: state.bootstrap?.scenarios.map((s) => s.id) ?? d.scenarioIds,
        }));
      });
    root
      .querySelector<HTMLElement>("[data-action='clear-scenarios']")
      ?.addEventListener("click", () => {
        updateRunnerDraft((d) => ({ ...d, scenarioIds: [] }));
      });

    /* Scenario toggles */
    root.querySelectorAll<HTMLInputElement>("[data-scenario-toggle-id]").forEach((node) => {
      node.addEventListener("change", () => {
        const scenarioId = node.dataset.scenarioToggleId;
        if (!scenarioId) {
          return;
        }
        updateRunnerDraft((draft) => {
          const selected = new Set(draft.scenarioIds);
          if (node.checked) {
            selected.add(scenarioId);
          } else {
            selected.delete(scenarioId);
          }
          const orderedIds = state.bootstrap?.scenarios
            .map((s) => s.id)
            .filter((id) => selected.has(id)) ?? [...selected];
          return { ...draft, scenarioIds: orderedIds };
        });
      });
    });

    /* Config form */
    root.querySelector<HTMLSelectElement>("#provider-mode")?.addEventListener("change", (e) => {
      const mode =
        (e.currentTarget as HTMLSelectElement).value === "live-frontier"
          ? "live-frontier"
          : "mock-openai";
      updateRunnerDraft((d) => ({
        ...d,
        providerMode: mode,
        ...defaultModelsForProviderMode(mode, state.bootstrap),
      }));
    });
    root.querySelector<HTMLSelectElement>("#primary-model")?.addEventListener("change", (e) => {
      const primaryModel = (e.currentTarget as HTMLSelectElement).value;
      updateRunnerDraft((d) => ({
        ...d,
        fastMode: isQaFastModeEnabled({ alternateModel: d.alternateModel, primaryModel }),
        primaryModel,
      }));
    });
    root.querySelector<HTMLSelectElement>("#alternate-model")?.addEventListener("change", (e) => {
      const alternateModel = (e.currentTarget as HTMLSelectElement).value;
      updateRunnerDraft((d) => ({
        ...d,
        alternateModel,
        fastMode: isQaFastModeEnabled({ alternateModel, primaryModel: d.primaryModel }),
      }));
    });

    /* Composer form */
    root.querySelector<HTMLSelectElement>("#conversation-kind")?.addEventListener("change", (e) => {
      state.composer.conversationKind =
        (e.currentTarget as HTMLSelectElement).value === "channel" ? "channel" : "direct";
    });
    root.querySelector<HTMLInputElement>("#conversation-id")?.addEventListener("input", (e) => {
      state.composer.conversationId = (e.currentTarget as HTMLInputElement).value;
    });
    root.querySelector<HTMLInputElement>("#sender-id")?.addEventListener("input", (e) => {
      state.composer.senderId = (e.currentTarget as HTMLInputElement).value;
    });
    root.querySelector<HTMLInputElement>("#sender-name")?.addEventListener("input", (e) => {
      state.composer.senderName = (e.currentTarget as HTMLInputElement).value;
    });

    /* Composer textarea: capture input + Enter-to-send */
    const textarea = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (textarea) {
      textarea.addEventListener("input", (e) => {
        state.composer.text = (e.currentTarget as HTMLTextAreaElement).value;
        /* Auto-grow */
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      });
      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void sendInbound();
        }
      });
    }

    /* Chat scroll tracking */
    trackChatScroll();
  }

  /* ---------- Render ---------- */

  function render() {
    /* Preserve focused element id so we can restore focus after re-render */
    const focusedId = (document.activeElement as HTMLElement)?.id || null;
    const composerText = state.composer.text;

    root.innerHTML = renderQaLabUi(state);
    bindEvents();

    /* Restore composer text (since we re-rendered) */
    const textEl = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (textEl && composerText) {
      textEl.value = composerText;
      textEl.style.height = "auto";
      textEl.style.height = `${Math.min(textEl.scrollHeight, 120)}px`;
    }

    /* Restore focus */
    if (focusedId) {
      const el = root.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`);
      if (el && "focus" in el) {
        el.focus();
      }
    }

    /* Auto-scroll chat */
    requestAnimationFrame(() => scrollChatToBottom());
  }

  /* ---------- Bootstrap ---------- */

  render();
  await refresh();
  void pollUiVersion();
  setInterval(() => void refresh(), 1000);
  setInterval(() => void pollUiVersion(), 1000);
}
