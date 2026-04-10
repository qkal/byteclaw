import { beforeEach, describe, expect, it } from "vitest";
import "./accounts.test-mocks.js";
import { listZalouserDirectoryGroupMembers } from "./directory.js";
import "./zalo-js.test-mocks.js";
import { listZaloGroupMembersMock } from "./zalo-js.test-mocks.js";

describe("zalouser directory group members", () => {
  beforeEach(() => {
    listZaloGroupMembersMock.mockClear();
  });

  it("accepts prefixed group ids from directory groups list output", async () => {
    await listZalouserDirectoryGroupMembers(
      {
        accountId: "default",
        cfg: {},
        groupId: "group:1471383327500481391",
      },
      {
        listZaloGroupMembers: async (profile, groupId) =>
          await listZaloGroupMembersMock(profile, groupId),
      },
    );

    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith("default", "1471383327500481391");
  });

  it("keeps backward compatibility for raw group ids", async () => {
    await listZalouserDirectoryGroupMembers(
      {
        accountId: "default",
        cfg: {},
        groupId: "1471383327500481391",
      },
      {
        listZaloGroupMembers: async (profile, groupId) =>
          await listZaloGroupMembersMock(profile, groupId),
      },
    );

    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith("default", "1471383327500481391");
  });

  it("accepts provider-native g- group ids without stripping the prefix", async () => {
    await listZalouserDirectoryGroupMembers(
      {
        accountId: "default",
        cfg: {},
        groupId: "g-1471383327500481391",
      },
      {
        listZaloGroupMembers: async (profile, groupId) =>
          await listZaloGroupMembersMock(profile, groupId),
      },
    );

    expect(listZaloGroupMembersMock).toHaveBeenLastCalledWith("default", "g-1471383327500481391");
  });
});
