import { describe, expect, it, vi } from "vitest";
import { SignalHandler, createSignalHandler } from "./signal-handler.js";

describe("signal-handler", () => {
  it("registers and unregisters handlers", () => {
    const onShutdown = vi.fn();
    const handler = new SignalHandler({ onShutdown, timeout: 1000 });
    handler.register(["SIGTERM"]);
    expect(handler.isShuttingDown()).toBe(false);
    handler.unregister();
  });

  it("marks shutdown in progress", () => {
    const onShutdown = vi.fn();
    const handler = new SignalHandler({ onShutdown, timeout: 1000 });
    handler.register(["SIGTERM"]);
    // Simulate signal
    process.emit("SIGTERM", "SIGTERM");
    expect(handler.isShuttingDown()).toBe(true);
    handler.unregister();
  });

  it("calls onShutdown callback", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    const handler = new SignalHandler({ onShutdown, timeout: 1000 });
    handler.register(["SIGTERM"]);
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onShutdown).toHaveBeenCalledWith("SIGTERM");
    handler.unregister();
  });

  it("creates default handler with common signals", () => {
    const onShutdown = vi.fn();
    const handler = createSignalHandler(onShutdown, { timeout: 1000 });
    expect(handler.isShuttingDown()).toBe(false);
    handler.unregister();
  });
});
