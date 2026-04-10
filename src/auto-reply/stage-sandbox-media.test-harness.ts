import { join } from "node:path";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MsgContext, TemplateContext } from "./templating.js";

export async function withSandboxMediaTempHome<T>(
  prefix: string,
  fn: (home: string) => Promise<T>,
): Promise<T> {
  return withTempHomeBase(async (home) => await fn(home), { prefix });
}

export function createSandboxMediaContexts(mediaPath: string): {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
} {
  const ctx: MsgContext = {
    Body: "hi",
    ChatType: "group",
    From: "whatsapp:group:demo",
    MediaPath: mediaPath,
    MediaType: "image/jpeg",
    MediaUrl: mediaPath,
    Provider: "whatsapp",
    To: "+2000",
  };
  return { ctx, sessionCtx: { ...ctx } };
}

export function createSandboxMediaStageConfig(home: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        sandbox: {
          mode: "non-main",
          workspaceRoot: join(home, "sandboxes"),
        },
        workspace: join(home, "openclaw"),
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: join(home, "sessions.json") },
  } as OpenClawConfig;
}
