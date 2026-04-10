import { z } from "zod";

const ExecApprovalForwardTargetSchema = z
  .object({
    accountId: z.string().optional(),
    channel: z.string().min(1),
    threadId: z.union([z.string(), z.number()]).optional(),
    to: z.string().min(1),
  })
  .strict();

const ExecApprovalForwardingSchema = z
  .object({
    agentFilter: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    mode: z.union([z.literal("session"), z.literal("targets"), z.literal("both")]).optional(),
    sessionFilter: z.array(z.string()).optional(),
    targets: z.array(ExecApprovalForwardTargetSchema).optional(),
  })
  .strict()
  .optional();

export const ApprovalsSchema = z
  .object({
    exec: ExecApprovalForwardingSchema,
    plugin: ExecApprovalForwardingSchema,
  })
  .strict()
  .optional();
