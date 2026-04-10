export interface MediaPayloadInput {
  path: string;
  contentType?: string;
}

export interface MediaPayload {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
}

export function buildMediaPayload(
  mediaList: MediaPayloadInput[],
  opts?: { preserveMediaTypeCardinality?: boolean },
): MediaPayload {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const rawMediaTypes = mediaList.map((media) => media.contentType ?? "");
  const mediaTypes = opts?.preserveMediaTypeCardinality
    ? rawMediaTypes
    : rawMediaTypes.filter((value): value is string => Boolean(value));
  return {
    MediaPath: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaType: first?.contentType,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
    MediaUrl: first?.path,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
  };
}
