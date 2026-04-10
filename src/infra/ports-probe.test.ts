import net from "node:net";
import { describe, expect, it } from "vitest";
import { tryListenOnPort } from "./ports-probe.js";

async function withListeningServer(cb: (address: net.AddressInfo) => Promise<void>): Promise<void> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return;
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address");
  }

  try {
    await cb(address);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("tryListenOnPort", () => {
  it("can bind and release an ephemeral loopback port", async () => {
    try {
      await tryListenOnPort({ exclusive: true, host: "127.0.0.1", port: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw error;
    }
  });

  it("rejects when the port is already in use", async () => {
    await withListeningServer(async (address) => {
      await expect(
        tryListenOnPort({ host: "127.0.0.1", port: address.port }),
      ).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    });
  });
});
