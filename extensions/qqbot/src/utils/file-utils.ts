import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

/** Maximum file size accepted by the QQ Bot API. */
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;

/** Threshold used to treat an upload as a large file. */
export const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

const QQBOT_MEDIA_HOSTNAME_ALLOWLIST = [
  "*.myqcloud.com",
  "*.qpic.cn",
  "*.qq.com",
  "*.tencentcos.com",
];

export const QQBOT_MEDIA_SSRF_POLICY: SsrFPolicy = {
  allowRfc2544BenchmarkRange: true,
  hostnameAllowlist: QQBOT_MEDIA_HOSTNAME_ALLOWLIST,
};

/** Result of local file-size validation. */
export interface FileSizeCheckResult {
  ok: boolean;
  size: number;
  error?: string;
}

/** Validate that a file is within the allowed upload size. */
export function checkFileSize(filePath: string, maxSize = MAX_UPLOAD_SIZE): FileSizeCheckResult {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      const limitMB = (maxSize / (1024 * 1024)).toFixed(0);
      return {
        error: `File is too large (${sizeMB}MB); QQ Bot API limit is ${limitMB}MB`,
        ok: false,
        size: stat.size,
      };
    }
    return { ok: true, size: stat.size };
  } catch (error) {
    return {
      error: `Failed to read file metadata: ${formatErrorMessage(error)}`,
      ok: false,
      size: 0,
    };
  }
}

/** Read file contents asynchronously. */
export async function readFileAsync(filePath: string): Promise<Buffer> {
  return fs.promises.readFile(filePath);
}

/** Check file readability asynchronously. */
export async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Get file size asynchronously. */
export async function getFileSizeAsync(filePath: string): Promise<number> {
  const stat = await fs.promises.stat(filePath);
  return stat.size;
}

/** Return true when a file should be treated as large. */
export function isLargeFile(sizeBytes: number): boolean {
  return sizeBytes >= LARGE_FILE_THRESHOLD;
}

/** Format a byte count into a human-readable size string. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Infer a MIME type from the file extension. */
export function getMimeType(filePath: string): string {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  const mimeTypes: Record<string, string> = {
    ".avi": "video/x-msvideo",
    ".bmp": "image/bmp",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".gz": "application/gzip",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".tar": "application/x-tar",
    ".txt": "text/plain",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}

/** Download a remote file into a local directory. */
export async function downloadFile(
  url: string,
  destDir: string,
  originalFilename?: string,
): Promise<string | null> {
  try {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return null;
    }
    if (parsedUrl.protocol !== "https:") {
      return null;
    }

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const fetched = await fetchRemoteMedia({
      filePathHint: originalFilename,
      ssrfPolicy: QQBOT_MEDIA_SSRF_POLICY,
      url: parsedUrl.toString(),
    });

    let filename = normalizeOptionalString(originalFilename) ?? "";
    if (!filename) {
      filename =
        (normalizeOptionalString(fetched.fileName) ?? path.basename(parsedUrl.pathname)) ||
        "download";
    }

    const ts = Date.now();
    const ext = path.extname(filename);
    const base = path.basename(filename, ext) || "file";
    const rand = crypto.randomBytes(3).toString("hex");
    const safeFilename = `${base}_${ts}_${rand}${ext}`;

    const destPath = path.join(destDir, safeFilename);
    await fs.promises.writeFile(destPath, fetched.buffer);
    return destPath;
  } catch {
    return null;
  }
}
