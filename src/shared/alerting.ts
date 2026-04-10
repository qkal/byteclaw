/**
 * Alerting system for monitoring and notifications.
 * Supports multiple alert channels and severity levels.
 */

export type AlertSeverity = "info" | "warning" | "error" | "critical";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AlertChannel {
  name: string;
  send(alert: Alert): Promise<void> | void;
}

export interface AlertingOptions {
  channels?: AlertChannel[];
  maxHistory?: number;
}

class AlertingSystem {
  private channels: Map<string, AlertChannel> = new Map();
  private history: Alert[] = [];
  private maxHistory: number;
  private alertIdCounter = 0;

  constructor(options: AlertingOptions = {}) {
    this.maxHistory = options.maxHistory ?? 1000;
    for (const channel of options.channels ?? []) {
      this.channels.set(channel.name, channel);
    }
  }

  /**
   * Add an alert channel.
   */
  addChannel(channel: AlertChannel): void {
    this.channels.set(channel.name, channel);
  }

  /**
   * Remove an alert channel.
   */
  removeChannel(name: string): void {
    this.channels.delete(name);
  }

  /**
   * Send an alert to all registered channels.
   */
  async alert(
    severity: AlertSeverity,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const alert: Alert = {
      id: `alert-${this.alertIdCounter++}`,
      severity,
      message,
      timestamp: Date.now(),
      metadata,
    };

    // Add to history
    this.history.push(alert);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Send to all channels
    const promises = Array.from(this.channels.values()).map((channel) =>
      Promise.resolve(channel.send(alert)),
    );
    await Promise.allSettled(promises);
  }

  /**
   * Get alert history.
   */
  getHistory(severity?: AlertSeverity): Alert[] {
    if (severity) {
      return this.history.filter((a) => a.severity === severity);
    }
    return [...this.history];
  }

  /**
   * Clear alert history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get statistics about alerts.
   */
  getStats(): Record<AlertSeverity, number> {
    return {
      info: this.history.filter((a) => a.severity === "info").length,
      warning: this.history.filter((a) => a.severity === "warning").length,
      error: this.history.filter((a) => a.severity === "error").length,
      critical: this.history.filter((a) => a.severity === "critical").length,
    };
  }
}

// Global alerting instance
const globalAlerting = new AlertingSystem();

/**
 * Send an alert to the global alerting system.
 */
export async function alert(
  severity: AlertSeverity,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await globalAlerting.alert(severity, message, metadata);
}

/**
 * Add a channel to the global alerting system.
 */
export function addAlertChannel(channel: AlertChannel): void {
  globalAlerting.addChannel(channel);
}

/**
 * Get alert history from the global system.
 */
export function getAlertHistory(severity?: AlertSeverity): Alert[] {
  return globalAlerting.getHistory(severity);
}

/**
 * Get alert statistics from the global system.
 */
export function getAlertStats(): Record<AlertSeverity, number> {
  return globalAlerting.getStats();
}

/**
 * Console alert channel for development/debugging.
 */
export class ConsoleAlertChannel implements AlertChannel {
  name = "console";

  send(alert: Alert): void {
    const timestamp = new Date(alert.timestamp).toISOString();
    console.error(`[${timestamp}] [${alert.severity.toUpperCase()}] ${alert.message}`);
    if (alert.metadata) {
      console.error("Metadata:", alert.metadata);
    }
  }
}
