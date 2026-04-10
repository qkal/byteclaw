export interface LiveCacheFloor {
  observedCacheRead?: number;
  observedCacheWrite?: number;
  observedHitRate?: number;
  minCacheRead?: number;
  minCacheWrite?: number;
  minHitRate?: number;
  maxCacheRead?: number;
  maxCacheWrite?: number;
}

export const LIVE_CACHE_REGRESSION_BASELINE = {
  anthropic: {
    disabled: {
      maxCacheRead: 32,
      maxCacheWrite: 32,
      observedCacheRead: 0,
      observedCacheWrite: 0,
    },
    image: {
      minCacheRead: 4500,
      minCacheWrite: 1,
      minHitRate: 0.97,
      observedCacheRead: 5660,
      observedCacheWrite: 85,
      observedHitRate: 0.985,
    },
    mcp: {
      minCacheRead: 5800,
      minCacheWrite: 1,
      minHitRate: 0.97,
      observedCacheRead: 6240,
      observedCacheWrite: 113,
      observedHitRate: 0.982,
    },
    stable: {
      minCacheRead: 5400,
      minCacheWrite: 1,
      minHitRate: 0.97,
      observedCacheRead: 5660,
      observedCacheWrite: 18,
      observedHitRate: 0.996,
    },
    tool: {
      minCacheRead: 5000,
      minCacheWrite: 1,
      minHitRate: 0.97,
      observedCacheRead: 6223,
      observedCacheWrite: 97,
      observedHitRate: 0.984,
    },
  },
  openai: {
    image: {
      minCacheRead: 3840,
      minHitRate: 0.82,
      observedCacheRead: 4864,
      observedHitRate: 0.954,
    },
    mcp: {
      minCacheRead: 4096,
      minHitRate: 0.85,
      observedCacheRead: 4608,
      observedHitRate: 0.891,
    },
    stable: {
      minCacheRead: 4608,
      minHitRate: 0.9,
      observedCacheRead: 4864,
      observedHitRate: 0.966,
    },
    tool: {
      minCacheRead: 4096,
      minHitRate: 0.85,
      observedCacheRead: 4608,
      observedHitRate: 0.896,
    },
  },
} as const satisfies Record<string, Record<string, LiveCacheFloor>>;
