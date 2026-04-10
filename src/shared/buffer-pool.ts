/**
 * Buffer pooling to reduce GC pressure and improve performance.
 * Reuses buffers instead of allocating new ones for each operation.
 */

interface BufferPoolOptions {
  maxSize: number;
  initialSize: number;
}

class BufferPool {
  private pool: Buffer[] = [];
  private maxSize: number;
  private initialSize: number;

  constructor(options: BufferPoolOptions) {
    this.maxSize = options.maxSize;
    this.initialSize = options.initialSize;
    this.preallocate();
  }

  private preallocate(): void {
    for (let i = 0; i < this.initialSize; i++) {
      this.pool.push(Buffer.allocUnsafe(0));
    }
  }

  /**
   * Acquire a buffer from the pool. Creates a new one if pool is empty.
   */
  acquire(size: number): Buffer {
    if (size <= 0) {
      return Buffer.allocUnsafe(0);
    }

    // Try to find a buffer of suitable size
    for (let i = 0; i < this.pool.length; i++) {
      const buf = this.pool[i];
      if (buf.length >= size) {
        this.pool.splice(i, 1);
        return buf.subarray(0, size);
      }
    }

    // No suitable buffer found, create a new one
    return Buffer.allocUnsafe(size);
  }

  /**
   * Return a buffer to the pool for reuse.
   */
  release(buffer: Buffer): void {
    if (this.pool.length >= this.maxSize) {
      return; // Pool is full, let GC handle it
    }
    this.pool.push(buffer);
  }

  /**
   * Get pool statistics for monitoring.
   */
  getStats(): { size: number; maxSize: number; totalBytes: number } {
    return {
      size: this.pool.length,
      maxSize: this.maxSize,
      totalBytes: this.pool.reduce((sum, buf) => sum + buf.length, 0),
    };
  }

  /**
   * Clear the pool to free memory.
   */
  clear(): void {
    this.pool = [];
  }
}

// Default pools for common buffer sizes
const SMALL_POOL = new BufferPool({ maxSize: 100, initialSize: 20 });
const MEDIUM_POOL = new BufferPool({ maxSize: 50, initialSize: 10 });
const LARGE_POOL = new BufferPool({ maxSize: 20, initialSize: 5 });

/**
 * Acquire a buffer from the appropriate pool based on size.
 */
export function acquireBuffer(size: number): Buffer {
  if (size <= 1024) {
    return SMALL_POOL.acquire(size);
  }
  if (size <= 64 * 1024) {
    return MEDIUM_POOL.acquire(size);
  }
  return LARGE_POOL.acquire(size);
}

/**
 * Return a buffer to the appropriate pool.
 */
export function releaseBuffer(buffer: Buffer): void {
  if (buffer.length <= 1024) {
    SMALL_POOL.release(buffer);
  } else if (buffer.length <= 64 * 1024) {
    MEDIUM_POOL.release(buffer);
  } else {
    LARGE_POOL.release(buffer);
  }
}

/**
 * Get statistics for all buffer pools.
 */
export function getBufferPoolStats(): {
  small: ReturnType<BufferPool["getStats"]>;
  medium: ReturnType<BufferPool["getStats"]>;
  large: ReturnType<BufferPool["getStats"]>;
} {
  return {
    small: SMALL_POOL.getStats(),
    medium: MEDIUM_POOL.getStats(),
    large: LARGE_POOL.getStats(),
  };
}

/**
 * Clear all buffer pools to free memory.
 */
export function clearBufferPools(): void {
  SMALL_POOL.clear();
  MEDIUM_POOL.clear();
  LARGE_POOL.clear();
}

/**
 * Execute a callback with an auto-managed buffer.
 * The buffer is automatically returned to the pool after the callback completes.
 */
export async function withBuffer<T>(
  size: number,
  callback: (buffer: Buffer) => T | Promise<T>,
): Promise<T> {
  const buffer = acquireBuffer(size);
  try {
    return await callback(buffer);
  } finally {
    releaseBuffer(buffer);
  }
}
