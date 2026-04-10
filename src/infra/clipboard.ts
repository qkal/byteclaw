import { runCommandWithTimeout } from "../process/exec.js";

export async function copyToClipboard(value: string): Promise<boolean> {
  const attempts: { argv: string[] }[] = [
    { argv: ["pbcopy"] },
    { argv: ["xclip", "-selection", "clipboard"] },
    { argv: ["wl-copy"] },
    { argv: ["clip.exe"] }, // WSL / Windows
    { argv: ["powershell", "-NoProfile", "-Command", "Set-Clipboard"] },
  ];
  for (const attempt of attempts) {
    try {
      const result = await runCommandWithTimeout(attempt.argv, {
        input: value,
        timeoutMs: 3000,
      });
      if (result.code === 0 && !result.killed) {
        return true;
      }
    } catch {
      // Keep trying the next fallback
    }
  }
  return false;
}
