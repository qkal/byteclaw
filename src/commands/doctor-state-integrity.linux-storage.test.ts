import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectLinuxSdBackedStateDir,
  formatLinuxSdBackedStateDirWarning,
} from "./doctor-state-integrity.js";

function encodeMountInfoPath(value: string): string {
  return value
    .replace(/\\/g, String.raw`\134`)
    .replace(/\n/g, String.raw`\012`)
    .replace(/\t/g, String.raw`\011`)
    .replace(/ /g, String.raw`\040`);
}

describe("detectLinuxSdBackedStateDir", () => {
  it("detects state dir on mmc-backed mount", () => {
    const mountInfo = [
      "24 19 179:2 / / rw,relatime - ext4 /dev/mmcblk0p2 rw",
      "25 24 0:22 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
    ].join("\n");

    const result = detectLinuxSdBackedStateDir("/home/pi/.openclaw", {
      mountInfo,
      platform: "linux",
    });

    expect(result).toEqual({
      fsType: "ext4",
      mountPoint: "/",
      path: "/home/pi/.openclaw",
      source: "/dev/mmcblk0p2",
    });
  });

  it("returns null for non-mmc devices", () => {
    const mountInfo = "24 19 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw";

    const result = detectLinuxSdBackedStateDir("/home/user/.openclaw", {
      mountInfo,
      platform: "linux",
    });

    expect(result).toBeNull();
  });

  it("resolves /dev/disk aliases to mmc devices", () => {
    const mountInfo = "24 19 179:2 / / rw,relatime - ext4 /dev/disk/by-uuid/abcd-1234 rw";

    const result = detectLinuxSdBackedStateDir("/home/user/.openclaw", {
      mountInfo,
      platform: "linux",
      resolveDeviceRealPath: (devicePath) => {
        if (devicePath === "/dev/disk/by-uuid/abcd-1234") {
          return "/dev/mmcblk0p2";
        }
        return null;
      },
    });

    expect(result).toEqual({
      fsType: "ext4",
      mountPoint: "/",
      path: "/home/user/.openclaw",
      source: "/dev/disk/by-uuid/abcd-1234",
    });
  });

  it("uses resolved state path to select mount", () => {
    const mountInfo = [
      "24 19 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
      "30 24 179:5 / /mnt/slow rw,relatime - ext4 /dev/mmcblk1p1 rw",
    ].join("\n");

    const result = detectLinuxSdBackedStateDir("/tmp/openclaw-state", {
      mountInfo,
      platform: "linux",
      resolveRealPath: () => "/mnt/slow/openclaw/.openclaw",
    });

    expect(result).toEqual({
      fsType: "ext4",
      mountPoint: "/mnt/slow",
      path: "/mnt/slow/openclaw/.openclaw",
      source: "/dev/mmcblk1p1",
    });
  });

  it("returns null outside linux", () => {
    const mountInfo = "24 19 179:2 / / rw,relatime - ext4 /dev/mmcblk0p2 rw";

    const result = detectLinuxSdBackedStateDir(path.join("/Users", "tester", ".openclaw"), {
      mountInfo,
      platform: "darwin",
    });

    expect(result).toBeNull();
  });

  it("escapes decoded mountinfo control characters in warning output", () => {
    const mountRoot = "/home/pi/mnt\nspoofed";
    const stateDir = `${mountRoot}/.openclaw`;
    const encodedSource = String.raw`/dev/disk/by-uuid/mmc\012source`;
    const mountInfo = `30 24 179:2 / ${encodeMountInfoPath(mountRoot)} rw,relatime - ext4 ${encodedSource} rw`;

    const result = detectLinuxSdBackedStateDir(stateDir, {
      mountInfo,
      platform: "linux",
      resolveDeviceRealPath: (devicePath) => {
        if (devicePath === "/dev/disk/by-uuid/mmc\nsource") {
          return "/dev/mmcblk0p2";
        }
        return null;
      },
      resolveRealPath: () => stateDir,
    });

    expect(result).not.toBeNull();
    const warning = formatLinuxSdBackedStateDirWarning(stateDir, result!);
    expect(warning).toContain(String.raw`device /dev/disk/by-uuid/mmc\nsource`);
    expect(warning).toContain(String.raw`mount /home/pi/mnt\nspoofed`);
    expect(warning).not.toContain("device /dev/disk/by-uuid/mmc\nsource");
    expect(warning).not.toContain("mount /home/pi/mnt\nspoofed");
  });
});
