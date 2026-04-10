import { z } from "zod";

export const ChannelHeartbeatVisibilitySchema = z
  .object({
    showAlerts: z.boolean().optional(),
    showOk: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .strict()
  .optional();

export const ChannelHealthMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();
