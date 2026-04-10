import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { MatrixClient } from "./sdk.js";

export const MATRIX_PROFILE_AVATAR_MAX_BYTES = 10 * 1024 * 1024;

type MatrixProfileClient = Pick<
  MatrixClient,
  "getUserProfile" | "setDisplayName" | "setAvatarUrl" | "uploadContent"
>;

interface MatrixProfileLoadResult {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}

export interface MatrixProfileSyncResult {
  skipped: boolean;
  displayNameUpdated: boolean;
  avatarUpdated: boolean;
  resolvedAvatarUrl: string | null;
  uploadedAvatarSource: "http" | "path" | null;
  convertedAvatarFromHttp: boolean;
}

export function isMatrixMxcUri(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(normalizeOptionalString(value)).startsWith("mxc://");
}

export function isMatrixHttpAvatarUri(value: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(normalizeOptionalString(value));
  return normalized.startsWith("https://") || normalized.startsWith("http://");
}

export function isSupportedMatrixAvatarSource(value: string): boolean {
  return isMatrixMxcUri(value) || isMatrixHttpAvatarUri(value);
}

async function uploadAvatarMedia(params: {
  client: MatrixProfileClient;
  avatarSource: string;
  avatarMaxBytes: number;
  loadAvatar: (source: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
}): Promise<string> {
  const media = await params.loadAvatar(params.avatarSource, params.avatarMaxBytes);
  return await params.client.uploadContent(
    media.buffer,
    media.contentType,
    media.fileName || "avatar",
  );
}

async function resolveAvatarUrl(params: {
  client: MatrixProfileClient;
  avatarUrl: string | null;
  avatarPath?: string | null;
  avatarMaxBytes: number;
  loadAvatarFromUrl?: (url: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
  loadAvatarFromPath?: (path: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
}): Promise<{
  resolvedAvatarUrl: string | null;
  uploadedAvatarSource: "http" | "path" | null;
  convertedAvatarFromHttp: boolean;
}> {
  const avatarPath = normalizeOptionalString(params.avatarPath) ?? null;
  if (avatarPath) {
    if (!params.loadAvatarFromPath) {
      throw new Error("Matrix avatar path upload requires a media loader.");
    }
    return {
      convertedAvatarFromHttp: false,
      resolvedAvatarUrl: await uploadAvatarMedia({
        avatarMaxBytes: params.avatarMaxBytes,
        avatarSource: avatarPath,
        client: params.client,
        loadAvatar: params.loadAvatarFromPath,
      }),
      uploadedAvatarSource: "path",
    };
  }

  const avatarUrl = normalizeOptionalString(params.avatarUrl) ?? null;
  if (!avatarUrl) {
    return {
      convertedAvatarFromHttp: false,
      resolvedAvatarUrl: null,
      uploadedAvatarSource: null,
    };
  }

  if (isMatrixMxcUri(avatarUrl)) {
    return {
      convertedAvatarFromHttp: false,
      resolvedAvatarUrl: avatarUrl,
      uploadedAvatarSource: null,
    };
  }

  if (!isMatrixHttpAvatarUri(avatarUrl)) {
    throw new Error("Matrix avatar URL must be an mxc:// URI or an http(s) URL.");
  }

  if (!params.loadAvatarFromUrl) {
    throw new Error("Matrix avatar URL conversion requires a media loader.");
  }

  return {
    convertedAvatarFromHttp: true,
    resolvedAvatarUrl: await uploadAvatarMedia({
      avatarMaxBytes: params.avatarMaxBytes,
      avatarSource: avatarUrl,
      client: params.client,
      loadAvatar: params.loadAvatarFromUrl,
    }),
    uploadedAvatarSource: "http",
  };
}

export async function syncMatrixOwnProfile(params: {
  client: MatrixProfileClient;
  userId: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  avatarPath?: string | null;
  avatarMaxBytes?: number;
  loadAvatarFromUrl?: (url: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
  loadAvatarFromPath?: (path: string, maxBytes: number) => Promise<MatrixProfileLoadResult>;
}): Promise<MatrixProfileSyncResult> {
  const desiredDisplayName = normalizeOptionalString(params.displayName) ?? null;
  const avatar = await resolveAvatarUrl({
    avatarMaxBytes: params.avatarMaxBytes ?? MATRIX_PROFILE_AVATAR_MAX_BYTES,
    avatarPath: params.avatarPath ?? null,
    avatarUrl: params.avatarUrl ?? null,
    client: params.client,
    loadAvatarFromPath: params.loadAvatarFromPath,
    loadAvatarFromUrl: params.loadAvatarFromUrl,
  });
  const desiredAvatarUrl = avatar.resolvedAvatarUrl;

  if (!desiredDisplayName && !desiredAvatarUrl) {
    return {
      avatarUpdated: false,
      convertedAvatarFromHttp: avatar.convertedAvatarFromHttp,
      displayNameUpdated: false,
      resolvedAvatarUrl: null,
      skipped: true,
      uploadedAvatarSource: avatar.uploadedAvatarSource,
    };
  }

  let currentDisplayName: string | undefined;
  let currentAvatarUrl: string | undefined;
  try {
    const currentProfile = await params.client.getUserProfile(params.userId);
    currentDisplayName = normalizeOptionalString(currentProfile.displayname);
    currentAvatarUrl = normalizeOptionalString(currentProfile.avatar_url);
  } catch {
    // If profile fetch fails, attempt writes directly.
  }

  let displayNameUpdated = false;
  let avatarUpdated = false;

  if (desiredDisplayName && currentDisplayName !== desiredDisplayName) {
    await params.client.setDisplayName(desiredDisplayName);
    displayNameUpdated = true;
  }
  if (desiredAvatarUrl && currentAvatarUrl !== desiredAvatarUrl) {
    await params.client.setAvatarUrl(desiredAvatarUrl);
    avatarUpdated = true;
  }

  return {
    avatarUpdated,
    convertedAvatarFromHttp: avatar.convertedAvatarFromHttp,
    displayNameUpdated,
    resolvedAvatarUrl: desiredAvatarUrl,
    skipped: false,
    uploadedAvatarSource: avatar.uploadedAvatarSource,
  };
}
