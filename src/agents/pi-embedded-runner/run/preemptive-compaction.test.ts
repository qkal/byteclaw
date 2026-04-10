import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  estimatePrePromptTokens,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

let timestamp = 1;

function makeAssistantHistory(text: string): AgentMessage {
  return {
    content: [{ text, type: "text" }],
    role: "assistant",
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeToolResultMessage(...texts: string[]): AgentMessage {
  return {
    content: texts.map((text) => ({ text, type: "text" })),
    isError: false,
    role: "toolResult",
    timestamp: timestamp++,
    toolCallId: `call_${timestamp}`,
    toolName: "read",
  } as AgentMessage;
}

describe("preemptive-compaction", () => {
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      prompt: "hello",
      systemPrompt: "sys",
    });
    const larger = estimatePrePromptTokens({
      messages: [makeAssistantHistory(verboseHistory)],
      prompt: verbosePrompt,
      systemPrompt: verboseSystem,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      contextTokenBudget: 500,
      messages: [makeAssistantHistory(verboseHistory)],
      prompt: verbosePrompt,
      reserveTokens: 50,
      systemPrompt: verboseSystem,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      contextTokenBudget: 10_000,
      messages: [makeAssistantHistory("short history")],
      prompt: "hello",
      reserveTokens: 1000,
      systemPrompt: "sys",
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(medium, medium, medium, medium),
    ];
    const reserveTokens = 2000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      prompt: "hello",
      systemPrompt: "sys",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      messages,
      prompt: "hello",
      reserveTokens,
      systemPrompt: "sys",
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(220);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      makeAssistantHistory(longHistory),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 500;
    const result = shouldPreemptivelyCompactBeforePrompt({
      contextTokenBudget: 12_000,
      messages,
      prompt: verbosePrompt,
      reserveTokens,
      systemPrompt: verboseSystem,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("treats mixed oversized-plus-aggregate tool tails as cumulative recovery potential", () => {
    const oversized = "x".repeat(45_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(oversized),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 2000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      prompt: "hello",
      systemPrompt: "sys",
    });
    const potential = estimateToolResultReductionPotential({
      contextWindowTokens: 128_000,
      messages,
    });
    const desiredOverflowTokens = 2000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      messages,
      prompt: "hello",
      reserveTokens,
      systemPrompt: "sys",
    });

    expect(potential.oversizedReducibleChars).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.oversizedReducibleChars).toBeLessThan(desiredOverflowTokens * 4);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });
});
