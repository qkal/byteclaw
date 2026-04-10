import { describe, expect, it } from "vitest";
import {
  resolveSandboxBrowserConfig,
  resolveSandboxConfigForAgent,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxScope,
  resolveSandboxSshConfig,
} from "./sandbox/config.js";

describe("sandbox config merges", () => {
  it("resolves sandbox scope deterministically", () => {
    expect(resolveSandboxScope({})).toBe("agent");
    expect(resolveSandboxScope({ perSession: true })).toBe("session");
    expect(resolveSandboxScope({ perSession: false })).toBe("shared");
    expect(resolveSandboxScope({ perSession: true, scope: "agent" })).toBe("agent");
  });

  it("merges sandbox docker env and ulimits (agent wins)", () => {
    const resolved = resolveSandboxDockerConfig({
      agentDocker: {
        env: { BAR: "3", FOO: "2" },
        ulimits: { nproc: 256 },
      },
      globalDocker: {
        env: { FOO: "1", LANG: "C.UTF-8" },
        ulimits: { nofile: { hard: 20, soft: 10 } },
      },
      scope: "agent",
    });

    expect(resolved.env).toEqual({ BAR: "3", FOO: "2", LANG: "C.UTF-8" });
    expect(resolved.ulimits).toEqual({
      nofile: { hard: 20, soft: 10 },
      nproc: 256,
    });
  });

  it("resolves docker binds and shared-scope override behavior", () => {
    for (const scenario of [
      {
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toEqual([
            "/var/run/docker.sock:/var/run/docker.sock",
            "/home/user/source:/source:rw",
          ]);
        },
        input: {
          agentDocker: {
            binds: ["/home/user/source:/source:rw"],
          },
          globalDocker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
          scope: "agent" as const,
        },
        name: "merges sandbox docker binds (global + agent combined)",
      },
      {
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toBeUndefined();
        },
        input: {
          agentDocker: {},
          globalDocker: {},
          scope: "agent" as const,
        },
        name: "returns undefined binds when neither global nor agent has binds",
      },
      {
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
        },
        input: {
          agentDocker: {
            binds: ["/home/user/source:/source:rw"],
          },
          globalDocker: {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
          scope: "shared" as const,
        },
        name: "ignores agent binds under shared scope",
      },
      {
        assert: (resolved: ReturnType<typeof resolveSandboxDockerConfig>) => {
          expect(resolved.image).toBe("global");
        },
        input: {
          agentDocker: { image: "agent" },
          globalDocker: { image: "global" },
          scope: "shared" as const,
        },
        name: "ignores agent docker overrides under shared scope",
      },
    ]) {
      const resolved = resolveSandboxDockerConfig(scenario.input);
      scenario.assert(resolved);
    }
  });

  it("applies per-agent browser and prune overrides (ignored under shared scope)", () => {
    const browser = resolveSandboxBrowserConfig({
      agentBrowser: { enableNoVnc: false, enabled: true, headless: true },
      globalBrowser: { enableNoVnc: true, enabled: false, headless: false },
      scope: "agent",
    });
    expect(browser.enabled).toBe(true);
    expect(browser.headless).toBe(true);
    expect(browser.enableNoVnc).toBe(false);

    const prune = resolveSandboxPruneConfig({
      agentPrune: { idleHours: 0, maxAgeDays: 1 },
      globalPrune: { idleHours: 24, maxAgeDays: 7 },
      scope: "agent",
    });
    expect(prune).toEqual({ idleHours: 0, maxAgeDays: 1 });

    const browserShared = resolveSandboxBrowserConfig({
      agentBrowser: { enabled: true },
      globalBrowser: { enabled: false },
      scope: "shared",
    });
    expect(browserShared.enabled).toBe(false);

    const pruneShared = resolveSandboxPruneConfig({
      agentPrune: { idleHours: 0, maxAgeDays: 1 },
      globalPrune: { idleHours: 24, maxAgeDays: 7 },
      scope: "shared",
    });
    expect(pruneShared).toEqual({ idleHours: 24, maxAgeDays: 7 });
  });

  it("merges sandbox ssh settings and ignores agent overrides under shared scope", () => {
    const ssh = resolveSandboxSshConfig({
      agentSsh: {
        certificateFile: "~/.ssh/agent-cert.pub",
        strictHostKeyChecking: false,
        target: "agent@example.com:2222",
      },
      globalSsh: {
        command: "ssh",
        identityFile: "~/.ssh/global",
        strictHostKeyChecking: true,
        target: "global@example.com:22",
      },
      scope: "agent",
    });
    expect(ssh).toMatchObject({
      certificateFile: "~/.ssh/agent-cert.pub",
      command: "ssh",
      identityFile: "~/.ssh/global",
      strictHostKeyChecking: false,
      target: "agent@example.com:2222",
    });

    const sshShared = resolveSandboxSshConfig({
      agentSsh: {
        target: "agent@example.com:2222",
      },
      globalSsh: {
        target: "global@example.com:22",
      },
      scope: "shared",
    });
    expect(sshShared.target).toBe("global@example.com:22");
  });

  it("defaults sandbox backend to docker", () => {
    expect(resolveSandboxConfigForAgent().backend).toBe("docker");
  });
});
