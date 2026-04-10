/**
 * Production-grade security event logging.
 * Structured logging for security events with severity levels and metadata.
 */

export type SecurityEventSeverity = "info" | "warning" | "error" | "critical";

export interface SecurityEvent {
  id: string;
  timestamp: number;
  severity: SecurityEventSeverity;
  category: string;
  message: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export interface SecurityLoggerOptions {
  enableConsole?: boolean;
  enableFile?: boolean;
  filePath?: string;
  maxHistory?: number;
  onEvent?: (event: SecurityEvent) => void;
}

class SecurityLogger {
  private history: SecurityEvent[] = [];
  private options: Required<SecurityLoggerOptions>;
  private eventCounter = 0;

  constructor(options: SecurityLoggerOptions = {}) {
    this.options = {
      enableConsole: options.enableConsole ?? true,
      enableFile: options.enableFile ?? false,
      filePath: options.filePath ?? "security-events.log",
      maxHistory: options.maxHistory ?? 1000,
      onEvent: options.onEvent ?? (() => {}),
    };
  }

  /**
   * Log a security event.
   */
  log(
    severity: SecurityEventSeverity,
    category: string,
    message: string,
    metadata?: SecurityEvent["metadata"],
  ): SecurityEvent {
    const event: SecurityEvent = {
      id: `sec-${this.eventCounter++}-${Date.now()}`,
      timestamp: Date.now(),
      severity,
      category,
      message,
      metadata,
    };

    this.history.push(event);

    // Trim history if exceeds max size
    if (this.history.length > this.options.maxHistory) {
      this.history.shift();
    }

    // Log to console if enabled
    if (this.options.enableConsole) {
      this.logToConsole(event);
    }

    // Call event callback
    this.options.onEvent(event);

    return event;
  }

  /**
   * Log authentication events.
   */
  logAuth(
    action: "login" | "logout" | "failed_login" | "password_change",
    userId?: string,
    metadata?: Record<string, unknown>,
  ): SecurityEvent {
    const severity = action === "failed_login" ? "warning" : "info";
    return this.log(severity, "auth", `Auth action: ${action}`, {
      userId,
      action,
      ...metadata,
    });
  }

  /**
   * Log authorization events.
   */
  logAuthz(
    action: "access_denied" | "access_granted",
    resource: string,
    userId?: string,
    metadata?: Record<string, unknown>,
  ): SecurityEvent {
    const severity = action === "access_denied" ? "warning" : "info";
    return this.log(severity, "authz", `Authz action: ${action} on ${resource}`, {
      userId,
      resource,
      action,
      ...metadata,
    });
  }

  /**
   * Log data access events.
   */
  logDataAccess(
    action: "read" | "write" | "delete",
    resource: string,
    userId?: string,
    metadata?: Record<string, unknown>,
  ): SecurityEvent {
    return this.log("info", "data_access", `Data access: ${action} on ${resource}`, {
      userId,
      resource,
      action,
      ...metadata,
    });
  }

  /**
   * Log security violations.
   */
  logViolation(
    type: string,
    message: string,
    severity: SecurityEventSeverity = "error",
    metadata?: Record<string, unknown>,
  ): SecurityEvent {
    return this.log(severity, "violation", `Security violation: ${type} - ${message}`, {
      violationType: type,
      ...metadata,
    });
  }

  /**
   * Log configuration changes.
   */
  logConfigChange(
    change: string,
    userId?: string,
    metadata?: Record<string, unknown>,
  ): SecurityEvent {
    return this.log("info", "config", `Config change: ${change}`, {
      userId,
      change,
      ...metadata,
    });
  }

  /**
   * Get event history.
   */
  getHistory(filter?: {
    severity?: SecurityEventSeverity;
    category?: string;
    since?: number;
  }): SecurityEvent[] {
    let events = [...this.history];

    if (filter?.severity) {
      events = events.filter((e) => e.severity === filter.severity);
    }

    if (filter?.category) {
      events = events.filter((e) => e.category === filter.category);
    }

    if (filter?.since) {
      events = events.filter((e) => e.timestamp >= filter.since);
    }

    return events;
  }

  /**
   * Get statistics about security events.
   */
  getStats(): {
    total: number;
    bySeverity: Record<SecurityEventSeverity, number>;
    byCategory: Record<string, number>;
  } {
    const bySeverity: Record<SecurityEventSeverity, number> = {
      info: 0,
      warning: 0,
      error: 0,
      critical: 0,
    };
    const byCategory: Record<string, number> = {};

    for (const event of this.history) {
      bySeverity[event.severity]++;
      byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
    }

    return {
      total: this.history.length,
      bySeverity,
      byCategory,
    };
  }

  /**
   * Clear event history.
   */
  clearHistory(): void {
    this.history = [];
  }

  private logToConsole(event: SecurityEvent): void {
    const timestamp = new Date(event.timestamp).toISOString();
    const prefix = `[${timestamp}] [SECURITY] [${event.severity.toUpperCase()}] [${event.category}]`;
    console.error(`${prefix} ${event.message}`);
    if (event.metadata && Object.keys(event.metadata).length > 0) {
      console.error("Metadata:", event.metadata);
    }
  }
}

// Global security logger instance
const globalSecurityLogger = new SecurityLogger();

/**
 * Log a security event using the global logger.
 */
export function logSecurityEvent(
  severity: SecurityEventSeverity,
  category: string,
  message: string,
  metadata?: Record<string, unknown>,
): SecurityEvent {
  return globalSecurityLogger.log(severity, category, message, metadata);
}

/**
 * Get the global security logger instance.
 */
export function getSecurityLogger(): SecurityLogger {
  return globalSecurityLogger;
}

/**
 * Configure the global security logger.
 */
export function configureSecurityLogger(options: SecurityLoggerOptions): void {
  const newLogger = new SecurityLogger(options);
  Object.assign(globalSecurityLogger, newLogger);
}
