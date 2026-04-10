import { type Mock, vi } from "vitest";

type ZaloJsModule = typeof import("./zalo-js.js");
interface ZaloJsMocks {
  checkZaloAuthenticatedMock: Mock<ZaloJsModule["checkZaloAuthenticated"]>;
  getZaloUserInfoMock: Mock<ZaloJsModule["getZaloUserInfo"]>;
  listZaloFriendsMock: Mock<ZaloJsModule["listZaloFriends"]>;
  listZaloFriendsMatchingMock: Mock<ZaloJsModule["listZaloFriendsMatching"]>;
  listZaloGroupMembersMock: Mock<ZaloJsModule["listZaloGroupMembers"]>;
  listZaloGroupsMock: Mock<ZaloJsModule["listZaloGroups"]>;
  listZaloGroupsMatchingMock: Mock<ZaloJsModule["listZaloGroupsMatching"]>;
  logoutZaloProfileMock: Mock<ZaloJsModule["logoutZaloProfile"]>;
  resolveZaloAllowFromEntriesMock: Mock<ZaloJsModule["resolveZaloAllowFromEntries"]>;
  resolveZaloGroupContextMock: Mock<ZaloJsModule["resolveZaloGroupContext"]>;
  resolveZaloGroupsByEntriesMock: Mock<ZaloJsModule["resolveZaloGroupsByEntries"]>;
  startZaloListenerMock: Mock<ZaloJsModule["startZaloListener"]>;
  startZaloQrLoginMock: Mock<ZaloJsModule["startZaloQrLogin"]>;
  waitForZaloQrLoginMock: Mock<ZaloJsModule["waitForZaloQrLogin"]>;
}

const zaloJsMocks = vi.hoisted(
  (): ZaloJsMocks => ({
    checkZaloAuthenticatedMock: vi.fn(async () => false),
    getZaloUserInfoMock: vi.fn(async () => null),
    listZaloFriendsMatchingMock: vi.fn(async () => []),
    listZaloFriendsMock: vi.fn(async () => []),
    listZaloGroupMembersMock: vi.fn(async () => []),
    listZaloGroupsMatchingMock: vi.fn(async () => []),
    listZaloGroupsMock: vi.fn(async () => []),
    logoutZaloProfileMock: vi.fn(async () => ({
      cleared: true,
      loggedOut: true,
      message: "Logged out and cleared local session.",
    })),
    resolveZaloAllowFromEntriesMock: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ id: entry, input: entry, note: undefined, resolved: true })),
    ),
    resolveZaloGroupContextMock: vi.fn(async (_profile, groupId) => ({
      groupId,
      members: [],
      name: undefined,
    })),
    resolveZaloGroupsByEntriesMock: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ id: entry, input: entry, note: undefined, resolved: true })),
    ),
    startZaloListenerMock: vi.fn(async () => ({ stop: vi.fn() })),
    startZaloQrLoginMock: vi.fn(async () => ({
      message: "qr pending",
      qrDataUrl: undefined,
    })),
    waitForZaloQrLoginMock: vi.fn(async () => ({
      connected: false,
      message: "login pending",
    })),
  }),
);

export const {checkZaloAuthenticatedMock} = zaloJsMocks;
export const {getZaloUserInfoMock} = zaloJsMocks;
export const {listZaloFriendsMock} = zaloJsMocks;
export const {listZaloFriendsMatchingMock} = zaloJsMocks;
export const {listZaloGroupMembersMock} = zaloJsMocks;
export const {listZaloGroupsMock} = zaloJsMocks;
export const {listZaloGroupsMatchingMock} = zaloJsMocks;
export const {logoutZaloProfileMock} = zaloJsMocks;
export const {resolveZaloAllowFromEntriesMock} = zaloJsMocks;
export const {resolveZaloGroupContextMock} = zaloJsMocks;
export const {resolveZaloGroupsByEntriesMock} = zaloJsMocks;
export const {startZaloListenerMock} = zaloJsMocks;
export const {startZaloQrLoginMock} = zaloJsMocks;
export const {waitForZaloQrLoginMock} = zaloJsMocks;

vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: checkZaloAuthenticatedMock,
  getZaloUserInfo: getZaloUserInfoMock,
  listZaloFriends: listZaloFriendsMock,
  listZaloFriendsMatching: listZaloFriendsMatchingMock,
  listZaloGroupMembers: listZaloGroupMembersMock,
  listZaloGroups: listZaloGroupsMock,
  listZaloGroupsMatching: listZaloGroupsMatchingMock,
  logoutZaloProfile: logoutZaloProfileMock,
  resolveZaloAllowFromEntries: resolveZaloAllowFromEntriesMock,
  resolveZaloGroupContext: resolveZaloGroupContextMock,
  resolveZaloGroupsByEntries: resolveZaloGroupsByEntriesMock,
  startZaloListener: startZaloListenerMock,
  startZaloQrLogin: startZaloQrLoginMock,
  waitForZaloQrLogin: waitForZaloQrLoginMock,
}));
