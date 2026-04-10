import { describe, expect, it } from "vitest";
import {
  createInspectedDirectoryEntriesLister,
  createResolvedDirectoryEntriesLister,
  listDirectoryEntriesFromSources,
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryUserEntriesFromAllowFrom,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
  listInspectedDirectoryEntriesFromSources,
  listResolvedDirectoryEntriesFromSources,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
} from "./directory-config-helpers.js";

function expectUserDirectoryEntries(entries: unknown) {
  expect(entries).toEqual([
    { id: "alice", kind: "user" },
    { id: "carla", kind: "user" },
  ]);
}

describe("listDirectoryUserEntriesFromAllowFrom", () => {
  it("normalizes, deduplicates, filters, and limits user ids", () => {
    const entries = listDirectoryUserEntriesFromAllowFrom({
      allowFrom: ["", "*", "  user:Alice ", "user:alice", "user:Bob", "user:Carla"],
      limit: 2,
      normalizeId: (entry) => entry.replace(/^user:/i, "").toLowerCase(),
      query: "a",
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listDirectoryGroupEntriesFromMapKeys", () => {
  it("extracts normalized group ids from map keys", () => {
    const entries = listDirectoryGroupEntriesFromMapKeys({
      groups: {
        " Space/A ": {},
        "*": {},
        "space/b": {},
      },
      normalizeId: (entry) => entry.toLowerCase().replace(/\s+/g, ""),
    });

    expect(entries).toEqual([
      { id: "space/a", kind: "group" },
      { id: "space/b", kind: "group" },
    ]);
  });
});

describe("listDirectoryUserEntriesFromAllowFromAndMapKeys", () => {
  it("merges allowFrom and map keys with dedupe/query/limit", () => {
    const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
      allowFrom: ["user:alice", "user:bob"],
      limit: 2,
      map: {
        "user:alice": {},
        "user:carla": {},
      },
      normalizeAllowFromId: (entry) => entry.replace(/^user:/i, ""),
      normalizeMapKeyId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listDirectoryGroupEntriesFromMapKeysAndAllowFrom", () => {
  it("merges groups keys and group allowFrom entries", () => {
    const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
      allowFrom: ["team/b", "team/a"],
      groups: {
        "team/a": {},
      },
      query: "team/",
    });

    expect(entries).toEqual([
      { id: "team/a", kind: "group" },
      { id: "team/b", kind: "group" },
    ]);
  });
});

describe("listDirectoryEntriesFromSources", () => {
  it("merges source iterables with dedupe/query/limit", () => {
    const entries = listDirectoryEntriesFromSources({
      kind: "user",
      limit: 2,
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      sources: [
        ["user:alice", "user:bob"],
        ["user:carla", "user:alice"],
      ],
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listInspectedDirectoryEntriesFromSources", () => {
  it("returns empty when the inspected account is missing", () => {
    const entries = listInspectedDirectoryEntriesFromSources({
      cfg: {} as never,
      inspectAccount: () => null,
      kind: "user",
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      resolveSources: () => [["user:alice"]],
    });

    expect(entries).toEqual([]);
  });

  it("lists entries from inspected account sources", () => {
    const entries = listInspectedDirectoryEntriesFromSources({
      cfg: {} as never,
      inspectAccount: () => ({ ids: [["room:a"], ["room:b", "room:a"]] }),
      kind: "group",
      normalizeId: (entry) => entry.replace(/^room:/i, ""),
      query: "a",
      resolveSources: (account) => account.ids,
    });

    expect(entries).toEqual([{ id: "a", kind: "group" }]);
  });
});

describe("createInspectedDirectoryEntriesLister", () => {
  it("builds a reusable inspected-account lister", async () => {
    const listGroups = createInspectedDirectoryEntriesLister({
      inspectAccount: () => ({ ids: [["room:a"], ["room:b", "room:a"]] }),
      kind: "group",
      normalizeId: (entry) => entry.replace(/^room:/i, ""),
      resolveSources: (account) => account.ids,
    });

    await expect(listGroups({ cfg: {} as never, query: "a" })).resolves.toEqual([
      { id: "a", kind: "group" },
    ]);
  });
});

describe("resolved account directory helpers", () => {
  const cfg = {} as never;
  const resolveAccount = () => ({
    allowFrom: ["user:alice", "user:bob"],
    groups: { "room:a": {}, "room:b": {} },
  });

  it("lists user entries from resolved account allowFrom", () => {
    const entries = listResolvedDirectoryUserEntriesFromAllowFrom({
      cfg,
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      resolveAccount,
      resolveAllowFrom: (account) => account.allowFrom,
    });

    expect(entries).toEqual([{ id: "alice", kind: "user" }]);
  });

  it("lists group entries from resolved account map keys", () => {
    const entries = listResolvedDirectoryGroupEntriesFromMapKeys({
      cfg,
      normalizeId: (entry) => entry.replace(/^room:/i, ""),
      resolveAccount,
      resolveGroups: (account) => account.groups,
    });

    expect(entries).toEqual([
      { id: "a", kind: "group" },
      { id: "b", kind: "group" },
    ]);
  });

  it("lists entries from resolved account sources", () => {
    const entries = listResolvedDirectoryEntriesFromSources({
      cfg,
      kind: "user",
      limit: 2,
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      resolveAccount,
      resolveSources: (account) => [account.allowFrom, ["user:carla", "user:alice"]],
    });

    expectUserDirectoryEntries(entries);
  });

  it("builds a reusable resolved-account lister", async () => {
    const listUsers = createResolvedDirectoryEntriesLister({
      kind: "user",
      normalizeId: (entry) => entry.replace(/^user:/i, ""),
      resolveAccount,
      resolveSources: (account) => [account.allowFrom, ["user:carla", "user:alice"]],
    });

    await expect(listUsers({ cfg, limit: 2, query: "a" })).resolves.toEqual([
      { id: "alice", kind: "user" },
      { id: "carla", kind: "user" },
    ]);
  });
});
