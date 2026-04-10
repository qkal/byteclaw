/**
 * Connection Pool
 * Provides connection pooling for HTTP and database connections
 */

interface PooledConnection<T> {
  connection: T;
  inUse: boolean;
  lastUsed: number;
  createdAt: number;
}

interface ConnectionPoolOptions {
  maxConnections?: number;
  minConnections?: number;
  idleTimeout?: number;
  connectionTimeout?: number;
}

class ConnectionPool<T> {
  private pool: PooledConnection<T>[] = [];
  private availableConnections: PooledConnection<T>[] = [];
  private options: Required<ConnectionPoolOptions>;
  private createConnection: () => Promise<T>;
  private destroyConnection: (conn: T) => Promise<void>;
  private healthCheck?: (conn: T) => Promise<boolean>;

  constructor(
    createConnection: () => Promise<T>,
    destroyConnection: (conn: T) => Promise<void>,
    options: ConnectionPoolOptions = {},
  ) {
    this.createConnection = createConnection;
    this.destroyConnection = destroyConnection;
    this.options = {
      maxConnections: options.maxConnections ?? 10,
      minConnections: options.minConnections ?? 2,
      idleTimeout: options.idleTimeout ?? 30000, // 30 seconds
      connectionTimeout: options.connectionTimeout ?? 5000, // 5 seconds
    };
  }

  /**
   * Initialize the connection pool with minimum connections
   */
  async initialize(): Promise<void> {
    for (let i = 0; i < this.options.minConnections; i++) {
      const connection = await this.createConnection();
      const pooled: PooledConnection<T> = {
        connection,
        inUse: false,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      };
      this.pool.push(pooled);
      this.availableConnections.push(pooled);
    }
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire(): Promise<T> {
    // Try to get an available connection
    let pooled = this.availableConnections.pop();

    if (!pooled && this.pool.length < this.options.maxConnections) {
      // Create new connection if under limit
      const connection = await this.createConnection();
      pooled = {
        connection,
        inUse: true,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      };
      this.pool.push(pooled);
      return pooled.connection;
    }

    if (!pooled) {
      // Wait for available connection (simple retry)
      await this.waitForAvailableConnection();
      pooled = this.availableConnections.pop();
      if (!pooled) {
        throw new Error('Connection pool exhausted');
      }
    }

    // Health check if configured
    if (this.healthCheck) {
      const healthy = await this.healthCheck(pooled.connection);
      if (!healthy) {
        await this.destroyConnection(pooled.connection);
        const newConnection = await this.createConnection();
        pooled.connection = newConnection;
        pooled.createdAt = Date.now();
      }
    }

    pooled.inUse = true;
    pooled.lastUsed = Date.now();
    return pooled.connection;
  }

  /**
   * Release a connection back to the pool
   */
  async release(connection: T): Promise<void> {
    const pooled = this.pool.find((p) => p.connection === connection);
    if (!pooled) return;

    pooled.inUse = false;
    pooled.lastUsed = Date.now();
    this.availableConnections.push(pooled);
  }

  /**
   * Destroy a connection
   */
  async destroy(connection: T): Promise<void> {
    const index = this.pool.findIndex((p) => p.connection === connection);
    if (index === -1) return;

    const pooled = this.pool[index];
    await this.destroyConnection(pooled.connection);
    this.pool.splice(index, 1);

    const availIndex = this.availableConnections.findIndex(
      (p) => p.connection === connection,
    );
    if (availIndex > -1) {
      this.availableConnections.splice(availIndex, 1);
    }
  }

  /**
   * Clean up idle connections
   */
  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const pooled of this.pool) {
      if (!pooled.inUse && now - pooled.lastUsed > this.options.idleTimeout) {
        // Keep minimum connections
        if (this.pool.length > this.options.minConnections) {
          await this.destroy(pooled.connection);
        }
      }
    }
  }

  /**
   * Shutdown the pool and destroy all connections
   */
  async shutdown(): Promise<void> {
    await Promise.all(
      this.pool.map((p) => this.destroyConnection(p.connection)),
    );
    this.pool = [];
    this.availableConnections = [];
  }

  /**
   * Set health check function
   */
  setHealthCheck(check: (conn: T) => Promise<boolean>): void {
    this.healthCheck = check;
  }

  /**
   * Wait for an available connection
   */
  private async waitForAvailableConnection(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.availableConnections.length > 0) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalConnections: this.pool.length,
      availableConnections: this.availableConnections.length,
      inUseConnections: this.pool.length - this.availableConnections.length,
      maxConnections: this.options.maxConnections,
      minConnections: this.options.minConnections,
    };
  }
}

/**
 * HTTP connection pool for managing HTTP agent connections
 */
export class HttpConnectionPool {
  private agent: any;
  private options: {
    maxSockets?: number;
    maxFreeSockets?: number;
    timeout?: number;
    freeSocketTimeout?: number;
  };

  constructor(
    options: {
      maxSockets?: number;
      maxFreeSockets?: number;
      timeout?: number;
      freeSocketTimeout?: number;
    } = {},
  ) {
    this.options = {
      maxSockets: options.maxSockets ?? 50,
      maxFreeSockets: options.maxFreeSockets ?? 10,
      timeout: options.timeout ?? 60000,
      freeSocketTimeout: options.freeSocketTimeout ?? 30000,
    };
  }

  /**
   * Get HTTP agent with connection pooling
   */
  async getAgent() {
    if (!this.agent) {
      // Dynamically import http/https agent
      const https = await import('https');

      this.agent = new https.Agent({
        maxSockets: this.options.maxSockets,
        maxFreeSockets: this.options.maxFreeSockets,
        timeout: this.options.timeout,
        freeSocketTimeout: this.options.freeSocketTimeout,
      });
    }
    return this.agent;
  }

  /**
   * Destroy the agent and close all connections
   */
  async shutdown(): Promise<void> {
    if (this.agent) {
      this.agent.destroy();
      this.agent = null;
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    if (!this.agent) {
      return {
        totalSockets: 0,
        freeSockets: 0,
      };
    }
    return {
      totalSockets: this.agent.totalSocketCount ?? 0,
      freeSockets: this.agent.freeSockets ?? 0,
    };
  }
}

/**
 * Create a connection pool
 */
export function createConnectionPool<T>(
  createConnection: () => Promise<T>,
  destroyConnection: (conn: T) => Promise<void>,
  options?: ConnectionPoolOptions,
): ConnectionPool<T> {
  return new ConnectionPool(createConnection, destroyConnection, options);
}

/**
 * Create an HTTP connection pool
 */
export function createHttpConnectionPool(options?: {
  maxSockets?: number;
  maxFreeSockets?: number;
  timeout?: number;
  freeSocketTimeout?: number;
}): HttpConnectionPool {
  return new HttpConnectionPool(options);
}
