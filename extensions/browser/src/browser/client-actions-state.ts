import type { BrowserActionOk, BrowserActionTargetOk } from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";

interface TargetedProfileOptions {
  targetId?: string;
  profile?: string;
}

type HttpCredentialsOptions = TargetedProfileOptions & {
  username?: string;
  password?: string;
  clear?: boolean;
};

type GeolocationOptions = TargetedProfileOptions & {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
  clear?: boolean;
};

function buildStateQuery(params: { targetId?: string; key?: string; profile?: string }): string {
  const query = new URLSearchParams();
  if (params.targetId) {
    query.set("targetId", params.targetId);
  }
  if (params.key) {
    query.set("key", params.key);
  }
  if (params.profile) {
    query.set("profile", params.profile);
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

async function postProfileJson<T>(
  baseUrl: string | undefined,
  params: { path: string; profile?: string; body: unknown },
): Promise<T> {
  const query = buildProfileQuery(params.profile);
  return await fetchBrowserJson<T>(withBaseUrl(baseUrl, `${params.path}${query}`), {
    body: JSON.stringify(params.body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    timeoutMs: 20_000,
  });
}

async function postTargetedProfileJson(
  baseUrl: string | undefined,
  params: {
    path: string;
    opts: { targetId?: string; profile?: string };
    body: Record<string, unknown>;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: {
      targetId: params.opts.targetId,
      ...params.body,
    },
    path: params.path,
    profile: params.opts.profile,
  });
}

export async function browserCookies(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<{ ok: true; targetId: string; cookies: unknown[] }> {
  const suffix = buildStateQuery({ profile: opts.profile, targetId: opts.targetId });
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    cookies: unknown[];
  }>(withBaseUrl(baseUrl, `/cookies${suffix}`), { timeoutMs: 20_000 });
}

export async function browserCookiesSet(
  baseUrl: string | undefined,
  opts: {
    cookie: Record<string, unknown>;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { cookie: opts.cookie, targetId: opts.targetId },
    path: "/cookies/set",
    profile: opts.profile,
  });
}

export async function browserCookiesClear(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { targetId: opts.targetId },
    path: "/cookies/clear",
    profile: opts.profile,
  });
}

export async function browserStorageGet(
  baseUrl: string | undefined,
  opts: {
    kind: "local" | "session";
    key?: string;
    targetId?: string;
    profile?: string;
  },
): Promise<{ ok: true; targetId: string; values: Record<string, string> }> {
  const suffix = buildStateQuery({ key: opts.key, profile: opts.profile, targetId: opts.targetId });
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    values: Record<string, string>;
  }>(withBaseUrl(baseUrl, `/storage/${opts.kind}${suffix}`), { timeoutMs: 20_000 });
}

export async function browserStorageSet(
  baseUrl: string | undefined,
  opts: {
    kind: "local" | "session";
    key: string;
    value: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: {
      key: opts.key,
      targetId: opts.targetId,
      value: opts.value,
    },
    path: `/storage/${opts.kind}/set`,
    profile: opts.profile,
  });
}

export async function browserStorageClear(
  baseUrl: string | undefined,
  opts: { kind: "local" | "session"; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { targetId: opts.targetId },
    path: `/storage/${opts.kind}/clear`,
    profile: opts.profile,
  });
}

export async function browserSetOffline(
  baseUrl: string | undefined,
  opts: { offline: boolean; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { offline: opts.offline, targetId: opts.targetId },
    path: "/set/offline",
    profile: opts.profile,
  });
}

export async function browserSetHeaders(
  baseUrl: string | undefined,
  opts: {
    headers: Record<string, string>;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { headers: opts.headers, targetId: opts.targetId },
    path: "/set/headers",
    profile: opts.profile,
  });
}

export async function browserSetHttpCredentials(
  baseUrl: string | undefined,
  opts: HttpCredentialsOptions = {},
): Promise<BrowserActionTargetOk> {
  return await postTargetedProfileJson(baseUrl, {
    body: {
      clear: opts.clear,
      password: opts.password,
      username: opts.username,
    },
    opts,
    path: "/set/credentials",
  });
}

export async function browserSetGeolocation(
  baseUrl: string | undefined,
  opts: GeolocationOptions = {},
): Promise<BrowserActionTargetOk> {
  return await postTargetedProfileJson(baseUrl, {
    body: {
      accuracy: opts.accuracy,
      clear: opts.clear,
      latitude: opts.latitude,
      longitude: opts.longitude,
      origin: opts.origin,
    },
    opts,
    path: "/set/geolocation",
  });
}

export async function browserSetMedia(
  baseUrl: string | undefined,
  opts: {
    colorScheme: "dark" | "light" | "no-preference" | "none";
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: {
      colorScheme: opts.colorScheme,
      targetId: opts.targetId,
    },
    path: "/set/media",
    profile: opts.profile,
  });
}

export async function browserSetTimezone(
  baseUrl: string | undefined,
  opts: { timezoneId: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: {
      targetId: opts.targetId,
      timezoneId: opts.timezoneId,
    },
    path: "/set/timezone",
    profile: opts.profile,
  });
}

export async function browserSetLocale(
  baseUrl: string | undefined,
  opts: { locale: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { locale: opts.locale, targetId: opts.targetId },
    path: "/set/locale",
    profile: opts.profile,
  });
}

export async function browserSetDevice(
  baseUrl: string | undefined,
  opts: { name: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  return await postProfileJson<BrowserActionTargetOk>(baseUrl, {
    body: { name: opts.name, targetId: opts.targetId },
    path: "/set/device",
    profile: opts.profile,
  });
}

export async function browserClearPermissions(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionOk> {
  return await postProfileJson<BrowserActionOk>(baseUrl, {
    body: { clear: true, targetId: opts.targetId },
    path: "/set/geolocation",
    profile: opts.profile,
  });
}
