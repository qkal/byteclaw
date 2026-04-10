export const IOS_NODE = {
  connected: true,
  displayName: "iOS Node",
  nodeId: "ios-node",
  remoteIp: "192.168.0.88",
} as const;

export function createIosNodeListResponse(ts: number = Date.now()) {
  return {
    nodes: [IOS_NODE],
    ts,
  };
}
