import { describe, expect, it } from "vitest";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamMode,
  resolveSlackStreamingConfig,
} from "./stream-mode.js";

describe("resolveSlackStreamMode", () => {
  it("defaults to replace", () => {
    expect(resolveSlackStreamMode(undefined)).toBe("replace");
    expect(resolveSlackStreamMode("")).toBe("replace");
    expect(resolveSlackStreamMode("unknown")).toBe("replace");
  });

  it("accepts valid modes", () => {
    expect(resolveSlackStreamMode("replace")).toBe("replace");
    expect(resolveSlackStreamMode("status_final")).toBe("status_final");
    expect(resolveSlackStreamMode("append")).toBe("append");
  });
});

describe("resolveSlackStreamingConfig", () => {
  it("defaults to partial mode with native streaming enabled", () => {
    expect(resolveSlackStreamingConfig({})).toEqual({
      draftMode: "replace",
      mode: "partial",
      nativeStreaming: true,
    });
  });

  it("maps legacy streamMode values to unified streaming modes", () => {
    expect(resolveSlackStreamingConfig({ streamMode: "append" })).toMatchObject({
      draftMode: "append",
      mode: "block",
    });
    expect(resolveSlackStreamingConfig({ streamMode: "status_final" })).toMatchObject({
      draftMode: "status_final",
      mode: "progress",
    });
  });

  it("maps legacy streaming booleans to unified mode and native streaming toggle", () => {
    expect(resolveSlackStreamingConfig({ streaming: false })).toEqual({
      draftMode: "replace",
      mode: "off",
      nativeStreaming: false,
    });
    expect(resolveSlackStreamingConfig({ streaming: true })).toEqual({
      draftMode: "replace",
      mode: "partial",
      nativeStreaming: true,
    });
  });

  it("accepts unified enum values directly", () => {
    expect(resolveSlackStreamingConfig({ streaming: "off" })).toEqual({
      draftMode: "replace",
      mode: "off",
      nativeStreaming: true,
    });
    expect(resolveSlackStreamingConfig({ streaming: "progress" })).toEqual({
      draftMode: "status_final",
      mode: "progress",
      nativeStreaming: true,
    });
  });
});

describe("applyAppendOnlyStreamUpdate", () => {
  it("starts with first incoming text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello",
      rendered: "",
      source: "",
    });
    expect(next).toEqual({ changed: true, rendered: "hello", source: "hello" });
  });

  it("uses cumulative incoming text when it extends prior source", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello world",
      rendered: "hello",
      source: "hello",
    });
    expect(next).toEqual({
      changed: true,
      rendered: "hello world",
      source: "hello world",
    });
  });

  it("ignores regressive shorter incoming text", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "hello",
      rendered: "hello world",
      source: "hello world",
    });
    expect(next).toEqual({
      changed: false,
      rendered: "hello world",
      source: "hello world",
    });
  });

  it("appends non-prefix incoming chunks", () => {
    const next = applyAppendOnlyStreamUpdate({
      incoming: "next chunk",
      rendered: "hello world",
      source: "hello world",
    });
    expect(next).toEqual({
      changed: true,
      rendered: "hello world\nnext chunk",
      source: "next chunk",
    });
  });
});

describe("buildStatusFinalPreviewText", () => {
  it("cycles status dots", () => {
    expect(buildStatusFinalPreviewText(1)).toBe("Status: thinking..");
    expect(buildStatusFinalPreviewText(2)).toBe("Status: thinking...");
    expect(buildStatusFinalPreviewText(3)).toBe("Status: thinking.");
  });
});
