import { vi } from "vitest";
import type { GatewayService } from "./service.js";

export function createMockGatewayService(overrides: Partial<GatewayService> = {}): GatewayService {
  return {
    install: vi.fn(async () => {}),
    isLoaded: vi.fn(async () => false),
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    readCommand: vi.fn(async () => null),
    readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
    restart: vi.fn(async () => ({ outcome: "completed" as const })),
    stage: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    ...overrides,
  };
}
