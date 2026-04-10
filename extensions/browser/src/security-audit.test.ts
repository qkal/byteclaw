import { describe, expect, it } from "vitest";
import { collectBrowserSecurityAuditFindings } from "./security-audit.js";

function collectFindings(
  config: Parameters<typeof collectBrowserSecurityAuditFindings>[0]["config"],
) {
  return collectBrowserSecurityAuditFindings({
    config,
    configPath: "/tmp/openclaw.json",
    env: {} as NodeJS.ProcessEnv,
    sourceConfig: config,
    stateDir: "/tmp/openclaw-state",
  });
}

describe("browser security audit collector", () => {
  it("flags browser control without auth", () => {
    const findings = collectFindings({
      browser: {
        enabled: true,
      },
      gateway: {
        auth: {},
        controlUi: { enabled: false },
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.control_no_auth",
          severity: "critical",
        }),
      ]),
    );
  });

  it("warns on remote http CDP profiles", () => {
    const findings = collectFindings({
      browser: {
        profiles: {
          remote: {
            cdpUrl: "http://example.com:9222",
            color: "#0066CC",
          },
        },
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.remote_cdp_http",
          severity: "warn",
        }),
      ]),
    );
  });

  it("redacts private-host CDP URLs in findings", () => {
    const findings = collectFindings({
      browser: {
        profiles: {
          remote: {
            cdpUrl:
              "http://169.254.169.254:9222/json/version?token=supersecrettokenvalue1234567890",
            color: "#0066CC",
          },
        },
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "browser.remote_cdp_private_host",
          detail: expect.stringContaining("token=supers…7890"),
          severity: "warn",
        }),
      ]),
    );
  });
});
