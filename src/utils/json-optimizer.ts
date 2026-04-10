/**
 * Optimized JSON parsing and stringification for hot paths.
 * Uses caching and optimized strategies for common patterns.
 */

interface ParseCacheEntry {
  value: unknown;
  timestamp: number;
}

const PARSE_CACHE = new Map<string, ParseCacheEntry>();
const PARSE_CACHE_TTL = 5000; // 5 seconds
const PARSE_CACHE_MAX_SIZE = 1000;

/**
 * Optimized JSON parse with caching for frequently parsed strings.
 */
export function cachedJsonParse(text: string): unknown {
  // Check cache first
  const cached = PARSE_CACHE.get(text);
  if (cached && Date.now() - cached.timestamp < PARSE_CACHE_TTL) {
    return cached.value;
  }

  // Parse and cache
  const value = JSON.parse(text);

  // Evict old entries if cache is full
  if (PARSE_CACHE.size >= PARSE_CACHE_MAX_SIZE) {
    const oldestKey = PARSE_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      PARSE_CACHE.delete(oldestKey);
    }
  }

  PARSE_CACHE.set(text, { value, timestamp: Date.now() });
  return value;
}

/**
 * Optimized JSON stringify with replacer for common types.
 */
export function optimizedJsonStringify(
  value: unknown,
  space?: string | number,
): string | null {
  try {
    return JSON.stringify(value, jsonReplacer, space);
  } catch {
    return null;
  }
}

/**
 * Custom replacer for optimized serialization of common types.
 */
function jsonReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (typeof val === 'function') {
    return '[Function]';
  }
  if (val instanceof Error) {
    return { message: val.message, name: val.name, stack: val.stack };
  }
  if (val instanceof Uint8Array) {
    return { data: Buffer.from(val).toString('base64'), type: 'Uint8Array' };
  }
  if (Buffer.isBuffer(val)) {
    return { data: val.toString('base64'), type: 'Buffer' };
  }
  return val;
}

/**
 * Parse JSON with automatic reviver for common custom types.
 */
export function optimizedJsonParse(text: string): unknown {
  return JSON.parse(text, jsonReviver);
}

/**
 * Custom reviver for deserialization of common custom types.
 */
function jsonReviver(_key: string, val: unknown): unknown {
  if (typeof val === 'object' && val !== null) {
    if (
      (val as { type?: string }).type === 'Buffer' &&
      (val as { data?: string }).data
    ) {
      return Buffer.from((val as { data: string }).data, 'base64');
    }
    if (
      (val as { type?: string }).type === 'Uint8Array' &&
      (val as { data?: string }).data
    ) {
      return Buffer.from((val as { data: string }).data, 'base64');
    }
  }
  return val;
}

/**
 * Clear the JSON parse cache.
 */
export function clearJsonParseCache(): void {
  PARSE_CACHE.clear();
}

/**
 * Get cache statistics for monitoring.
 */
export function getJsonParseCacheStats(): { size: number; maxSize: number } {
  return {
    size: PARSE_CACHE.size,
    maxSize: PARSE_CACHE_MAX_SIZE,
  };
}
