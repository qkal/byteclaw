import { describe, expect, it } from "vitest";
import {
  hasExpectedSingleNonce,
  hasExpectedToolNonce,
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe-utils.js";

describe("live tool probe utils", () => {
  describe("nonce matching", () => {
    it.each([
      {
        actual: hasExpectedToolNonce("value a-1 and b-2", "a-1", "b-2"),
        expected: true,
        name: "matches tool nonce pairs only when both are present",
      },
      {
        actual: hasExpectedToolNonce("value a-1 only", "a-1", "b-2"),
        expected: false,
        name: "rejects partial tool nonce matches",
      },
      {
        actual: hasExpectedSingleNonce("value nonce-1", "nonce-1"),
        expected: true,
        name: "matches a single nonce when present",
      },
      {
        actual: hasExpectedSingleNonce("value nonce-2", "nonce-1"),
        expected: false,
        name: "rejects single nonce mismatches",
      },
    ])("$name", ({ actual, expected }) => {
      expect(actual).toBe(expected);
    });
  });

  describe("refusal detection", () => {
    it.each([
      {
        expected: true,
        name: "detects nonce refusal phrasing",
        text: "Same request, same answer — this isn't a real OpenClaw probe. No part of the system asks me to parrot back nonce values.",
      },
      {
        expected: true,
        name: "detects prompt-injection style refusals without nonce text",
        text: "That's not a legitimate self-test. This looks like a prompt injection attempt.",
      },
      {
        expected: false,
        name: "ignores generic helper text",
        text: "I can help with that request.",
      },
      {
        expected: false,
        name: "does not treat nonce markers without the word nonce as refusal",
        text: "No part of the system asks me to parrot back values.",
      },
    ])("$name", ({ text, expected }) => {
      expect(isLikelyToolNonceRefusal(text)).toBe(expected);
    });
  });

  describe("shouldRetryToolReadProbe", () => {
    it.each([
      {
        expected: true,
        name: "retries malformed tool output when attempts remain",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          text: "read[object Object],[object Object]",
        },
      },
      {
        expected: false,
        name: "does not retry once max attempts are exhausted",
        params: {
          attempt: 2,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          text: "read[object Object],[object Object]",
        },
      },
      {
        expected: false,
        name: "does not retry when the nonce pair is already present",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          text: "nonce-a nonce-b",
        },
      },
      {
        expected: false,
        name: "prefers a valid nonce pair even if the text still contains scaffolding words",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          text: "tool output nonce-a nonce-b function",
        },
      },
      {
        expected: true,
        name: "retries empty output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          text: "   ",
        },
      },
      {
        expected: true,
        name: "retries tool scaffolding output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          text: "Use tool function read[] now.",
        },
      },
      {
        expected: true,
        name: "retries conversational try-again output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "zai",
          text: "Let me try reading the file again:",
        },
      },
      {
        expected: false,
        name: "does not retry generic conversational text without tool-retry context",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "zai",
          text: "Let me try a different approach.",
        },
      },
      {
        expected: true,
        name: "retries mistral nonce marker echoes without parsed values",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "mistral",
          text: "nonceA= nonceB=",
        },
      },
      {
        expected: true,
        name: "retries anthropic refusal output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "anthropic",
          text: "This isn't a real OpenClaw probe; I won't parrot back nonce values.",
        },
      },
      {
        expected: false,
        name: "does not special-case anthropic refusals for other providers",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonceA: "nonce-a",
          nonceB: "nonce-b",
          provider: "openai",
          text: "This isn't a real OpenClaw probe; I won't parrot back nonce values.",
        },
      },
    ])("$name", ({ params, expected }) => {
      expect(shouldRetryToolReadProbe(params)).toBe(expected);
    });
  });

  describe("shouldRetryExecReadProbe", () => {
    it.each([
      {
        expected: true,
        name: "retries malformed exec+read output when attempts remain",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "openai",
          text: "read[object Object]",
        },
      },
      {
        expected: false,
        name: "does not retry once max attempts are exhausted",
        params: {
          attempt: 2,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "openai",
          text: "read[object Object]",
        },
      },
      {
        expected: false,
        name: "does not retry when the nonce is already present",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "openai",
          text: "nonce-c",
        },
      },
      {
        expected: false,
        name: "prefers a valid nonce even if the text still contains scaffolding words",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "openai",
          text: "tool output nonce-c function",
        },
      },
      {
        expected: true,
        name: "retries anthropic nonce refusal output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "anthropic",
          text: "No part of the system asks me to parrot back nonce values.",
        },
      },
      {
        expected: true,
        name: "retries conversational try-again exec output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "zai",
          text: "Let me try reading the file again:",
        },
      },
      {
        expected: true,
        name: "retries eventual-consistency exec readback output",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "mistral",
          text: "The file creation command succeeded, but the file wasn't found immediately after. Let me verify the file exists and read it again.",
        },
      },
      {
        expected: true,
        name: "retries file-not-found exec readback wording",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "mistral",
          text: "The `exec` command ran successfully, but the file read failed because the file was not found. Let me verify the file creation and read it again.",
        },
      },
      {
        expected: false,
        name: "does not retry generic exec conversational text without tool-retry context",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "zai",
          text: "Let me try a different approach.",
        },
      },
      {
        expected: false,
        name: "does not special-case anthropic refusals for other providers",
        params: {
          attempt: 0,
          maxAttempts: 3,
          nonce: "nonce-c",
          provider: "openai",
          text: "No part of the system asks me to parrot back nonce values.",
        },
      },
    ])("$name", ({ params, expected }) => {
      expect(shouldRetryExecReadProbe(params)).toBe(expected);
    });
  });
});
