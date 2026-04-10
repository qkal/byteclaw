import fs from "node:fs";
import {
  readJsonFileWithFallback,
  withFileLock as withPathLock,
  writeJsonFileAtomically,
} from "../runtime-api.js";

const STORE_LOCK_OPTIONS = {
  retries: {
    factor: 2,
    maxTimeout: 10_000,
    minTimeout: 100,
    randomize: true,
    retries: 10,
  },
  stale: 30_000,
} as const;

export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  return await readJsonFileWithFallback(filePath, fallback);
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeJsonFileAtomically(filePath, value);
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

export async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  return await withPathLock(filePath, STORE_LOCK_OPTIONS, async () => await fn());
}
