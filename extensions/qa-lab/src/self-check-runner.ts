import { startQaLabServer } from "./lab-server.js";

export async function runQaLabSelfCheck(params?: { repoRoot?: string; outputPath?: string }) {
  const server = await startQaLabServer({
    outputPath: params?.outputPath,
    repoRoot: params?.repoRoot,
  });
  try {
    return await server.runSelfCheck();
  } finally {
    await server.stop();
  }
}

export const runQaE2eSelfCheck = runQaLabSelfCheck;
