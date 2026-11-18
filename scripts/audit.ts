// `npm audit`, leaving out the advisories `IGNORED` lists, which npm itself can't, as pnpm's `auditConfig.ignoreGhsas`
// in Goodfellow's own workspace does. CI's audit job runs it: `node scripts/audit.ts`. List an advisory only where it
// has no fixed release, with why it can't reach the sites the plugin runs on, their editors or their visitors.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Advisories left out, by their GitHub id, each with why. */
export const IGNORED: Record<string, string> = {
  "GHSA-fc5q-39xc-vjpf":
    "picomatch has no fixed release, and its ReDoS needs an attacker-written glob: only the plugin's development tools " +
    "(Vitest, Changesets) compile globs, from their own config, and no package sites install with the plugin needs it. " +
    "As in Goodfellow's own workspace.",
};

/** One advisory in an `npm audit --json` report, where a package's `via` names it rather than another package. */
type Advisory = { source?: unknown; name?: unknown; title?: unknown; url?: unknown; severity?: unknown };

/** What `npm audit --json` reports, as far as advisories go. */
export type AuditReport = { vulnerabilities?: Record<string, { via?: (string | Advisory)[] }> };

/** The advisories in `report` that `ignored` doesn't list, each once, as a line to print. */
export function unignoredAdvisories(report: AuditReport, ignored: Record<string, string> = IGNORED): string[] {
  const found = new Map<string, string>();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A package named here is vulnerable only through another, whose own `via` names the advisory.
      if (typeof via !== "object" || via === null) continue;
      const url = String(via.url ?? "");
      const id = /GHSA(?:-[0-9a-z]{4}){3}/i.exec(url)?.[0] ?? String(via.source ?? url);
      if (Object.hasOwn(ignored, id)) continue;
      found.set(id, `${String(via.severity)} in ${String(via.name)}: ${String(via.title)} ${url}`.trim());
    }
  }
  return [...found.values()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync("npm", ["audit", "--json"], { encoding: "utf8" });
  let report: AuditReport & { error?: { summary?: string } };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error(result.stderr.trim() || "npm audit gave no report.");
    process.exit(1);
  }
  // Such as the registry not answering: that's not an audit that passed.
  if (report.error) {
    console.error(`npm audit didn't run: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }
  const left = unignoredAdvisories(report);
  for (const line of left) console.error(line);
  if (left.length > 0) process.exit(1);
  console.log(`No advisories, apart from ${Object.keys(IGNORED).length} left out in scripts/audit.ts.`);
}
