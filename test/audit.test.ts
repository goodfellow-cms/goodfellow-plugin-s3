import { describe, expect, it } from "vitest";
import { type AuditReport, IGNORED, unignoredAdvisories } from "../scripts/audit.js";

/** An advisory as `npm audit --json` names it in a package's `via`. */
const advisory = (id: string, name: string) => ({
  source: 1,
  name,
  title: `${name} is vulnerable`,
  url: `https://github.com/advisories/${id}`,
  severity: "high",
});

describe("the audit", () => {
  it("fails on every advisory it doesn't leave out, once each, and only on those", () => {
    const report: AuditReport = {
      vulnerabilities: {
        picomatch: { via: [advisory("GHSA-fc5q-39xc-vjpf", "picomatch")] },
        // Vulnerable only through picomatch, which names the advisory itself.
        tinyglobby: { via: ["picomatch"] },
        undici: { via: [advisory("GHSA-aaaa-bbbb-cccc", "undici")] },
        fetcher: { via: ["undici", advisory("GHSA-aaaa-bbbb-cccc", "undici")] },
      },
    };
    expect(unignoredAdvisories(report)).toEqual([
      "high in undici: undici is vulnerable https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    ]);
    expect(unignoredAdvisories(report, {})).toHaveLength(2);
    expect(unignoredAdvisories({})).toEqual([]);
  });

  it("says why it leaves each advisory out", () => {
    for (const [id, reason] of Object.entries(IGNORED)) {
      expect(id).toMatch(/^GHSA(-[0-9a-z]{4}){3}$/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
