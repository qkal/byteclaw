import { describe, expect, it } from "vitest";
import {
  DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS,
  resolveSandboxBrowserConfig,
  resolveSandboxDockerConfig,
} from "../agents/sandbox/config.js";
import { validateConfigObject } from "./config.js";

describe("sandbox docker config", () => {
  it("joins setupCommand arrays with newlines", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              setupCommand: ["apt-get update", "apt-get install -y curl"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.setupCommand).toBe(
        "apt-get update\napt-get install -y curl",
      );
    }
  });

  it("accepts safe binds array in sandbox.docker config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: ["/home/user/source:/source:rw", "/var/data/myapp:/data:ro"],
            },
          },
        },
        list: [
          {
            id: "main",
            sandbox: {
              docker: {
                binds: ["/home/user/projects:/projects:ro"],
                image: "custom-sandbox:latest",
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.docker?.binds).toEqual([
        "/home/user/source:/source:rw",
        "/var/data/myapp:/data:ro",
      ]);
      expect(res.config.agents?.list?.[0]?.sandbox?.docker?.binds).toEqual([
        "/home/user/projects:/projects:ro",
      ]);
    }
  });

  it("rejects network host mode via Zod schema validation", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              network: "host",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects container namespace join by default", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              network: "container:peer",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("allows container namespace join with explicit dangerous override", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              dangerouslyAllowContainerNamespaceJoin: true,
              network: "container:peer",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("uses agent override precedence for dangerous sandbox docker booleans", () => {
    for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
      const inherited = resolveSandboxDockerConfig({
        agentDocker: {},
        globalDocker: { [key]: true },
        scope: "agent",
      });
      expect(inherited[key]).toBe(true);

      const overridden = resolveSandboxDockerConfig({
        agentDocker: { [key]: false },
        globalDocker: { [key]: true },
        scope: "agent",
      });
      expect(overridden[key]).toBe(false);

      const sharedScope = resolveSandboxDockerConfig({
        agentDocker: { [key]: false },
        globalDocker: { [key]: true },
        scope: "shared",
      });
      expect(sharedScope[key]).toBe(true);
    }
  });

  it("rejects seccomp unconfined via Zod schema validation", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              seccompProfile: "unconfined",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects apparmor unconfined via Zod schema validation", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              apparmorProfile: "unconfined",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-string values in binds array", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              binds: [123, "/valid/path:/path"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("sandbox browser binds config", () => {
  it("accepts binds array in sandbox.browser config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              binds: ["/home/user/.chrome-profile:/data/chrome:rw"],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.defaults?.sandbox?.browser?.binds).toEqual([
        "/home/user/.chrome-profile:/data/chrome:rw",
      ]);
    }
  });

  it("rejects non-string values in browser binds array", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              binds: [123],
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("merges global and agent browser binds", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: { binds: ["/agent:/agent:rw"] },
      globalBrowser: { binds: ["/global:/global:ro"] },
      scope: "agent",
    });
    expect(resolved.binds).toEqual(["/global:/global:ro", "/agent:/agent:rw"]);
  });

  it("treats empty binds as configured (override to none)", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: {},
      globalBrowser: { binds: [] },
      scope: "agent",
    });
    expect(resolved.binds).toEqual([]);
  });

  it("ignores agent browser binds under shared scope", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: { binds: ["/agent:/agent:rw"] },
      globalBrowser: { binds: ["/global:/global:ro"] },
      scope: "shared",
    });
    expect(resolved.binds).toEqual(["/global:/global:ro"]);

    const resolvedNoGlobal = resolveSandboxBrowserConfig({
      agentBrowser: { binds: ["/agent:/agent:rw"] },
      globalBrowser: {},
      scope: "shared",
    });
    expect(resolvedNoGlobal.binds).toBeUndefined();
  });

  it("returns undefined binds when none configured", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: {},
      globalBrowser: {},
      scope: "agent",
    });
    expect(resolved.binds).toBeUndefined();
  });

  it("defaults browser network to dedicated sandbox network", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: {},
      globalBrowser: {},
      scope: "agent",
    });
    expect(resolved.network).toBe("openclaw-sandbox-browser");
  });

  it("prefers agent browser network over global browser network", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: { network: "openclaw-sandbox-browser-agent" },
      globalBrowser: { network: "openclaw-sandbox-browser-global" },
      scope: "agent",
    });
    expect(resolved.network).toBe("openclaw-sandbox-browser-agent");
  });

  it("merges cdpSourceRange with agent override", () => {
    const resolved = resolveSandboxBrowserConfig({
      agentBrowser: { cdpSourceRange: "172.22.0.1/32" },
      globalBrowser: { cdpSourceRange: "172.21.0.1/32" },
      scope: "agent",
    });
    expect(resolved.cdpSourceRange).toBe("172.22.0.1/32");
  });

  it("rejects host network mode in sandbox.browser config", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              network: "host",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects container namespace join in sandbox.browser config by default", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              network: "container:peer",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  it("allows container namespace join in sandbox.browser config with explicit dangerous override", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          sandbox: {
            browser: {
              network: "container:peer",
            },
            docker: {
              dangerouslyAllowContainerNamespaceJoin: true,
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
