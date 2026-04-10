import { getMatrixRuntime } from "../../runtime.js";
import { type MatrixProfileSyncResult, syncMatrixOwnProfile } from "../profile.js";
import { withResolvedActionClient } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

export async function updateMatrixOwnProfile(
  opts: MatrixActionClientOpts & {
    displayName?: string;
    avatarUrl?: string;
    avatarPath?: string;
  } = {},
): Promise<MatrixProfileSyncResult> {
  const displayName = opts.displayName?.trim();
  const avatarUrl = opts.avatarUrl?.trim();
  const avatarPath = opts.avatarPath?.trim();
  const runtime = getMatrixRuntime();
  return await withResolvedActionClient(
    opts,
    async (client) => {
      const userId = await client.getUserId();
      return await syncMatrixOwnProfile({
        avatarPath: avatarPath || undefined,
        avatarUrl: avatarUrl || undefined,
        client,
        displayName: displayName || undefined,
        loadAvatarFromPath: async (path, maxBytes) =>
          await runtime.media.loadWebMedia(path, {
            localRoots: opts.mediaLocalRoots,
            maxBytes,
          }),
        loadAvatarFromUrl: async (url, maxBytes) => await runtime.media.loadWebMedia(url, maxBytes),
        userId,
      });
    },
    "persist",
  );
}
