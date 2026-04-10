import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectAttackSurfaceSummaryFindings } from "./audit-extra.summary.js";

describe("security audit attack surface summary", () => {
  it("includes an attack surface summary (info)", () => {
    const cfg: OpenClawConfig = {
      browser: { enabled: true },
      channels: { telegram: { groupPolicy: "allowlist" }, whatsapp: { groupPolicy: "open" } },
      hooks: { enabled: true },
      tools: { elevated: { allowFrom: { whatsapp: ["+1"] }, enabled: true } },
    };

    const findings = collectAttackSurfaceSummaryFindings(cfg);
    const summary = findings.find((f) => f.checkId === "summary.attack_surface");

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "summary.attack_surface", severity: "info" }),
      ]),
    );
    expect(summary?.detail).toContain("trust model: personal assistant");
  });
});
