import { z } from "zod";

// Everything registered here will be redacted when the config is exposed,
// E.g. sent to the dashboard
export const sensitive = z.registry<undefined, z.ZodType>();
