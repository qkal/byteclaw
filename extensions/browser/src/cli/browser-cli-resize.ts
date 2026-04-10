import { type BrowserParentOpts, callBrowserResize } from "./browser-cli-shared.js";
import { danger, defaultRuntime } from "./core-api.js";

export async function runBrowserResizeWithOutput(params: {
  parent: BrowserParentOpts;
  profile?: string;
  width: number;
  height: number;
  targetId?: string;
  timeoutMs?: number;
  successMessage: string;
}): Promise<void> {
  const { width, height } = params;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    defaultRuntime.error(danger("width and height must be numbers"));
    defaultRuntime.exit(1);
    return;
  }

  const result = await callBrowserResize(
    params.parent,
    {
      height,
      profile: params.profile,
      targetId: params.targetId,
      width,
    },
    { timeoutMs: params.timeoutMs ?? 20_000 },
  );

  if (params.parent?.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(params.successMessage);
}
