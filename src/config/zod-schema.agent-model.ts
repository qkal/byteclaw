import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      fallbacks: z.array(z.string()).optional(),
      primary: z.string().optional(),
    })
    .strict(),
]);
