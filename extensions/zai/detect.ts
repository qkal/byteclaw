import {
  type ZaiDetectedEndpoint,
  type ZaiEndpointId,
  detectZaiEndpoint as detectZaiEndpointCore,
} from "./runtime-api.js";

type DetectZaiEndpointFn = typeof detectZaiEndpointCore;

let detectZaiEndpointImpl: DetectZaiEndpointFn = detectZaiEndpointCore;

export function setDetectZaiEndpointForTesting(fn?: DetectZaiEndpointFn): void {
  detectZaiEndpointImpl = fn ?? detectZaiEndpointCore;
}

export async function detectZaiEndpoint(
  ...args: Parameters<DetectZaiEndpointFn>
): ReturnType<DetectZaiEndpointFn> {
  return await detectZaiEndpointImpl(...args);
}

export type { ZaiDetectedEndpoint, ZaiEndpointId };
