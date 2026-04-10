export interface LaneDeliverySnapshot {
  delivered: boolean;
  skippedNonSilent: number;
  failedNonSilent: number;
}

export interface LaneDeliveryStateTracker {
  markDelivered: () => void;
  markNonSilentSkip: () => void;
  markNonSilentFailure: () => void;
  snapshot: () => LaneDeliverySnapshot;
}

export function createLaneDeliveryStateTracker(): LaneDeliveryStateTracker {
  const state: LaneDeliverySnapshot = {
    delivered: false,
    failedNonSilent: 0,
    skippedNonSilent: 0,
  };
  return {
    markDelivered: () => {
      state.delivered = true;
    },
    markNonSilentFailure: () => {
      state.failedNonSilent += 1;
    },
    markNonSilentSkip: () => {
      state.skippedNonSilent += 1;
    },
    snapshot: () => ({ ...state }),
  };
}
