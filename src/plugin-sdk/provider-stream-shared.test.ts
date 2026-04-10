import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createHtmlEntityToolCallArgumentDecodingWrapper,
  decodeHtmlEntitiesInObject,
} from "./provider-stream-shared.js";

interface FakeWrappedStream {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

describe("decodeHtmlEntitiesInObject", () => {
  it("recursively decodes string values", () => {
    expect(
      decodeHtmlEntitiesInObject({
        args: ["&lt;input&gt;", "&#x27;quoted&#x27;"],
        command: "cd ~/dev &amp;&amp; echo &quot;ok&quot;",
      }),
    ).toEqual({
      args: ["<input>", "'quoted'"],
      command: 'cd ~/dev && echo "ok"',
    });
  });
});

describe("createHtmlEntityToolCallArgumentDecodingWrapper", () => {
  it("decodes tool call arguments in final and streaming messages", async () => {
    const resultMessage = {
      content: [
        {
          arguments: { command: "echo &quot;result&quot; &amp;&amp; true" },
          type: "toolCall",
        },
      ],
    };
    const streamEvent = {
      partial: {
        content: [
          {
            arguments: { nested: { quote: "&#39;x&#39;" }, path: "&lt;stream&gt;" },
            type: "toolCall",
          },
        ],
      },
    };
    const baseStreamFn: StreamFn = () =>
      createFakeStream({ events: [streamEvent], resultMessage }) as never;

    const stream = createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn)(
      {} as never,
      {} as never,
      {},
    ) as FakeWrappedStream;

    await expect(stream.result()).resolves.toEqual({
      content: [
        {
          arguments: { command: 'echo "result" && true' },
          type: "toolCall",
        },
      ],
    });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        partial: {
          content: [
            {
              arguments: { nested: { quote: "'x'" }, path: "<stream>" },
              type: "toolCall",
            },
          ],
        },
      },
    });
  });
});
