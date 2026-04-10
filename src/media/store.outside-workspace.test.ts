import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type TempHomeEnv, createTempHomeEnv } from "../test-utils/temp-home.js";

const mocks = vi.hoisted(() => ({
  isSafeOpenError: vi.fn(
    (error: unknown) => typeof error === "object" && error !== null && "code" in error,
  ),
  readLocalFileSafely: vi.fn(),
}));

vi.mock("./store.runtime.js", () => ({
    isSafeOpenError: mocks.isSafeOpenError,
    readLocalFileSafely: mocks.readLocalFileSafely,
  }));

type StoreModule = typeof import("./store.js");

let saveMediaSource: StoreModule["saveMediaSource"];

async function expectOutsideWorkspaceStoreFailure(sourcePath: string) {
  await expect(saveMediaSource(sourcePath)).rejects.toMatchObject({
    code: "invalid-path",
    message: "Media path is outside workspace root",
  });
}

describe("media store outside-workspace mapping", () => {
  let tempHome: TempHomeEnv;
  let home = "";

  beforeAll(async () => {
    ({ saveMediaSource } = await import("./store.js"));
    tempHome = await createTempHomeEnv("openclaw-media-store-test-home-");
    ({ home } = tempHome);
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it("maps outside-workspace reads to a descriptive invalid-path error", async () => {
    const sourcePath = path.join(home, "outside-media.txt");
    await fs.writeFile(sourcePath, "hello");
    mocks.readLocalFileSafely.mockRejectedValueOnce({
      code: "outside-workspace",
      message: "file is outside workspace root",
    });

    await expectOutsideWorkspaceStoreFailure(sourcePath);
  });
});
