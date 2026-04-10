import { vi } from "vitest";

// Unit tests: avoid importing the real chokidar implementation (native fsevents, etc.).
vi.mock("chokidar", () => ({
  default: {
    watch: () => ({ close: async () => {}, on: () => {} }),
  },
  watch: () => ({ close: async () => {}, on: () => {} }),
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ error: "sqlite-vec disabled in tests", ok: false }),
}));
