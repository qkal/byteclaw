import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import type { BrowserRouteContext } from "../server-context.js";
import {
  readBody,
  resolveTargetIdFromBody,
  resolveTargetIdFromQuery,
  withPlaywrightRouteContext,
} from "./agent.shared.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { jsonError, toBoolean, toNumber, toStringOrEmpty } from "./utils.js";

type StorageKind = "local" | "session";

export function parseStorageKind(raw: string): StorageKind | null {
  if (raw === "local" || raw === "session") {
    return raw;
  }
  return null;
}

export function parseStorageMutationRequest(
  kindParam: unknown,
  body: Record<string, unknown>,
): { kind: StorageKind | null; targetId: string | undefined } {
  return {
    kind: parseStorageKind(toStringOrEmpty(kindParam)),
    targetId: resolveTargetIdFromBody(body),
  };
}

export function parseRequiredStorageMutationRequest(
  kindParam: unknown,
  body: Record<string, unknown>,
): { kind: StorageKind; targetId: string | undefined } | null {
  const parsed = parseStorageMutationRequest(kindParam, body);
  if (!parsed.kind) {
    return null;
  }
  return {
    kind: parsed.kind,
    targetId: parsed.targetId,
  };
}

function parseStorageMutationOrRespond(
  res: BrowserResponse,
  kindParam: unknown,
  body: Record<string, unknown>,
) {
  const parsed = parseRequiredStorageMutationRequest(kindParam, body);
  if (!parsed) {
    jsonError(res, 400, "kind must be local|session");
    return null;
  }
  return parsed;
}

function parseStorageMutationFromRequest(req: BrowserRequest, res: BrowserResponse) {
  const body = readBody(req);
  const parsed = parseStorageMutationOrRespond(res, req.params.kind, body);
  if (!parsed) {
    return null;
  }
  return { body, parsed };
}

export function registerBrowserAgentStorageRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.get("/cookies", async (req, res) => {
    const targetId = resolveTargetIdFromQuery(req.query);
    await withPlaywrightRouteContext({
      ctx,
      feature: "cookies",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const result = await pw.cookiesGetViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
      targetId,
    });
  });

  app.post("/cookies/set", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const cookie =
      body.cookie && typeof body.cookie === "object" && !Array.isArray(body.cookie)
        ? (body.cookie as Record<string, unknown>)
        : null;
    if (!cookie) {
      return jsonError(res, 400, "cookie is required");
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "cookies set",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.cookiesSetViaPlaywright({
          cdpUrl,
          cookie: {
            domain: toStringOrEmpty(cookie.domain) || undefined,
            expires: toNumber(cookie.expires) ?? undefined,
            httpOnly: toBoolean(cookie.httpOnly) ?? undefined,
            name: toStringOrEmpty(cookie.name),
            path: toStringOrEmpty(cookie.path) || undefined,
            sameSite:
              cookie.sameSite === "Lax" ||
              cookie.sameSite === "None" ||
              cookie.sameSite === "Strict"
                ? cookie.sameSite
                : undefined,
            secure: toBoolean(cookie.secure) ?? undefined,
            url: toStringOrEmpty(cookie.url) || undefined,
            value: toStringOrEmpty(cookie.value),
          },
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/cookies/clear", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);

    await withPlaywrightRouteContext({
      ctx,
      feature: "cookies clear",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.cookiesClearViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.get("/storage/:kind", async (req, res) => {
    const kind = parseStorageKind(toStringOrEmpty(req.params.kind));
    if (!kind) {
      return jsonError(res, 400, "kind must be local|session");
    }
    const targetId = resolveTargetIdFromQuery(req.query);
    const key = toStringOrEmpty(req.query.key);

    await withPlaywrightRouteContext({
      ctx,
      feature: "storage get",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        const result = await pw.storageGetViaPlaywright({
          cdpUrl,
          key: normalizeOptionalString(key),
          kind,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId, ...result });
      },
      targetId,
    });
  });

  app.post("/storage/:kind/set", async (req, res) => {
    const mutation = parseStorageMutationFromRequest(req, res);
    if (!mutation) {
      return;
    }
    const key = toStringOrEmpty(mutation.body.key);
    if (!key) {
      return jsonError(res, 400, "key is required");
    }
    const value = typeof mutation.body.value === "string" ? mutation.body.value : "";

    await withPlaywrightRouteContext({
      ctx,
      feature: "storage set",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.storageSetViaPlaywright({
          cdpUrl,
          key,
          kind: mutation.parsed.kind,
          targetId: tab.targetId,
          value,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId: mutation.parsed.targetId,
    });
  });

  app.post("/storage/:kind/clear", async (req, res) => {
    const mutation = parseStorageMutationFromRequest(req, res);
    if (!mutation) {
      return;
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "storage clear",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.storageClearViaPlaywright({
          cdpUrl,
          kind: mutation.parsed.kind,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId: mutation.parsed.targetId,
    });
  });

  app.post("/set/offline", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const offline = toBoolean(body.offline);
    if (offline === undefined) {
      return jsonError(res, 400, "offline is required");
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "offline",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setOfflineViaPlaywright({
          cdpUrl,
          offline,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/headers", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const headers =
      body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
        ? (body.headers as Record<string, unknown>)
        : null;
    if (!headers) {
      return jsonError(res, 400, "headers is required");
    }

    const parsed: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") {
        parsed[k] = v;
      }
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "headers",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setExtraHTTPHeadersViaPlaywright({
          cdpUrl,
          headers: parsed,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/credentials", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const clear = toBoolean(body.clear) ?? false;
    const username = toStringOrEmpty(body.username) || undefined;
    const password = readStringValue(body.password);

    await withPlaywrightRouteContext({
      ctx,
      feature: "http credentials",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setHttpCredentialsViaPlaywright({
          cdpUrl,
          clear,
          password,
          targetId: tab.targetId,
          username,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/geolocation", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const clear = toBoolean(body.clear) ?? false;
    const latitude = toNumber(body.latitude);
    const longitude = toNumber(body.longitude);
    const accuracy = toNumber(body.accuracy) ?? undefined;
    const origin = toStringOrEmpty(body.origin) || undefined;

    await withPlaywrightRouteContext({
      ctx,
      feature: "geolocation",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setGeolocationViaPlaywright({
          accuracy,
          cdpUrl,
          clear,
          latitude,
          longitude,
          origin,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/media", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const schemeRaw = toStringOrEmpty(body.colorScheme);
    const colorScheme =
      schemeRaw === "dark" || schemeRaw === "light" || schemeRaw === "no-preference"
        ? schemeRaw
        : schemeRaw === "none"
          ? null
          : undefined;
    if (colorScheme === undefined) {
      return jsonError(res, 400, "colorScheme must be dark|light|no-preference|none");
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "media emulation",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.emulateMediaViaPlaywright({
          cdpUrl,
          colorScheme,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/timezone", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const timezoneId = toStringOrEmpty(body.timezoneId);
    if (!timezoneId) {
      return jsonError(res, 400, "timezoneId is required");
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "timezone",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setTimezoneViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          timezoneId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/locale", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const locale = toStringOrEmpty(body.locale);
    if (!locale) {
      return jsonError(res, 400, "locale is required");
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "locale",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setLocaleViaPlaywright({
          cdpUrl,
          locale,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });

  app.post("/set/device", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const name = toStringOrEmpty(body.name);
    if (!name) {
      return jsonError(res, 400, "name is required");
    }

    await withPlaywrightRouteContext({
      ctx,
      feature: "device emulation",
      req,
      res,
      run: async ({ cdpUrl, tab, pw }) => {
        await pw.setDeviceViaPlaywright({
          cdpUrl,
          name,
          targetId: tab.targetId,
        });
        res.json({ ok: true, targetId: tab.targetId });
      },
      targetId,
    });
  });
}
