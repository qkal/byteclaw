import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";
import type { NextcloudTalkWebhookServerOptions } from "./types.js";

export interface WebhookHarness {
  webhookUrl: string;
  stop: () => Promise<void>;
}

const cleanupFns: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanupFns.length > 0) {
    const cleanup = cleanupFns.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

export type StartWebhookServerParams = Omit<
  NextcloudTalkWebhookServerOptions,
  "port" | "host" | "path" | "secret"
> & {
  path: string;
  secret?: string;
  host?: string;
  port?: number;
};

export async function startWebhookServer(
  params: StartWebhookServerParams,
): Promise<WebhookHarness> {
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? 0;
  const secret = params.secret ?? "nextcloud-secret";
  const { server, start } = createNextcloudTalkWebhookServer({
    ...params,
    host,
    port,
    secret,
  });
  await start();
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }

  const harness: WebhookHarness = {
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    webhookUrl: `http://${host}:${address.port}${params.path}`,
  };
  cleanupFns.push(harness.stop);
  return harness;
}
