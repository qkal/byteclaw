import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
}));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
  registerAcpRuntimeBackend: (entry: { id: string; runtime: unknown; healthy?: () => boolean }) => {
    runtimeRegistry.set(entry.id, entry);
  },
  unregisterAcpRuntimeBackend: (id: string) => {
    runtimeRegistry.delete(id);
  },
}));

vi.mock("./runtime.js", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: class {},
  createAgentRegistry: vi.fn(() => ({})),
  createFileSessionStore: vi.fn(() => ({})),
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import { createAcpxRuntimeService } from "./service.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  runtimeRegistry.clear();
  delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME;
  delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { force: true, recursive: true });
  }
});

function createServiceContext(workspaceDir: string) {
  return {
    config: {},
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    stateDir: path.join(workspaceDir, ".openclaw-plugin-state"),
    workspaceDir,
  };
}

describe("createAcpxRuntimeService", () => {
  it("registers and unregisters the embedded backend", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      cancel: vi.fn(),
      close: vi.fn(),
      doctor: vi.fn(async () => ({ message: "ok", ok: true })),
      ensureSession: vi.fn(),
      isHealthy: vi.fn(() => true),
      probeAvailability: vi.fn(async () => {}),
      runTurn: vi.fn(),
    };
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(ctx);

    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
  });

  it("creates the embedded runtime state directory before probing", async () => {
    const workspaceDir = await makeTempDir();
    const stateDir = path.join(workspaceDir, "custom-state");
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {
      await fs.access(stateDir);
    });
    const service = createAcpxRuntimeService({
      pluginConfig: { stateDir },
      runtimeFactory: () =>
        ({
          cancel: vi.fn(),
          close: vi.fn(),
          doctor: async () => ({ message: "ok", ok: true }),
          ensureSession: vi.fn(),
          isHealthy: () => true,
          probeAvailability,
          runTurn: vi.fn(),
        }) as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("passes the default runtime timeout to the embedded runtime factory", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      cancel: vi.fn(),
      close: vi.fn(),
      doctor: vi.fn(async () => ({ message: "ok", ok: true })),
      ensureSession: vi.fn(),
      isHealthy: vi.fn(() => true),
      probeAvailability: vi.fn(async () => {}),
      runTurn: vi.fn(),
    };
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService({
      runtimeFactory,
    });

    await service.start(ctx);

    expect(runtimeFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginConfig: expect.objectContaining({
          timeoutSeconds: 120,
        }),
      }),
    );

    await service.stop?.(ctx);
  });

  it("warns when legacy compatibility config is explicitly ignored", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      cancel: vi.fn(),
      close: vi.fn(),
      doctor: vi.fn(async () => ({ message: "ok", ok: true })),
      ensureSession: vi.fn(),
      isHealthy: vi.fn(() => true),
      probeAvailability: vi.fn(async () => {}),
      runTurn: vi.fn(),
    };
    const service = createAcpxRuntimeService({
      pluginConfig: {
        queueOwnerTtlSeconds: 30,
        strictWindowsCmdWrapper: false,
      },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "embedded acpx runtime ignores legacy compatibility config: queueOwnerTtlSeconds, strictWindowsCmdWrapper=false",
      ),
    );

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime probe via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE = "1";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const service = createAcpxRuntimeService({
      runtimeFactory: () =>
        ({
          cancel: vi.fn(),
          close: vi.fn(),
          doctor: async () => ({ message: "nope", ok: false }),
          ensureSession: vi.fn(),
          isHealthy: () => false,
          probeAvailability,
          runTurn: vi.fn(),
        }) as never,
    });

    await service.start(ctx);

    expect(probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeTruthy();

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime backend via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = "1";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime factory should not run when ACPX is skipped");
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: runtimeFactory as never,
    });

    await service.start(ctx);

    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});
