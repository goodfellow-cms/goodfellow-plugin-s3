import { describe, expect, it } from "vitest";
import { type AuditReport, auditOutcome, IGNORED, unignoredAdvisories } from "../scripts/audit.js";

/** An advisory as `npm audit --json` names it in a package's `via`. */
const advisory = (id: string, name: string) => ({
  source: 1,
  name,
  title: `${name} is vulnerable`,
  url: `https://github.com/advisories/${id}`,
  severity: "high",
});

/** An `npm audit --json` run that reported `report`. */
const ran = (report: AuditReport) => ({ stdout: JSON.stringify(report), stderr: "" });

const picomatch: AuditReport = {
  vulnerabilities: { picomatch: { via: [advisory("GHSA-fc5q-39xc-vjpf", "picomatch")] } },
};
const none: AuditReport = { vulnerabilities: {} };

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
    // An id spelled in another case is the same advisory.
    const lower = { vulnerabilities: { picomatch: { via: [advisory("ghsa-fc5q-39xc-vjpf", "picomatch")] } } };
    expect(unignoredAdvisories(lower)).toEqual([]);
    // Advisories without an id are each their own.
    const unnamed = {
      vulnerabilities: {
        a: {
          via: [
            { name: "a", title: "one" },
            { name: "b", title: "two" },
          ],
        },
      },
    };
    expect(unignoredAdvisories(unnamed)).toHaveLength(2);
  });

  it("passes with only what it leaves out, and says what it left out or no longer needs to", () => {
    expect(auditOutcome(ran(picomatch), ran(none))).toEqual({
      failed: false,
      lines: ["No advisories, apart from GHSA-fc5q-39xc-vjpf, left out in scripts/audit.ts."],
    });
    expect(auditOutcome(ran(none), ran(none))).toEqual({
      failed: false,
      lines: ["No advisories.", "GHSA-fc5q-39xc-vjpf is no longer reported: take it out of scripts/audit.ts."],
    });
  });

  it("fails on an advisory it leaves out where it reaches what sites install", () => {
    expect(auditOutcome(ran(picomatch), ran(picomatch))).toMatchObject({
      failed: true,
      lines: [expect.stringContaining("picomatch is vulnerable")],
    });
  });

  it("fails on another advisory, and where npm audit doesn't run", () => {
    const undici = { vulnerabilities: { undici: { via: [advisory("GHSA-aaaa-bbbb-cccc", "undici")] } } };
    expect(auditOutcome(ran(undici), ran(none)).failed).toBe(true);
    expect(auditOutcome({ stdout: "not JSON", stderr: "npm ERR! oops" }, ran(none))).toEqual({
      failed: true,
      lines: ["npm ERR! oops"],
    });
    expect(auditOutcome({ stdout: "null", stderr: "" }, ran(none)).failed).toBe(true);
    // A report that lists no vulnerabilities at all, not even none, isn't one npm writes.
    for (const stdout of ["{}", "[]", '{"vulnerabilities":[]}', '{"vulnerabilities":null}']) {
      expect(auditOutcome({ stdout, stderr: "" }, ran(none)), stdout).toEqual({
        failed: true,
        lines: ["npm audit gave no report."],
      });
      expect(auditOutcome(ran(none), { stdout, stderr: "" }).lines, stdout).toEqual([
        "npm audit --omit=dev gave no report.",
      ]);
    }
    expect(auditOutcome(ran(none), ran({ error: { summary: "registry down" } }))).toEqual({
      failed: true,
      lines: ["npm audit --omit=dev didn't run: registry down"],
    });
    expect(auditOutcome({ error: new Error("spawn npm ENOENT"), stdout: null, stderr: null }, ran(none))).toEqual({
      failed: true,
      lines: ["npm audit didn't start: spawn npm ENOENT"],
    });
  });

  it("says why it leaves each advisory out", () => {
    for (const [id, reason] of Object.entries(IGNORED)) {
      expect(id).toMatch(/^GHSA(-[0-9a-z]{4}){3}$/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
