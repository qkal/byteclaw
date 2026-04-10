import { resolveZalouserAccountSync } from "./accounts.js";
import type { ChannelDirectoryEntry, OpenClawConfig } from "./channel-api.js";
import { parseZalouserDirectoryGroupId } from "./session-route.js";

interface ZalouserDirectoryDeps {
  listZaloGroupMembers: (
    profile: string,
    groupId: string,
  ) => Promise<
    {
      userId: string;
      displayName?: string | null;
      avatar?: string | null;
    }[]
  >;
}

function mapUser(params: {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  raw?: unknown;
}): ChannelDirectoryEntry {
  return {
    avatarUrl: params.avatarUrl ?? undefined,
    id: params.id,
    kind: "user",
    name: params.name ?? undefined,
    raw: params.raw,
  };
}

export async function listZalouserDirectoryGroupMembers(
  params: {
    cfg: OpenClawConfig;
    accountId?: string;
    groupId: string;
    limit?: number;
  },
  deps: ZalouserDirectoryDeps,
) {
  const account = resolveZalouserAccountSync({ accountId: params.accountId, cfg: params.cfg });
  const normalizedGroupId = parseZalouserDirectoryGroupId(params.groupId);
  const members = await deps.listZaloGroupMembers(account.profile, normalizedGroupId);
  const rows = members.map((member) =>
    mapUser({
      avatarUrl: member.avatar ?? null,
      id: member.userId,
      name: member.displayName,
      raw: member,
    }),
  );
  return typeof params.limit === "number" && params.limit > 0 ? rows.slice(0, params.limit) : rows;
}
