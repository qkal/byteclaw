export interface LazyCacheOptions {
  /** Time-to-live in milliseconds for cache entries */
  ttl?: number;
  /** Maximum number of cached entries */
  maxSize?: number;
  /** Callback when cache is invalidated */
  onInvalidate?: (key: string) => void;
}

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  hits: number;
}

/** Simple in-memory cache with TTL and size limits */
class LazyCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private options: Required<LazyCacheOptions>;

  constructor(options: LazyCacheOptions = {}) {
    this.options = {
      ttl: options.ttl ?? Number.POSITIVE_INFINITY,
      maxSize: options.maxSize ?? 100,
      onInvalidate: options.onInvalidate ?? (() => {}),
    };
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.timestamp > this.options.ttl) {
      this.delete(key);
      return undefined;
    }

    entry.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    // Enforce size limit
    if (this.cache.size >= this.options.maxSize && !this.cache.has(key)) {
      // Evict least recently used (simple FIFO for now)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  delete(key: string): void {
    if (this.cache.delete(key)) {
      this.options.onInvalidate(key);
    }
  }

  clear(): void {
    for (const key of this.cache.keys()) {
      this.delete(key);
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.options.maxSize,
      totalHits: Array.from(this.cache.values()).reduce(
        (sum, e) => sum + e.hits,
        0,
      ),
    };
  }
}

/** Global cache instance for lazy loading */
const globalCache = new LazyCache<unknown>({
  ttl: 5 * 60 * 1000, // 5 minutes
  maxSize: 200,
});

export function createLazyRuntimeSurface<TModule, TSurface>(
  importer: () => Promise<TModule>,
  select: (module: TModule) => TSurface,
  options?: LazyCacheOptions,
): () => Promise<TSurface> {
  const cacheKey = `lazy-surface-${importer.name || 'anonymous'}`;
  let cached: Promise<TSurface> | null = null;

  return () => {
    // Check global cache first
    const cachedValue = globalCache.get(cacheKey) as
      | Promise<TSurface>
      | undefined;
    if (cachedValue) return cachedValue;

    cached ??= importer()
      .then(select)
      .then((result) => {
        globalCache.set(cacheKey, cached as Promise<TSurface>);
        return result;
      });
    return cached;
  };
}

/** Cache the raw dynamically imported runtime module behind a stable loader. */
export function createLazyRuntimeModule<TModule>(
  importer: () => Promise<TModule>,
  options?: LazyCacheOptions,
): () => Promise<TModule> {
  return createLazyRuntimeSurface(importer, (module) => module, options);
}

/** Cache a single named runtime export without repeating a custom selector closure per caller. */
export function createLazyRuntimeNamedExport<
  TModule,
  const TKey extends keyof TModule,
>(
  importer: () => Promise<TModule>,
  key: TKey,
  options?: LazyCacheOptions,
): () => Promise<TModule[TKey]> {
  return createLazyRuntimeSurface(importer, (module) => module[key], options);
}

export function createLazyRuntimeMethod<
  TSurface,
  TArgs extends unknown[],
  TResult,
>(
  load: () => Promise<TSurface>,
  select: (surface: TSurface) => (...args: TArgs) => TResult,
): (...args: TArgs) => Promise<Awaited<TResult>> {
  const invoke = async (...args: TArgs): Promise<Awaited<TResult>> => {
    const method = select(await load());
    return await method(...args);
  };
  return invoke;
}

export function createLazyRuntimeMethodBinder<TSurface>(
  load: () => Promise<TSurface>,
) {
  return function <TArgs extends unknown[], TResult>(
    select: (surface: TSurface) => (...args: TArgs) => TResult,
  ): (...args: TArgs) => Promise<Awaited<TResult>> {
    return createLazyRuntimeMethod(load, select);
  };
}

/** Clear all cached lazy-loaded modules */
export function clearLazyCache(): void {
  globalCache.clear();
}

/** Get statistics about the lazy cache */
export function getLazyCacheStats() {
  return globalCache.getStats();
}
