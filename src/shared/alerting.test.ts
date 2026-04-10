import { describe, expect, it, vi } from "vitest";
import {
  addAlertChannel,
  alert,
  ConsoleAlertChannel,
  getAlertHistory,
  getAlertStats,
  type Alert,
} from "./alerting.js";

describe("alerting", () => {
  it("sends alerts to console channel", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    addAlertChannel(new ConsoleAlertChannel());
    await alert("warning", "Test alert");
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("stores alert history", async () => {
    addAlertChannel(new ConsoleAlertChannel());
    await alert("error", "Test error");
    const history = getAlertHistory();
    expect(history).toHaveLength(1);
    expect(history[0].message).toBe("Test error");
  });

  it("filters history by severity", async () => {
    addAlertChannel(new ConsoleAlertChannel());
    await alert("error", "Error");
    await alert("warning", "Warning");
    const errors = getAlertHistory("error");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe("error");
  });

  it("provides alert statistics", async () => {
    addAlertChannel(new ConsoleAlertChannel());
    await alert("error", "Error");
    await alert("warning", "Warning");
    const stats = getAlertStats();
    expect(stats.error).toBe(1);
    expect(stats.warning).toBe(1);
  });
});
