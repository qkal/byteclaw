/**
 * Module Caching System
 * Provides advanced caching for Node.js modules with dependency tracking,
 * cache invalidation, and memory management.
 */

interface ModuleCacheEntry {
  module: unknown;
  dependencies: Set<string>;
  lastAccessed: number;
  size: number;
}

interface ModuleCacheOptions {
  maxSize?: number;
  ttl?: number;
  trackDependencies?: boolean;
}

class ModuleCache {
  private cache = new Map<string, ModuleCacheEntry>();
  private dependencyGraph = new Map<string, Set<string>>();
  private options: Required<ModuleCacheOptions>;
  private currentSize = 0;

  constructor(options: ModuleCacheOptions = {}) {
    this.options = {
      maxSize: options.maxSize ?? 50 * 1024 * 1024, // 50MB default
      ttl: options.ttl ?? 30 * 60 * 1000, // 30 minutes
      trackDependencies: options.trackDependencies ?? true,
    };
  }

  /**
   * Get a module from cache
   */
  get(key: string): unknown | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.lastAccessed > this.options.ttl) {
      this.invalidate(key);
      return undefined;
    }

    entry.lastAccessed = Date.now();
    return entry.module;
  }

  /**
   * Set a module in cache
   */
  set(key: string, module: unknown, dependencies: string[] = []): void {
    const size = this.estimateSize(module);

    // Check if we need to evict
    if (this.currentSize + size > this.options.maxSize) {
      this.evictLRU(size);
    }

    const entry: ModuleCacheEntry = {
      module,
      dependencies: new Set(dependencies),
      lastAccessed: Date.now(),
      size,
    };

    this.cache.set(key, entry);
    this.currentSize += size;

    // Update dependency graph
    if (this.options.trackDependencies) {
      for (const dep of dependencies) {
        if (!this.dependencyGraph.has(dep)) {
          this.dependencyGraph.set(dep, new Set());
        }
        this.dependencyGraph.get(dep)!.add(key);
      }
    }
  }

  /**
   * Invalidate a module and its dependents
   */
  invalidate(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;

    this.currentSize -= entry.size;
    this.cache.delete(key);

    // Invalidate dependents
    if (this.options.trackDependencies) {
      const dependents = this.dependencyGraph.get(key);
      if (dependents) {
        for (const dependent of dependents) {
          this.invalidate(dependent);
        }
        this.dependencyGraph.delete(key);
      }
    }
  }

  /**
   * Invalidate all modules
   */
  clear(): void {
    this.cache.clear();
    this.dependencyGraph.clear();
    this.currentSize = 0;
  }

  /**
   * Evict least recently used entries to make space
   */
  private evictLRU(requiredSpace: number): void {
    const entries = Array.from(this.cache.entries()).toSorted(
      (a, b) => a[1].lastAccessed - b[1].lastAccessed,
    );

    for (const [key, entry] of entries) {
      this.invalidate(key);
      if (this.currentSize + requiredSpace <= this.options.maxSize) {
        break;
      }
    }
  }

  /**
   * Estimate memory size of an object
   */
  private estimateSize(obj: unknown): number {
    if (obj === null || obj === undefined) return 0;
    if (typeof obj === "boolean") return 4;
    if (typeof obj === "number") return 8;
    if (typeof obj === "string") return obj.length * 2;
    if (typeof obj === "object") {
      // Rough estimate for objects
      return 1024; // 1KB default for objects
    }
    return 0;
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      memoryUsage: this.currentSize,
      maxMemory: this.options.maxSize,
      hitRate: 0, // Would need to track hits/misses
    };
  }
}

// Global module cache instance
export const moduleCache = new ModuleCache({
  maxSize: 100 * 1024 * 1024, // 100MB
  ttl: 60 * 60 * 1000, // 1 hour
  trackDependencies: true,
});

/**
 * Cached module import with dependency tracking
 */
export async function cachedImport(
  specifier: string,
  dependencies: string[] = [],
): Promise<unknown> {
  const cached = moduleCache.get(specifier);
  if (cached !== undefined) {
    return cached;
  }

  const module = await import(specifier);
  moduleCache.set(specifier, module, dependencies);
  return module;
}

/**
 * Invalidate cached module and its dependents
 */
export function invalidateModule(specifier: string): void {
  moduleCache.invalidate(specifier);
}

/**
 * Clear all cached modules
 */
export function clearModuleCache(): void {
  moduleCache.clear();
}

/**
 * Get module cache statistics
 */
export function getModuleCacheStats() {
  return moduleCache.getStats();
}
