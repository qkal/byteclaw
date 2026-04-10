import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { type MemoryIndexManager, getMemorySearchManager } from "./index.js";

export async function createMemoryManagerOrThrow(
  cfg: OpenClawConfig,
  agentId = "main",
): Promise<MemoryIndexManager> {
  const result = await getMemorySearchManager({ agentId, cfg });
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager as unknown as MemoryIndexManager;
}
