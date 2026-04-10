export type LocationSource = "pin" | "place" | "live";

export interface NormalizedLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  name?: string;
  address?: string;
  isLive?: boolean;
  source?: LocationSource;
  caption?: string;
}

type ResolvedLocation = NormalizedLocation & {
  source: LocationSource;
  isLive: boolean;
};

function resolveLocation(location: NormalizedLocation): ResolvedLocation {
  const source =
    location.source ??
    (location.isLive ? "live" : location.name || location.address ? "place" : "pin");
  const isLive = Boolean(location.isLive ?? source === "live");
  return { ...location, isLive, source };
}

function formatAccuracy(accuracy?: number): string {
  if (!Number.isFinite(accuracy)) {
    return "";
  }
  return ` ±${Math.round(accuracy ?? 0)}m`;
}

function formatCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

export function formatLocationText(location: NormalizedLocation): string {
  const resolved = resolveLocation(location);
  const coords = formatCoords(resolved.latitude, resolved.longitude);
  const accuracy = formatAccuracy(resolved.accuracy);
  const caption = resolved.caption?.trim();
  let header = "";

  if (resolved.source === "live" || resolved.isLive) {
    header = `🛰 Live location: ${coords}${accuracy}`;
  } else if (resolved.name || resolved.address) {
    const label = [resolved.name, resolved.address].filter(Boolean).join(" — ");
    header = `📍 ${label} (${coords}${accuracy})`;
  } else {
    header = `📍 ${coords}${accuracy}`;
  }

  return caption ? `${header}\n${caption}` : header;
}

export function toLocationContext(location: NormalizedLocation): {
  LocationLat: number;
  LocationLon: number;
  LocationAccuracy?: number;
  LocationName?: string;
  LocationAddress?: string;
  LocationSource: LocationSource;
  LocationIsLive: boolean;
} {
  const resolved = resolveLocation(location);
  return {
    LocationAccuracy: resolved.accuracy,
    LocationAddress: resolved.address,
    LocationIsLive: resolved.isLive,
    LocationLat: resolved.latitude,
    LocationLon: resolved.longitude,
    LocationName: resolved.name,
    LocationSource: resolved.source,
  };
}
