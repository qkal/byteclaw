import type { Command } from "commander";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { runCommandWithRuntime } from "../core-api.js";
import { runBrowserResizeWithOutput } from "./browser-cli-resize.js";
import { type BrowserParentOpts, callBrowserRequest } from "./browser-cli-shared.js";
import { registerBrowserCookiesAndStorageCommands } from "./browser-cli-state.cookies-storage.js";
import { danger, defaultRuntime, parseBooleanValue } from "./core-api.js";

function parseOnOff(raw: string): boolean | null {
  const parsed = parseBooleanValue(raw);
  return parsed === undefined ? null : parsed;
}

function runBrowserCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

async function runBrowserSetRequest(params: {
  parent: BrowserParentOpts;
  path: string;
  body: Record<string, unknown>;
  successMessage: string;
}) {
  await runBrowserCommand(async () => {
    const profile = params.parent?.browserProfile;
    const result = await callBrowserRequest(
      params.parent,
      {
        body: params.body,
        method: "POST",
        path: params.path,
        query: profile ? { profile } : undefined,
      },
      { timeoutMs: 20_000 },
    );
    if (params.parent?.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    defaultRuntime.log(params.successMessage);
  });
}

export function registerBrowserStateCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  registerBrowserCookiesAndStorageCommands(browser, parentOpts);

  const set = browser.command("set").description("Browser environment settings");

  set
    .command("viewport")
    .description("Set viewport size (alias for resize)")
    .argument("<width>", "Viewport width", (v: string) => Number(v))
    .argument("<height>", "Viewport height", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (width: number, height: number, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await runBrowserResizeWithOutput({
          height,
          parent,
          profile,
          successMessage: `viewport set: ${width}x${height}`,
          targetId: opts.targetId,
          timeoutMs: 20_000,
          width,
        });
      });
    });

  set
    .command("offline")
    .description("Toggle offline mode")
    .argument("<on|off>", "on/off")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const offline = parseOnOff(value);
      if (offline === null) {
        defaultRuntime.error(danger("Expected on|off"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserSetRequest({
        body: {
          offline,
          targetId: normalizeOptionalString(opts.targetId),
        },
        parent,
        path: "/set/offline",
        successMessage: `offline: ${offline}`,
      });
    });

  set
    .command("headers")
    .description("Set extra HTTP headers (JSON object)")
    .argument("[headersJson]", "JSON object of headers (alternative to --headers-json)")
    .option("--headers-json <json>", "JSON object of headers")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (headersJson: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const headersJsonValue =
          normalizeOptionalString(opts.headersJson) ?? normalizeOptionalString(headersJson);
        if (!headersJsonValue) {
          throw new Error("Missing headers JSON (pass --headers-json or positional JSON argument)");
        }
        const parsed = JSON.parse(String(headersJsonValue)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Headers JSON must be a JSON object");
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") {
            headers[k] = v;
          }
        }
        const profile = parent?.browserProfile;
        const result = await callBrowserRequest(
          parent,
          {
            body: {
              headers,
              targetId: normalizeOptionalString(opts.targetId),
            },
            method: "POST",
            path: "/set/headers",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 20_000 },
        );
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log("headers set");
      });
    });

  set
    .command("credentials")
    .description("Set HTTP basic auth credentials")
    .option("--clear", "Clear credentials", false)
    .argument("[username]", "Username")
    .argument("[password]", "Password")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (username: string | undefined, password: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        body: {
          clear: Boolean(opts.clear),
          password,
          targetId: normalizeOptionalString(opts.targetId),
          username: normalizeOptionalString(username),
        },
        parent,
        path: "/set/credentials",
        successMessage: opts.clear ? "credentials cleared" : "credentials set",
      });
    });

  set
    .command("geo")
    .description("Set geolocation (and grant permission)")
    .option("--clear", "Clear geolocation + permissions", false)
    .argument("[latitude]", "Latitude", (v: string) => Number(v))
    .argument("[longitude]", "Longitude", (v: string) => Number(v))
    .option("--accuracy <m>", "Accuracy in meters", (v: string) => Number(v))
    .option("--origin <origin>", "Origin to grant permissions for")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (latitude: number | undefined, longitude: number | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        body: {
          accuracy: Number.isFinite(opts.accuracy) ? opts.accuracy : undefined,
          clear: Boolean(opts.clear),
          latitude: Number.isFinite(latitude) ? latitude : undefined,
          longitude: Number.isFinite(longitude) ? longitude : undefined,
          origin: normalizeOptionalString(opts.origin),
          targetId: normalizeOptionalString(opts.targetId),
        },
        parent,
        path: "/set/geolocation",
        successMessage: opts.clear ? "geolocation cleared" : "geolocation set",
      });
    });

  set
    .command("media")
    .description("Emulate prefers-color-scheme")
    .argument("<dark|light|none>", "dark/light/none")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const v = normalizeOptionalLowercaseString(value);
      const colorScheme =
        v === "dark" ? "dark" : v === "light" ? "light" : v === "none" ? "none" : null;
      if (!colorScheme) {
        defaultRuntime.error(danger("Expected dark|light|none"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserSetRequest({
        body: {
          colorScheme,
          targetId: normalizeOptionalString(opts.targetId),
        },
        parent,
        path: "/set/media",
        successMessage: `media colorScheme: ${colorScheme}`,
      });
    });

  set
    .command("timezone")
    .description("Override timezone (CDP)")
    .argument("<timezoneId>", "Timezone ID (e.g. America/New_York)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (timezoneId: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        body: {
          targetId: normalizeOptionalString(opts.targetId),
          timezoneId,
        },
        parent,
        path: "/set/timezone",
        successMessage: `timezone: ${timezoneId}`,
      });
    });

  set
    .command("locale")
    .description("Override locale (CDP)")
    .argument("<locale>", "Locale (e.g. en-US)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (locale: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        body: {
          locale,
          targetId: normalizeOptionalString(opts.targetId),
        },
        parent,
        path: "/set/locale",
        successMessage: `locale: ${locale}`,
      });
    });

  set
    .command("device")
    .description('Apply a Playwright device descriptor (e.g. "iPhone 14")')
    .argument("<name>", "Device name (Playwright devices)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (name: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserSetRequest({
        body: {
          name,
          targetId: normalizeOptionalString(opts.targetId),
        },
        parent,
        path: "/set/device",
        successMessage: `device: ${name}`,
      });
    });
}
