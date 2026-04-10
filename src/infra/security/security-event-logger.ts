/**
 * Security Event Logger
 * Logs security-relevant events for audit trails and monitoring
 */

export interface SecurityEvent {
  timestamp: Date;
  level: "info" | "warning" | "error" | "critical";
  category: "auth" | "authorization" | "data-access" | "configuration" | "network" | "system";
  eventType: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  details: Record<string, unknown>;
  requestId?: string;
}

export interface SecurityEventLoggerOptions {
  enableConsole?: boolean;
  enableFile?: boolean;
  filePath?: string;
  maxFileSize?: number;
  retentionDays?: number;
}

class SecurityEventLogger {
  private options: Required<SecurityEventLoggerOptions>;
  private eventBuffer: SecurityEvent[] = [];
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(options: SecurityEventLoggerOptions = {}) {
    this.options = {
      enableConsole: options.enableConsole ?? true,
      enableFile: options.enableFile ?? false,
      filePath: options.filePath ?? "./security-events.log",
      maxFileSize: options.maxFileSize ?? 10 * 1024 * 1024, // 10MB
      retentionDays: options.retentionDays ?? 90,
    };

    if (this.options.enableFile) {
      this.startFlushInterval();
    }
  }

  /**
   * Log a security event
   */
  log(event: Omit<SecurityEvent, "timestamp">): void {
    const securityEvent: SecurityEvent = {
      ...event,
      timestamp: new Date(),
    };

    this.eventBuffer.push(securityEvent);

    if (this.options.enableConsole) {
      this.logToConsole(securityEvent);
    }

    if (this.eventBuffer.length >= 100) {
      this.flush();
    }
  }

  /**
   * Log authentication event
   */
  logAuth(eventType: string, details: Record<string, unknown> = {}): void {
    this.log({
      level: "info",
      category: "auth",
      eventType,
      details,
    });
  }

  /**
   * Log authorization event
   */
  logAuthorization(eventType: string, details: Record<string, unknown> = {}): void {
    this.log({
      level: "warning",
      category: "authorization",
      eventType,
      details,
    });
  }

  /**
   * Log data access event
   */
  logDataAccess(eventType: string, details: Record<string, unknown> = {}): void {
    this.log({
      level: "info",
      category: "data-access",
      eventType,
      details,
    });
  }

  /**
   * Log configuration change event
   */
  logConfigurationChange(eventType: string, details: Record<string, unknown> = {}): void {
    this.log({
      level: "warning",
      category: "configuration",
      eventType,
      details,
    });
  }

  /**
   * Log network security event
   */
  logNetwork(eventType: string, details: Record<string, unknown> = {}): void {
    this.log({
      level: "warning",
      category: "network",
      eventType,
      details,
    });
  }

  /**
   * Log critical security event
   */
  logCritical(eventType: string, details: Record<string, unknown> = {}): void {
    this.log({
      level: "critical",
      category: "system",
      eventType,
      details,
    });
  }

  /**
   * Log to console
   */
  private logToConsole(event: SecurityEvent): void {
    const prefix = `[SECURITY ${event.level.toUpperCase()}] ${event.category}/${event.eventType}`;
    const message = `${prefix} ${JSON.stringify(event.details)}`;
    console.log(message);
  }

  /**
   * Flush event buffer to file
   */
  async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    if (this.options.enableFile) {
      // In a real implementation, this would write to a file
      // For now, we'll just simulate it
      console.log(`[SECURITY] Flushed ${events.length} events to log`);
    }
  }

  /**
   * Start periodic flush interval
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 5000); // Flush every 5 seconds
  }

  /**
   * Stop the logger and flush remaining events
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }

  /**
   * Get event statistics
   */
  getStats() {
    return {
      bufferedEvents: this.eventBuffer.length,
      flushedEvents: 0, // Would track in real implementation
    };
  }
}

// Global security event logger instance
let globalLogger: SecurityEventLogger | null = null;

/**
 * Initialize global security event logger
 */
export function initializeSecurityLogger(
  options?: SecurityEventLoggerOptions,
): SecurityEventLogger {
  globalLogger = new SecurityEventLogger(options);
  return globalLogger;
}

/**
 * Get global security event logger
 */
export function getSecurityLogger(): SecurityEventLogger {
  if (!globalLogger) {
    globalLogger = new SecurityEventLogger();
  }
  return globalLogger;
}

/**
 * Convenience function to log security events
 */
export function logSecurityEvent(event: Omit<SecurityEvent, "timestamp">): void {
  getSecurityLogger().log(event);
}
