export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";

export interface AgentMediaPayload {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
}

/** Convert outbound media descriptors into the legacy agent payload field layout. */
export function buildAgentMediaPayload(
  mediaList: { path: string; contentType?: string | null }[],
): AgentMediaPayload {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaType: first?.contentType ?? undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    MediaUrl: first?.path,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
  };
}
