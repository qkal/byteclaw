import crypto from "node:crypto";
import { isRecord, readNestedString } from "./attachments/shared.js";
import { resolveMSTeamsStorePath } from "./storage.js";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

export interface MSTeamsPollVote {
  pollId: string;
  selections: string[];
}

export interface MSTeamsPoll {
  id: string;
  question: string;
  options: string[];
  maxSelections: number;
  createdAt: string;
  updatedAt?: string;
  conversationId?: string;
  messageId?: string;
  votes: Record<string, string[]>;
}

export interface MSTeamsPollStore {
  createPoll: (poll: MSTeamsPoll) => Promise<void>;
  getPoll: (pollId: string) => Promise<MSTeamsPoll | null>;
  recordVote: (params: {
    pollId: string;
    voterId: string;
    selections: string[];
  }) => Promise<MSTeamsPoll | null>;
}

export interface MSTeamsPollCard {
  pollId: string;
  question: string;
  options: string[];
  maxSelections: number;
  card: Record<string, unknown>;
  fallbackText: string;
}

interface PollStoreData {
  version: 1;
  polls: Record<string, MSTeamsPoll>;
}

const STORE_FILENAME = "msteams-polls.json";
const MAX_POLLS = 1000;
const POLL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeChoiceValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function extractSelections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(normalizeChoiceValue).filter((entry): entry is string => Boolean(entry));
  }
  const normalized = normalizeChoiceValue(value);
  if (!normalized) {
    return [];
  }
  if (normalized.includes(",")) {
    return normalized
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [normalized];
}

function readNestedValue(value: unknown, keys: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key as keyof typeof current];
  }
  return current;
}

export function extractMSTeamsPollVote(
  activity: { value?: unknown } | undefined,
): MSTeamsPollVote | null {
  const value = activity?.value;
  if (!value || !isRecord(value)) {
    return null;
  }
  const pollId =
    readNestedString(value, ["openclawPollId"]) ??
    readNestedString(value, ["pollId"]) ??
    readNestedString(value, ["openclaw", "pollId"]) ??
    readNestedString(value, ["openclaw", "poll", "id"]) ??
    readNestedString(value, ["data", "openclawPollId"]) ??
    readNestedString(value, ["data", "pollId"]) ??
    readNestedString(value, ["data", "openclaw", "pollId"]);
  if (!pollId) {
    return null;
  }

  const directSelections = extractSelections(value.choices);
  const nestedSelections = extractSelections(readNestedValue(value, ["choices"]));
  const dataSelections = extractSelections(readNestedValue(value, ["data", "choices"]));
  const selections =
    directSelections.length > 0
      ? directSelections
      : nestedSelections.length > 0
        ? nestedSelections
        : dataSelections;

  if (selections.length === 0) {
    return null;
  }

  return {
    pollId,
    selections,
  };
}

export function buildMSTeamsPollCard(params: {
  question: string;
  options: string[];
  maxSelections?: number;
  pollId?: string;
}): MSTeamsPollCard {
  const pollId = params.pollId ?? crypto.randomUUID();
  const maxSelections =
    typeof params.maxSelections === "number" && params.maxSelections > 1
      ? Math.floor(params.maxSelections)
      : 1;
  const cappedMaxSelections = Math.min(Math.max(1, maxSelections), params.options.length);
  const choices = params.options.map((option, index) => ({
    title: option,
    value: String(index),
  }));
  const hint =
    cappedMaxSelections > 1
      ? `Select up to ${cappedMaxSelections} option${cappedMaxSelections === 1 ? "" : "s"}.`
      : "Select one option.";

  const card = {
    actions: [
      {
        data: {
          openclawPollId: pollId,
          pollId,
        },
        msteams: {
          displayText: "Vote recorded",
          text: "openclaw poll vote",
          type: "messageBack",
          value: { openclawPollId: pollId, pollId },
        },
        title: "Vote",
        type: "Action.Submit",
      },
    ],
    body: [
      {
        size: "Medium",
        text: params.question,
        type: "TextBlock",
        weight: "Bolder",
        wrap: true,
      },
      {
        choices,
        id: "choices",
        isMultiSelect: cappedMaxSelections > 1,
        style: "expanded",
        type: "Input.ChoiceSet",
      },
      {
        isSubtle: true,
        spacing: "Small",
        text: hint,
        type: "TextBlock",
        wrap: true,
      },
    ],
    type: "AdaptiveCard",
    version: "1.5",
  };

  const fallbackLines = [
    `Poll: ${params.question}`,
    ...params.options.map((option, index) => `${index + 1}. ${option}`),
  ];

  return {
    card,
    fallbackText: fallbackLines.join("\n"),
    maxSelections: cappedMaxSelections,
    options: params.options,
    pollId,
    question: params.question,
  };
}

export interface MSTeamsPollStoreFsOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
}

function parseTimestamp(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pruneExpired(polls: Record<string, MSTeamsPoll>) {
  const cutoff = Date.now() - POLL_TTL_MS;
  const entries = Object.entries(polls).filter(([, poll]) => {
    const ts = parseTimestamp(poll.updatedAt ?? poll.createdAt) ?? 0;
    return ts >= cutoff;
  });
  return Object.fromEntries(entries);
}

function pruneToLimit(polls: Record<string, MSTeamsPoll>) {
  const entries = Object.entries(polls);
  if (entries.length <= MAX_POLLS) {
    return polls;
  }
  entries.sort((a, b) => {
    const aTs = parseTimestamp(a[1].updatedAt ?? a[1].createdAt) ?? 0;
    const bTs = parseTimestamp(b[1].updatedAt ?? b[1].createdAt) ?? 0;
    return aTs - bTs;
  });
  const keep = entries.slice(entries.length - MAX_POLLS);
  return Object.fromEntries(keep);
}

export function normalizeMSTeamsPollSelections(poll: MSTeamsPoll, selections: string[]) {
  const maxSelections = Math.max(1, poll.maxSelections);
  const mapped = selections
    .map((entry) => Number.parseInt(entry, 10))
    .filter((value) => Number.isFinite(value))
    .filter((value) => value >= 0 && value < poll.options.length)
    .map((value) => String(value));
  const limited = maxSelections > 1 ? mapped.slice(0, maxSelections) : mapped.slice(0, 1);
  return [...new Set(limited)];
}

export function createMSTeamsPollStoreFs(params?: MSTeamsPollStoreFsOptions): MSTeamsPollStore {
  const filePath = resolveMSTeamsStorePath({
    env: params?.env,
    filename: STORE_FILENAME,
    homedir: params?.homedir,
    stateDir: params?.stateDir,
    storePath: params?.storePath,
  });
  const empty: PollStoreData = { polls: {}, version: 1 };

  const readStore = async (): Promise<PollStoreData> => {
    const { value } = await readJsonFile(filePath, empty);
    const pruned = pruneToLimit(pruneExpired(value.polls ?? {}));
    return { polls: pruned, version: 1 };
  };

  const writeStore = async (data: PollStoreData) => {
    await writeJsonFile(filePath, data);
  };

  const createPoll = async (poll: MSTeamsPoll) => {
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      data.polls[poll.id] = poll;
      await writeStore({ polls: pruneToLimit(data.polls), version: 1 });
    });
  };

  const getPoll = async (pollId: string) =>
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      return data.polls[pollId] ?? null;
    });

  const recordVote = async (params: { pollId: string; voterId: string; selections: string[] }) =>
    await withFileLock(filePath, empty, async () => {
      const data = await readStore();
      const poll = data.polls[params.pollId];
      if (!poll) {
        return null;
      }
      const normalized = normalizeMSTeamsPollSelections(poll, params.selections);
      poll.votes[params.voterId] = normalized;
      poll.updatedAt = new Date().toISOString();
      data.polls[poll.id] = poll;
      await writeStore({ polls: pruneToLimit(data.polls), version: 1 });
      return poll;
    });

  return { createPoll, getPoll, recordVote };
}
