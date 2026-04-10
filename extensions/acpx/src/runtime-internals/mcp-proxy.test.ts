import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledPluginFile } from "../../../../test/helpers/bundled-plugin-paths.js";

const tempDirs: string[] = [];
const proxyPath = path.resolve(bundledPluginFile("acpx", "src/runtime-internals/mcp-proxy.mjs"));

async function makeTempScript(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-mcp-proxy-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, name);
  await writeFile(scriptPath, content, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { force: true, recursive: true });
  }
});

describe("mcp-proxy", () => {
  it("injects configured MCP servers into ACP session bootstrap requests", async () => {
    const echoServerPath = await makeTempScript(
      "echo-server.cjs",
      String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => process.stdout.write(line + "\n"));
`,
    );

    const payload = Buffer.from(
      JSON.stringify({
        mcpServers: [
          {
            args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
            command: "npx",
            env: [{ name: "CANVA_TOKEN", value: "secret" }],
            name: "canva",
          },
        ],
        targetCommand: `${process.execPath} ${echoServerPath}`,
      }),
      "utf8",
    ).toString("base64url");

    const child = spawn(process.execPath, [proxyPath, "--payload", payload], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: process.cwd(), mcpServers: [] },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "session/load",
        params: { cwd: process.cwd(), mcpServers: [], sessionId: "sid-1" },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({
        id: 3,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "hello", type: "text" }], sessionId: "sid-1" },
      })}\n`,
    );
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });

    expect(lines[0].params.mcpServers).toEqual([
      {
        args: ["-y", "mcp-remote@latest", "https://mcp.canva.com/mcp"],
        command: "npx",
        env: [{ name: "CANVA_TOKEN", value: "secret" }],
        name: "canva",
      },
    ]);
    expect(lines[1].params.mcpServers).toEqual(lines[0].params.mcpServers);
    expect(lines[2].method).toBe("session/prompt");
    expect(lines[2].params.mcpServers).toBeUndefined();
  });
});
