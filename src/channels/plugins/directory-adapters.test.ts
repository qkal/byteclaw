import { describe, expect, it } from "vitest";
import {
  createChannelDirectoryAdapter,
  createEmptyChannelDirectoryAdapter,
  emptyChannelDirectoryList,
  nullChannelDirectorySelf,
} from "./directory-adapters.js";

describe("directory adapters", () => {
  it("defaults self to null", async () => {
    const adapter = createChannelDirectoryAdapter();
    await expect(adapter.self?.({ cfg: {}, runtime: {} as never })).resolves.toBeNull();
  });

  it("preserves provided resolvers", async () => {
    const adapter = createChannelDirectoryAdapter({
      listPeers: async () => [{ id: "u-1", kind: "user" }],
    });
    await expect(adapter.listPeers?.({ cfg: {}, runtime: {} as never })).resolves.toEqual([
      { id: "u-1", kind: "user" },
    ]);
  });

  it("builds empty directory adapters", async () => {
    const adapter = createEmptyChannelDirectoryAdapter();
    await expect(adapter.self?.({ cfg: {}, runtime: {} as never })).resolves.toBeNull();
    await expect(adapter.listPeers?.({ cfg: {}, runtime: {} as never })).resolves.toEqual([]);
    await expect(adapter.listGroups?.({ cfg: {}, runtime: {} as never })).resolves.toEqual([]);
  });

  it("exports standalone null/empty helpers", async () => {
    await expect(nullChannelDirectorySelf({ cfg: {}, runtime: {} as never })).resolves.toBeNull();
    await expect(emptyChannelDirectoryList({ cfg: {}, runtime: {} as never })).resolves.toEqual([]);
  });
});
