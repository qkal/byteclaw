import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";

export const zalouserSetupPlugin = {
  capabilities: {
    chatTypes: ["direct", "group"] as ("direct" | "group")[],
  },
  config: {
    defaultAccountId: (cfg: unknown) => resolveDefaultZalouserAccountId(cfg as never),
    listAccountIds: (cfg: unknown) => listZalouserAccountIds(cfg as never),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveZalouserAccountSync({ accountId, cfg }),
  },
  id: "zalouser",
  meta: {
    blurb: "Unofficial Zalo personal account connector.",
    docsPath: "/channels/zalouser",
    id: "zalouser",
    label: "ZaloUser",
    selectionLabel: "ZaloUser",
  },
  security: {
    resolveDmPolicy: createScopedDmSecurityResolver({
      channelKey: "zalouser",
      normalizeEntry: (raw: string) => raw.trim().replace(/^(zalouser|zlu):/i, ""),
      policyPathSuffix: "dmPolicy",
      resolveAllowFrom: (account: ReturnType<typeof resolveZalouserAccountSync>) =>
        account.config.allowFrom,
      resolvePolicy: (account: ReturnType<typeof resolveZalouserAccountSync>) =>
        account.config.dmPolicy,
    }),
  },
  setup: zalouserSetupAdapter,
  setupWizard: zalouserSetupWizard,
} as const;
