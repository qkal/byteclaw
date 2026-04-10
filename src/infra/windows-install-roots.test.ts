import { afterEach, describe, expect, it } from "vitest";
import {
  _private,
  _resetWindowsInstallRootsForTests,
  getWindowsInstallRoots,
  getWindowsProgramFilesRoots,
  normalizeWindowsInstallRoot,
} from "./windows-install-roots.js";

afterEach(() => {
  _resetWindowsInstallRootsForTests();
});

describe("normalizeWindowsInstallRoot", () => {
  it("normalizes validated local Windows roots", () => {
    expect(normalizeWindowsInstallRoot(" D:/Apps/Program Files/ ")).toBe(String.raw`D:\Apps\Program Files`);
  });

  it("rejects invalid or overly broad values", () => {
    expect(normalizeWindowsInstallRoot(String.raw`relative\path`)).toBeNull();
    expect(normalizeWindowsInstallRoot(String.raw`\\server\share\Program Files`)).toBeNull();
    expect(normalizeWindowsInstallRoot("D:\\")).toBeNull();
    expect(normalizeWindowsInstallRoot(String.raw`D:\Apps;E:\Other`)).toBeNull();
  });
});

describe("getWindowsInstallRoots", () => {
  it("prefers HKLM registry roots over process environment values", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: (key, valueName) => {
        if (
          key === String.raw`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` &&
          valueName === "SystemRoot"
        ) {
          return String.raw`D:\Windows`;
        }
        if (
          key === String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` &&
          valueName === "ProgramFilesDir"
        ) {
          return String.raw`E:\Programs`;
        }
        if (
          key === String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` &&
          valueName === "ProgramFilesDir (x86)"
        ) {
          return String.raw`F:\Programs (x86)`;
        }
        if (
          key === String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` &&
          valueName === "ProgramW6432Dir"
        ) {
          return String.raw`E:\Programs`;
        }
        return null;
      },
    });

    const originalEnv = process.env;
    let roots;
    try {
      process.env = {
        ...originalEnv,
        ProgramFiles: "C:\\Poisoned Programs",
        "ProgramFiles(x86)": String.raw`C:\Poisoned Programs (x86)`,
        ProgramW6432: "C:\\Poisoned Programs",
        SystemRoot: "C:\\PoisonedWindows",
      };
      roots = getWindowsInstallRoots();
    } finally {
      process.env = originalEnv;
    }

    expect(roots).toEqual({
      programFiles: "E:\\Programs",
      programFilesX86: "F:\\Programs (x86)",
      programW6432: "E:\\Programs",
      systemRoot: "D:\\Windows",
    });
  });

  it("uses explicit env roots without consulting HKLM", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: (key, valueName) => {
        if (
          key === String.raw`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` &&
          valueName === "SystemRoot"
        ) {
          return String.raw`D:\Windows`;
        }
        if (
          key === String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` &&
          valueName === "ProgramFilesDir"
        ) {
          return String.raw`E:\Programs`;
        }
        return null;
      },
    });

    const roots = getWindowsInstallRoots({
      ProgramFiles: "H:\\Programs",
      "ProgramFiles(x86)": String.raw`I:\Programs (x86)`,
      ProgramW6432: "H:\\Programs",
      SystemRoot: "G:\\Windows",
    });

    expect(roots).toEqual({
      programFiles: "H:\\Programs",
      programFilesX86: "I:\\Programs (x86)",
      programW6432: "H:\\Programs",
      systemRoot: "G:\\Windows",
    });
  });

  it("falls back to validated env roots when registry lookup is unavailable", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: () => null,
    });

    const roots = getWindowsInstallRoots({
      "PROGRAMFILES(X86)": "F:\\Programs (x86)\\",
      programfiles: "E:\\Programs",
      programw6432: "E:\\Programs",
      systemroot: "D:\\Windows\\",
    });

    expect(roots).toEqual({
      programFiles: "E:\\Programs",
      programFilesX86: "F:\\Programs (x86)",
      programW6432: "E:\\Programs",
      systemRoot: "D:\\Windows",
    });
  });

  it("falls back to defaults when registry and env roots are invalid", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: () => String.raw`relative\path`,
    });

    const roots = getWindowsInstallRoots({
      ProgramFiles: "\\\\server\\share\\Program Files",
      "ProgramFiles(x86)": "D:\\",
      ProgramW6432: "C:\\Programs;D:\\Other",
      SystemRoot: "relative\\Windows",
    });

    expect(roots).toEqual({
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      programW6432: null,
      systemRoot: "C:\\Windows",
    });
  });
});

describe("getWindowsProgramFilesRoots", () => {
  it("prefers ProgramW6432 and dedupes roots case-insensitively", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: () => null,
    });

    expect(
      getWindowsProgramFilesRoots({
        ProgramFiles: "d:\\Programs\\",
        "ProgramFiles(x86)": String.raw`E:\Programs (x86)`,
        ProgramW6432: "D:\\Programs",
      }),
    ).toEqual([String.raw`D:\Programs`, String.raw`E:\Programs (x86)`]);
  });
});

describe("locateWindowsRegExe", () => {
  it("prefers SystemRoot and WINDIR candidates over arbitrary drive scans", () => {
    expect(
      _private.getWindowsRegExeCandidates({
        SystemRoot: "D:\\Windows",
        WINDIR: "E:\\Windows",
      }),
    ).toEqual([
      String.raw`D:\Windows\System32\reg.exe`,
      String.raw`E:\Windows\System32\reg.exe`,
      String.raw`C:\Windows\System32\reg.exe`,
    ]);
  });

  it("dedupes equivalent roots case-insensitively", () => {
    expect(
      _private.getWindowsRegExeCandidates({
        SystemRoot: "D:\\Windows\\",
        windir: "d:\\windows",
      }),
    ).toEqual([String.raw`D:\Windows\System32\reg.exe`, String.raw`C:\Windows\System32\reg.exe`]);
  });
});
