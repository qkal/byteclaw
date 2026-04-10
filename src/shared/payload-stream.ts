import { Readable } from "node:stream";

export interface StreamPayloadOptions {
  chunkSize?: number;
  maxBufferSize?: number;
  maxChunkSize?: number;
  validateChunk?: (chunk: Buffer) => boolean;
  onProgress?: (progress: { bytesProcessed: number; totalBytes: number }) => void;
  encoding?: BufferEncoding;
}

export interface StreamStats {
  bytesProcessed: number;
  totalBytes: number;
  chunksProduced: number;
}

class PayloadSizeLimitError extends Error {
  constructor(
    public readonly actualSize: number,
    public readonly maxSize: number,
  ) {
    super(`Payload exceeds maximum buffer size of ${maxSize} bytes (actual: ${actualSize} bytes)`);
    this.name = "PayloadSizeLimitError";
  }
}

class ChunkValidationError extends Error {
  constructor(public readonly chunkIndex: number) {
    super(`Chunk validation failed at index ${chunkIndex}`);
    this.name = "ChunkValidationError";
  }
}

/**
 * Stream large payloads efficiently without loading entire content into memory.
 * Production-grade implementation with validation, progress tracking, and error handling.
 */
export async function* streamPayload(
  source: Readable | string | Buffer | Uint8Array,
  options: StreamPayloadOptions = {},
): AsyncGenerator<Buffer, StreamStats, unknown> {
  const chunkSize = Math.min(options.chunkSize ?? 64 * 1024, options.maxChunkSize ?? 1024 * 1024);
  const maxBufferSize = options.maxBufferSize ?? 10 * 1024 * 1024;
  const encoding = options.encoding ?? "utf8";
  const validateChunk = options.validateChunk ?? (() => true);
  const onProgress = options.onProgress;

  let bytesProcessed = 0;
  let totalBytes = 0;
  let chunksProduced = 0;
  let chunkIndex = 0;

  const emitProgress = () => {
    if (onProgress) {
      onProgress({ bytesProcessed, totalBytes });
    }
  };

  try {
    if (typeof source === "string") {
      const buffer = Buffer.from(source, encoding);
      totalBytes = buffer.length;
      for (const chunk of streamBuffer(buffer, chunkSize)) {
        if (!validateChunk(chunk)) {
          throw new ChunkValidationError(chunkIndex);
        }
        bytesProcessed += chunk.length;
        chunksProduced++;
        chunkIndex++;
        emitProgress();
        yield chunk;
      }
      return { bytesProcessed, totalBytes, chunksProduced };
    }

    if (Buffer.isBuffer(source)) {
      totalBytes = source.length;
      for (const chunk of streamBuffer(source, chunkSize)) {
        if (!validateChunk(chunk)) {
          throw new ChunkValidationError(chunkIndex);
        }
        bytesProcessed += chunk.length;
        chunksProduced++;
        chunkIndex++;
        emitProgress();
        yield chunk;
      }
      return { bytesProcessed, totalBytes, chunksProduced };
    }

    if (source instanceof Uint8Array) {
      const buffer = Buffer.from(source);
      totalBytes = buffer.length;
      for (const chunk of streamBuffer(buffer, chunkSize)) {
        if (!validateChunk(chunk)) {
          throw new ChunkValidationError(chunkIndex);
        }
        bytesProcessed += chunk.length;
        chunksProduced++;
        chunkIndex++;
        emitProgress();
        yield chunk;
      }
      return { bytesProcessed, totalBytes, chunksProduced };
    }

    // Stream from Readable with backpressure handling
    let buffer = Buffer.alloc(0);

    for await (const chunk of source) {
      if (chunk === null) {
        break;
      }
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      buffer = Buffer.concat([buffer, chunkBuffer]);
      totalBytes += chunkBuffer.length;

      if (totalBytes > maxBufferSize) {
        throw new PayloadSizeLimitError(totalBytes, maxBufferSize);
      }

      while (buffer.length >= chunkSize) {
        const outputChunk = buffer.subarray(0, chunkSize);
        if (!validateChunk(outputChunk)) {
          throw new ChunkValidationError(chunkIndex);
        }
        bytesProcessed += outputChunk.length;
        chunksProduced++;
        chunkIndex++;
        buffer = buffer.subarray(chunkSize);
        emitProgress();
        yield outputChunk;
      }
    }

    // Yield remaining buffer
    if (buffer.length > 0) {
      if (!validateChunk(buffer)) {
        throw new ChunkValidationError(chunkIndex);
      }
      bytesProcessed += buffer.length;
      chunksProduced++;
      emitProgress();
      yield buffer;
    }

    return { bytesProcessed, totalBytes, chunksProduced };
  } catch (error) {
    if (error instanceof PayloadSizeLimitError || error instanceof ChunkValidationError) {
      throw error;
    }
    throw new Error(
      `Failed to stream payload: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function* streamBuffer(buffer: Buffer, chunkSize: number): Generator<Buffer, void, unknown> {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
  }
}

/**
 * Collect a streamed payload into a single buffer with size limits and validation.
 */
export async function collectStream(
  stream: AsyncIterable<Buffer>,
  maxSize: number = 10 * 1024 * 1024,
  validateChunk?: (chunk: Buffer) => boolean,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const validate = validateChunk ?? (() => true);

  for await (const chunk of stream) {
    if (!validate(chunk)) {
      throw new Error("Chunk validation failed during collection");
    }
    totalSize += chunk.length;
    if (totalSize > maxSize) {
      throw new PayloadSizeLimitError(totalSize, maxSize);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Create a transform stream that enforces size limits and validation.
 */
export function createSizeLimitTransform(
  maxSize: number,
  validateChunk?: (chunk: Buffer) => boolean,
): TransformStream<Buffer, Buffer> {
  let totalSize = 0;
  const validate = validateChunk ?? (() => true);

  return new TransformStream({
    transform(chunk, controller) {
      if (!validate(chunk)) {
        controller.error(new Error("Chunk validation failed"));
        return;
      }
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        controller.error(new PayloadSizeLimitError(totalSize, maxSize));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export { PayloadSizeLimitError, ChunkValidationError };
