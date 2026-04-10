import { Readable } from "node:stream";

export interface StreamPayloadOptions {
  chunkSize?: number;
  maxBufferSize?: number;
}

/**
 * Stream large payloads efficiently without loading entire content into memory.
 * Useful for large file uploads, streaming responses, and bulk data processing.
 */
export async function* streamPayload(
  source: Readable | string | Buffer | Uint8Array,
  options: StreamPayloadOptions = {},
): AsyncGenerator<Buffer, void, unknown> {
  const chunkSize = options.chunkSize ?? 64 * 1024; // 64KB default
  const maxBufferSize = options.maxBufferSize ?? 10 * 1024 * 1024; // 10MB default

  if (typeof source === "string") {
    const buffer = Buffer.from(source, "utf8");
    yield* streamBuffer(buffer, chunkSize);
    return;
  }

  if (Buffer.isBuffer(source)) {
    yield* streamBuffer(source, chunkSize);
    return;
  }

  if (source instanceof Uint8Array) {
    yield* streamBuffer(Buffer.from(source), chunkSize);
    return;
  }

  // Stream from Readable
  let buffer = Buffer.alloc(0);
  let totalSize = 0;

  for await (const chunk of source) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, chunkBuffer]);
    totalSize += chunkBuffer.length;

    if (totalSize > maxBufferSize) {
      throw new Error(`Payload exceeds maximum buffer size of ${maxBufferSize} bytes`);
    }

    while (buffer.length >= chunkSize) {
      yield buffer.subarray(0, chunkSize);
      buffer = buffer.subarray(chunkSize);
    }
  }

  // Yield remaining buffer
  if (buffer.length > 0) {
    yield buffer;
  }
}

function* streamBuffer(buffer: Buffer, chunkSize: number): Generator<Buffer, void, unknown> {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
  }
}

/**
 * Collect a streamed payload into a single buffer with size limits.
 */
export async function collectStream(
  stream: AsyncIterable<Buffer>,
  maxSize: number = 10 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of stream) {
    totalSize += chunk.length;
    if (totalSize > maxSize) {
      throw new Error(`Stream exceeds maximum size of ${maxSize} bytes`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Create a transform stream that enforces size limits.
 */
export function createSizeLimitTransform(maxSize: number): TransformStream<Buffer, Buffer> {
  let totalSize = 0;

  return new TransformStream({
    transform(chunk, controller) {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        controller.error(new Error(`Stream exceeds maximum size of ${maxSize} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
