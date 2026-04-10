import { beforeEach, describe, expect, it } from "vitest";
import {
  addMattermostReaction,
  removeMattermostReaction,
  resetMattermostReactionBotUserCacheForTests,
} from "./reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
} from "./reactions.test-helpers.js";

describe("mattermost reactions", () => {
  beforeEach(() => {
    resetMattermostReactionBotUserCacheForTests();
  });

  async function addReactionWithFetch(fetchMock: typeof fetch) {
    return addMattermostReaction({
      cfg: createMattermostTestConfig(),
      emojiName: "thumbsup",
      fetchImpl: fetchMock,
      postId: "POST1",
    });
  }

  async function removeReactionWithFetch(fetchMock: typeof fetch) {
    return removeMattermostReaction({
      cfg: createMattermostTestConfig(),
      emojiName: "thumbsup",
      fetchImpl: fetchMock,
      postId: "POST1",
    });
  }

  it("adds reactions by calling /users/me then POST /reactions", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      emojiName: "thumbsup",
      mode: "add",
      postId: "POST1",
    });

    const result = await addReactionWithFetch(fetchMock);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns a Result error when add reaction API call fails", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      body: { id: "err", message: "boom" },
      emojiName: "thumbsup",
      mode: "add",
      postId: "POST1",
      status: 500,
    });

    const result = await addReactionWithFetch(fetchMock);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mattermost add reaction failed");
    }
  });

  it("removes reactions by calling /users/me then DELETE /users/:id/posts/:postId/reactions/:emoji", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      emojiName: "thumbsup",
      mode: "remove",
      postId: "POST1",
    });

    const result = await removeReactionWithFetch(fetchMock);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("caches the bot user id across reaction mutations", async () => {
    const fetchMock = createMattermostReactionFetchMock({
      emojiName: "thumbsup",
      mode: "both",
      postId: "POST1",
    });

    const cfg = createMattermostTestConfig();
    const addResult = await addMattermostReaction({
      cfg,
      emojiName: "thumbsup",
      fetchImpl: fetchMock,
      postId: "POST1",
    });
    const removeResult = await removeMattermostReaction({
      cfg,
      emojiName: "thumbsup",
      fetchImpl: fetchMock,
      postId: "POST1",
    });

    const usersMeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/api/v4/users/me"),
    );
    expect(addResult).toEqual({ ok: true });
    expect(removeResult).toEqual({ ok: true });
    expect(usersMeCalls).toHaveLength(1);
  });
});
