import { describe, expect, it } from "vitest";
import { splitSandboxBindSpec } from "./bind-spec.js";

describe("splitSandboxBindSpec", () => {
  it("splits POSIX bind specs with and without mode", () => {
    expect(splitSandboxBindSpec("/tmp/a:/workspace-a:ro")).toEqual({
      container: "/workspace-a",
      host: "/tmp/a",
      options: "ro",
    });
    expect(splitSandboxBindSpec("/tmp/b:/workspace-b")).toEqual({
      container: "/workspace-b",
      host: "/tmp/b",
      options: "",
    });
  });

  it("preserves Windows drive-letter host paths", () => {
    expect(splitSandboxBindSpec(String.raw`C:\Users\kai\workspace:/workspace:ro`)).toEqual({
      container: "/workspace",
      host: "C:\\Users\\kai\\workspace",
      options: "ro",
    });
  });

  it("returns null when no host/container separator exists", () => {
    expect(splitSandboxBindSpec("/tmp/no-separator")).toBeNull();
  });
});
