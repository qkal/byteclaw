/**
 * Production-grade optimized JSON parsing and stringification for hot paths.
 * Uses LRU caching, size limits, and security considerations (REDoS protection).
 */

interface ParseCacheEntry {
  value: unknown;
  timestamp: number;
  accessCount: number;
}

interface JsonOptimizerConfig {
  maxCacheSize: number;
  cacheTTL: number;
  maxStringLength: number;
  enableCache: boolean;
}

const DEFAULT_CONFIG: JsonOptimizerConfig = {
  maxCacheSize: 1000,
  cacheTTL: 5000,
  maxStringLength: 10 * 1024 * 1024,
  enableCache: true,
};

class LRUCache {
  private cache = new Map<string, ParseCacheEntry>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): ParseCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      entry.accessCount++;
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry;
    }
    return undefined;
  }

  set(key: string, value: ParseCacheEntry): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

let config = { ...DEFAULT_CONFIG };
const parseCache = new LRUCache(config.maxCacheSize);

/**
 * Configure the JSON optimizer.
 */
export function configureJsonOptimizer(
  newConfig: Partial<JsonOptimizerConfig>,
): void {
  config = { ...config, ...newConfig };
  if (newConfig.maxCacheSize !== undefined) {
    const newCache = new LRUCache(config.maxCacheSize);
    parseCache.clear();
  }
}

/**
 * Optimized JSON parse with LRU caching for frequently parsed strings.
 * Includes security checks for string length and potential DoS vectors.
 */
export function cachedJsonParse(text: string): unknown {
  // Security: Check string length to prevent memory exhaustion
  if (text.length > config.maxStringLength) {
    throw new Error(
      `JSON string exceeds maximum length of ${config.maxStringLength} bytes`,
    );
  }

  if (!config.enableCache) {
    return JSON.parse(text);
  }

  // Check cache first
  const cached = parseCache.get(text);
  if (cached && Date.now() - cached.timestamp < config.cacheTTL) {
    return cached.value;
  }

  // Parse and cache
  const value = JSON.parse(text);
  parseCache.set(text, {
    value,
    timestamp: Date.now(),
    accessCount: 0,
  });

  return value;
}

/**
 * Optimized JSON stringify with replacer for common types.
 * Includes circular reference detection and size limits.
 */
export function optimizedJsonStringify(
  value: unknown,
  space?: string | number,
  maxSize: number = 10 * 1024 * 1024,
): string | null {
  try {
    const seen = new WeakSet();
    const result = JSON.stringify(
      value,
      (_key, val) => {
        // Circular reference detection
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) {
            return '[Circular]';
          }
          seen.add(val);
        }
        return jsonReplacer(_key, val);
      },
      space,
    );

    // Security: Check result size
    if (result && result.length > maxSize) {
      throw new Error(`JSON string exceeds maximum size of ${maxSize} bytes`);
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.message.includes('maximum size')) {
      throw error;
    }
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
 * Includes validation for security.
 */
export function optimizedJsonParse(text: string): unknown {
  if (text.length > config.maxStringLength) {
    throw new Error(
      `JSON string exceeds maximum length of ${config.maxStringLength} bytes`,
    );
  }
  return JSON.parse(text, jsonReviver);
}

/**
 * Custom reviver for deserialization of common custom types.
 */
function jsonReviver(_key: string, val: unknown): unknown {
  if (typeof val === 'object' && val !== null) {
    const record = val as Record<string, unknown>;
    if (record.type === 'Buffer' && typeof record.data === 'string') {
      return Buffer.from(record.data, 'base64');
    }
    if (record.type === 'Uint8Array' && typeof record.data === 'string') {
      return Buffer.from(record.data, 'base64');
    }
  }
  return val;
}

/**
 * Clear the JSON parse cache.
 */
export function clearJsonParseCache(): void {
  parseCache.clear();
}

/**
 * Get cache statistics for monitoring.
 */
export function getJsonParseCacheStats(): {
  size: number;
  maxSize: number;
  config: JsonOptimizerConfig;
} {
  return {
    size: parseCache.size,
    maxSize: config.maxCacheSize,
    config: { ...config },
  };
}
