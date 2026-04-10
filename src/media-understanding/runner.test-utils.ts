import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvAsync } from "../test-utils/env.js";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";

interface MediaFixtureParams {
  ctx: { MediaPath: string; MediaType: string };
  media: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
}

export async function withMediaFixture(
  params: {
    filePrefix: string;
    extension: string;
    mediaType: string;
    fileContents: Buffer;
  },
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  const tmpPath = path.join(
    os.tmpdir(),
    `${params.filePrefix}-${Date.now().toString()}.${params.extension}`,
  );
  await fs.writeFile(tmpPath, params.fileContents);
  const ctx = { MediaPath: tmpPath, MediaType: params.mediaType };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    includeDefaultLocalPathRoots: false,
    localPathRoots: [path.dirname(tmpPath)],
  });

  try {
    await withEnvAsync({ PATH: "" }, async () => {
      await run({ cache, ctx, media });
    });
  } finally {
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export async function withAudioFixture(
  filePrefix: string,
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  await withMediaFixture(
    {
      extension: "wav",
      fileContents: createSafeAudioFixtureBuffer(2048, 0x52),
      filePrefix,
      mediaType: "audio/wav",
    },
    run,
  );
}

export function createSafeAudioFixtureBuffer(size?: number, fill = 0xAB): Buffer {
  const minSafeSize = MIN_AUDIO_FILE_BYTES + 1;
  const finalSize = Math.max(size ?? minSafeSize, minSafeSize);
  return Buffer.alloc(finalSize, fill);
}

export async function withVideoFixture(
  filePrefix: string,
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  await withMediaFixture(
    {
      extension: "mp4",
      fileContents: Buffer.from("video"),
      filePrefix,
      mediaType: "video/mp4",
    },
    run,
  );
}
