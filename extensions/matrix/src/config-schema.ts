import {
  AllowFromListSchema,
  ContextVisibilityModeSchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  buildNestedDmConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "openclaw/plugin-sdk/zod";

const matrixActionSchema = z
  .object({
    channelInfo: z.boolean().optional(),
    memberInfo: z.boolean().optional(),
    messages: z.boolean().optional(),
    pins: z.boolean().optional(),
    profile: z.boolean().optional(),
    reactions: z.boolean().optional(),
    verification: z.boolean().optional(),
  })
  .optional();

const matrixThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().nonnegative().optional(),
    maxAgeHours: z.number().nonnegative().optional(),
    spawnAcpSessions: z.boolean().optional(),
    spawnSubagentSessions: z.boolean().optional(),
  })
  .optional();

const matrixExecApprovalsSchema = z
  .object({
    agentFilter: z.array(z.string()).optional(),
    approvers: AllowFromListSchema,
    enabled: z.boolean().optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .optional();

const matrixRoomSchema = z
  .object({
    account: z.string().optional(),
    allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
    autoReply: z.boolean().optional(),
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema,
    users: AllowFromListSchema,
  })
  .optional();

const matrixNetworkSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

export const MatrixConfigSchema = z.object({
  accessToken: buildSecretInputSchema().optional(),
  accounts: z.record(z.string(), z.unknown()).optional(),
  ackReaction: z.string().optional(),
  ackReactionScope: z
    .enum(["group-mentions", "group-all", "direct", "all", "none", "off"])
    .optional(),
  actions: matrixActionSchema,
  allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
  allowlistOnly: z.boolean().optional(),
  autoJoin: z.enum(["always", "allowlist", "off"]).optional(),
  autoJoinAllowlist: AllowFromListSchema,
  avatarUrl: z.string().optional(),
  blockStreaming: z.boolean().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  defaultAccount: z.string().optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  dm: buildNestedDmConfigSchema({
    sessionScope: z.enum(["per-user", "per-room"]).optional(),
    threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  }),
  enabled: z.boolean().optional(),
  encryption: z.boolean().optional(),
  execApprovals: matrixExecApprovalsSchema,
  groupAllowFrom: AllowFromListSchema,
  groupPolicy: GroupPolicySchema.optional(),
  groups: z.object({}).catchall(matrixRoomSchema).optional(),
  historyLimit: z.number().int().min(0).optional(),
  homeserver: z.string().optional(),
  initialSyncLimit: z.number().optional(),
  markdown: MarkdownConfigSchema,
  mediaMaxMb: z.number().optional(),
  name: z.string().optional(),
  network: matrixNetworkSchema,
  password: buildSecretInputSchema().optional(),
  proxy: z.string().optional(),
  reactionNotifications: z.enum(["off", "own"]).optional(),
  replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
  responsePrefix: z.string().optional(),
  rooms: z.object({}).catchall(matrixRoomSchema).optional(),
  startupVerification: z.enum(["off", "if-unverified"]).optional(),
  startupVerificationCooldownHours: z.number().optional(),
  streaming: z.union([z.enum(["partial", "quiet", "off"]), z.boolean()]).optional(),
  textChunkLimit: z.number().optional(),
  threadBindings: matrixThreadBindingsSchema,
  threadReplies: z.enum(["off", "inbound", "always"]).optional(),
  userId: z.string().optional(),
});
