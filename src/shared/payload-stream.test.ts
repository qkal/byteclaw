import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { collectStream, createSizeLimitTransform, streamPayload } from "./payload-stream.js";

describe("payload-stream", () => {
  describe("streamPayload", () => {
    it("streams string payloads", async () => {
      const input = "Hello, World!";
      const chunks: Buffer[] = [];
      for await (const chunk of streamPayload(input, { chunkSize: 5 })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const result = Buffer.concat(chunks).toString();
      expect(result).toBe(input);
    });

    it("streams buffer payloads", async () => {
      const input = Buffer.from("Hello, World!");
      const chunks: Buffer[] = [];
      for await (const chunk of streamPayload(input, { chunkSize: 5 })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const result = Buffer.concat(chunks);
      expect(result.equals(input)).toBe(true);
    });

    it("streams from Readable", async () => {
      const input = "Hello, World!";
      const readable = Readable.from([input]);
      const chunks: Buffer[] = [];
      for await (const chunk of streamPayload(readable, { chunkSize: 5 })) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const result = Buffer.concat(chunks).toString();
      expect(result).toBe(input);
    });

    it("enforces max buffer size", async () => {
      const input = "x".repeat(1000);
      await expect(streamPayload(input, { maxBufferSize: 500 }).next()).rejects.toThrow(
        "exceeds maximum buffer size",
      );
    });
  });

  describe("collectStream", () => {
    it("collects streamed chunks", async () => {
      async function* generateChunks() {
        yield Buffer.from("Hello");
        yield Buffer.from(", ");
        yield Buffer.from("World");
        yield Buffer.from("!");
      }
      const result = await collectStream(generateChunks());
      expect(result.toString()).toBe("Hello, World!");
    });

    it("enforces maximum size", async () => {
      async function* generateLargeChunks() {
        yield Buffer.alloc(1000);
      }
      await expect(collectStream(generateLargeChunks(), 500)).rejects.toThrow(
        "exceeds maximum size",
      );
    });
  });

  describe("createSizeLimitTransform", () => {
    it("allows streams within limit", async () => {
      const transform = createSizeLimitTransform(1000);
      const writable = new WritableStream<Buffer>({
        write(chunk) {},
      });
      const readable = new ReadableStream<Buffer>({
        start(controller) {
          controller.enqueue(Buffer.alloc(500));
          controller.enqueue(Buffer.alloc(400));
          controller.close();
        },
      });

      await readable.pipeThrough(transform).pipeTo(writable);
    });

    it("rejects streams exceeding limit", async () => {
      const transform = createSizeLimitTransform(1000);
      const readable = new ReadableStream<Buffer>({
        start(controller) {
          controller.enqueue(Buffer.alloc(600));
          controller.enqueue(Buffer.alloc(500));
          controller.close();
        },
      });

      await expect(readable.pipeThrough(transform).pipeTo(new WritableStream())).rejects.toThrow(
        "exceeds maximum size",
      );
    });
  });
});
