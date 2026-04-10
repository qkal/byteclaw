import { describe, expect, it } from "vitest";
import {
  configureSecurityLogger,
  getSecurityLogger,
  logSecurityEvent,
  SecurityLogger,
} from "./security-logger.js";

describe("security-logger", () => {
  describe("SecurityLogger", () => {
    it("logs security events", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      const event = logger.log("info", "test", "Test message");
      expect(event.id).toBeDefined();
      expect(event.severity).toBe("info");
    });

    it("logs authentication events", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      const event = logger.logAuth("login", "user123");
      expect(event.category).toBe("auth");
      expect(event.metadata?.userId).toBe("user123");
    });

    it("logs authorization events", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      const event = logger.logAuthz("access_denied", "resource1", "user123");
      expect(event.category).toBe("authz");
      expect(event.metadata?.action).toBe("access_denied");
    });

    it("logs data access events", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      const event = logger.logDataAccess("read", "data1", "user123");
      expect(event.category).toBe("data_access");
    });

    it("logs security violations", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      const event = logger.logViolation("xss", "XSS attempt detected", "critical");
      expect(event.category).toBe("violation");
      expect(event.severity).toBe("critical");
    });

    it("logs configuration changes", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      const event = logger.logConfigChange("updated rate limit", "user123");
      expect(event.category).toBe("config");
    });

    it("filters event history", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      logger.log("info", "cat1", "msg1");
      logger.log("error", "cat2", "msg2");
      const events = logger.getHistory({ severity: "error" });
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe("error");
    });

    it("provides statistics", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      logger.log("info", "cat1", "msg1");
      logger.log("error", "cat2", "msg2");
      const stats = logger.getStats();
      expect(stats.total).toBe(2);
      expect(stats.bySeverity.info).toBe(1);
      expect(stats.bySeverity.error).toBe(1);
    });

    it("clears history", () => {
      const logger = new SecurityLogger({ enableConsole: false });
      logger.log("info", "cat1", "msg1");
      logger.clearHistory();
      const stats = logger.getStats();
      expect(stats.total).toBe(0);
    });
  });

  describe("global logger", () => {
    it("logs events using global logger", () => {
      const event = logSecurityEvent("info", "test", "Test message");
      expect(event.id).toBeDefined();
    });

    it("returns global logger instance", () => {
      const logger = getSecurityLogger();
      expect(logger).toBeInstanceOf(SecurityLogger);
    });

    it("configures global logger", () => {
      configureSecurityLogger({ enableConsole: false, maxHistory: 100 });
      const logger = getSecurityLogger();
      const stats = logger.getStats();
      expect(stats).toBeDefined();
    });
  });
});
