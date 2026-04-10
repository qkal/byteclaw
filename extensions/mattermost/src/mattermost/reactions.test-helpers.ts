import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { MattermostFetch } from "./client.js";

export function createMattermostTestConfig(): OpenClawConfig {
  return {
    channels: {
      mattermost: {
        baseUrl: "https://chat.example.com",
        botToken: "test-token",
        enabled: true,
      },
    },
  };
}

export function createMattermostReactionFetchMock(params: {
  postId: string;
  emojiName: string;
  mode: "add" | "remove" | "both";
  userId?: string;
  status?: number;
  body?: unknown;
}) {
  const userId = params.userId ?? "BOT123";
  const {mode} = params;
  const allowAdd = mode === "add" || mode === "both";
  const allowRemove = mode === "remove" || mode === "both";
  const addStatus = params.status ?? 201;
  const removeStatus = params.status ?? 204;
  const removePath = `/api/v4/users/${userId}/posts/${params.postId}/reactions/${encodeURIComponent(params.emojiName)}`;

  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/api/v4/users/me")) {
      return new Response(JSON.stringify({ id: userId }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    if (allowAdd && String(url).endsWith("/api/v4/reactions")) {
      expect(init?.method).toBe("POST");
      const requestBody = init?.body;
      if (typeof requestBody !== "string") {
        throw new Error("expected string POST body");
      }
      expect(JSON.parse(requestBody)).toEqual({
        emoji_name: params.emojiName,
        post_id: params.postId,
        user_id: userId,
      });

      const responseBody = params.body === undefined ? { ok: true } : params.body;
      return new Response(
        responseBody === null ? null : JSON.stringify(responseBody),
        responseBody === null
          ? { headers: { "content-type": "text/plain" }, status: addStatus }
          : { headers: { "content-type": "application/json" }, status: addStatus },
      );
    }

    if (allowRemove && String(url).endsWith(removePath)) {
      expect(init?.method).toBe("DELETE");
      const responseBody = params.body === undefined ? null : params.body;
      return new Response(
        responseBody === null ? null : JSON.stringify(responseBody),
        responseBody === null
          ? { headers: { "content-type": "text/plain" }, status: removeStatus }
          : { headers: { "content-type": "application/json" }, status: removeStatus },
      );
    }

    throw new Error(`unexpected url: ${String(url)}`);
  });
}

export async function withMockedGlobalFetch<T>(
  fetchImpl: MattermostFetch,
  run: () => Promise<T>,
): Promise<T> {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = prevFetch;
  }
}
