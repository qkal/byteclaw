import { beforeEach, describe, expect, it } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  enqueueFollowupRun,
  resetRecentQueuedMessageIdDedupe,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createDeferred,
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

describe("followup queue deduplication", () => {
  beforeEach(() => {
    resetRecentQueuedMessageIdDedupe();
  });

  it("deduplicates messages with same Discord message_id", async () => {
    const key = `test-dedup-message-id-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 1;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
        prompt: "[Discord Guild #test channel id:123] Hello",
      }),
      settings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
        prompt: "[Discord Guild #test channel id:123] Hello (dupe)",
      }),
      settings,
    );
    expect(second).toBe(false);

    const third = enqueueFollowupRun(
      key,
      createRun({
        messageId: "m2",
        originatingChannel: "discord",
        originatingTo: "channel:123",
        prompt: "[Discord Guild #test channel id:123] World",
      }),
      settings,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
  });

  it("deduplicates same message_id after queue drain restarts", async () => {
    const key = `test-dedup-after-drain-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
        prompt: "first",
      }),
      settings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const redelivery = enqueueFollowupRun(
      key,
      createRun({
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
        prompt: "first-redelivery",
      }),
      settings,
    );

    expect(redelivery).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("deduplicates same message_id across distinct enqueue module instances", async () => {
    const enqueueA = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-b",
    );
    const { clearSessionQueues } = await import("./queue.js");
    const key = `test-dedup-cross-module-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    enqueueA.resetRecentQueuedMessageIdDedupe();
    enqueueB.resetRecentQueuedMessageIdDedupe();

    try {
      expect(
        enqueueA.enqueueFollowupRun(
          key,
          createRun({
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
            prompt: "first",
          }),
          settings,
        ),
      ).toBe(true);

      scheduleFollowupDrain(key, runFollowup);
      await done.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(
        enqueueB.enqueueFollowupRun(
          key,
          createRun({
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
            prompt: "first-redelivery",
          }),
          settings,
        ),
      ).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      clearSessionQueues([key]);
      enqueueA.resetRecentQueuedMessageIdDedupe();
      enqueueB.resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not collide recent message-id keys when routing contains delimiters", async () => {
    const key = `test-dedup-key-collision-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        messageId: "same-id",
        originatingChannel: "signal|group",
        originatingTo: "peer",
        prompt: "first",
      }),
      settings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const second = enqueueFollowupRun(
      key,
      createRun({
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "group|peer",
        prompt: "second",
      }),
      settings,
    );
    expect(second).toBe(true);
  });

  it("deduplicates exact prompt when routing matches and no message id", async () => {
    const key = `test-dedup-whatsapp-${Date.now()}`;
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
        prompt: "Hello world",
      }),
      settings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
        prompt: "Hello world",
      }),
      settings,
    );
    expect(second).toBe(true);

    const third = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
        prompt: "Hello world 2",
      }),
      settings,
    );
    expect(third).toBe(true);
  });

  it("does not deduplicate across different providers without message id", async () => {
    const key = `test-dedup-cross-provider-${Date.now()}`;
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
        prompt: "Same text",
      }),
      settings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "discord",
        originatingTo: "channel:123",
        prompt: "Same text",
      }),
      settings,
    );
    expect(second).toBe(true);
  });

  it("can opt-in to prompt-based dedupe when message id is absent", async () => {
    const key = `test-dedup-prompt-mode-${Date.now()}`;
    const settings: QueueSettings = {
      cap: 50,
      debounceMs: 0,
      dropPolicy: "summarize",
      mode: "collect",
    };

    const first = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
        prompt: "Hello world",
      }),
      settings,
      "prompt",
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
        prompt: "Hello world",
      }),
      settings,
      "prompt",
    );
    expect(second).toBe(false);
  });
});
