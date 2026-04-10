import type { Usage } from "@mariozechner/pi-ai";

export const ZERO_USAGE_FIXTURE: Usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: 0,
  },
  input: 0,
  output: 0,
  totalTokens: 0,
};
