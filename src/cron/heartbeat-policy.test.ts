import { describe, expect, it } from "vitest";
import {
  shouldEnqueueCronMainSummary,
  shouldSkipHeartbeatOnlyDelivery,
} from "./heartbeat-policy.js";

describe("shouldSkipHeartbeatOnlyDelivery", () => {
  it("suppresses empty payloads", () => {
    expect(shouldSkipHeartbeatOnlyDelivery([], 300)).toBe(true);
  });

  it("suppresses when any payload is a heartbeat ack and no media is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "Checked inbox and calendar." }, { text: "HEARTBEAT_OK" }],
        300,
      ),
    ).toBe(true);
  });

  it("does not suppress when media is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ mediaUrl: "https://example.com/image.png", text: "HEARTBEAT_OK" }],
        300,
      ),
    ).toBe(false);
  });
});

describe("shouldEnqueueCronMainSummary", () => {
  const isSystemEvent = (text: string) => text.includes("HEARTBEAT_OK");

  it("enqueues only when delivery was requested but did not run", () => {
    expect(
      shouldEnqueueCronMainSummary({
        delivered: false,
        deliveryAttempted: false,
        deliveryRequested: true,
        isCronSystemEvent: isSystemEvent,
        summaryText: "HEARTBEAT_OK",
        suppressMainSummary: false,
      }),
    ).toBe(true);
  });

  it("does not enqueue after attempted outbound delivery", () => {
    expect(
      shouldEnqueueCronMainSummary({
        delivered: false,
        deliveryAttempted: true,
        deliveryRequested: true,
        isCronSystemEvent: isSystemEvent,
        summaryText: "HEARTBEAT_OK",
        suppressMainSummary: false,
      }),
    ).toBe(false);
  });
});
