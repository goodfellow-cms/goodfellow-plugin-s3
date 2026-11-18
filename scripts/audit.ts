// `npm audit`, leaving out the advisories `IGNORED` lists, which npm itself can't, as pnpm's `auditConfig.ignoreGhsas`
// in Goodfellow's own workspace does. CI's audit job runs it: `node scripts/audit.ts`. List an advisory only where it
// has no fixed release and reaches only the plugin's development tools: the packages sites install with the plugin are
// audited again with nothing left out, so an ignored advisory that reaches them still fails.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Advisories left out, by their GitHub id, each with why. */
export const IGNORED: Record<string, string> = {
  "GHSA-fc5q-39xc-vjpf":
    "picomatch has no fixed release, and its ReDoS needs an attacker-written glob: only the plugin's development tools " +
    "(Vitest, Changesets) compile globs, from their own config. Take it out once picomatch has a fixed release.",
};

/** One advisory in an `npm audit --json` report, where a package's `via` names it rather than another package. */
type Advisory = { source?: unknown; name?: unknown; title?: unknown; url?: unknown; severity?: unknown };

/** What `npm audit --json` reports, as far as advisories go. */
export type AuditReport = {
  vulnerabilities?: Record<string, { via?: (string | Advisory)[] }>;
  error?: { summary?: string };
};

/** How an `npm audit --json` run ended, as `spawnSync` gives it. */
export type AuditRun = { error?: Error; stdout?: string | null; stderr?: string | null };

/** Every advisory in `report`, each once, by its GitHub id (lowercase), or its name and title where it has none. */
function advisories(report: AuditReport): Map<string, string> {
  const found = new Map<string, string>();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // A package named here is vulnerable only through another, whose own `via` names the advisory.
      if (typeof via !== "object" || via === null) continue;
      const url = String(via.url ?? "");
      const ghsa = /GHSA(?:-[0-9a-z]{4}){3}/i.exec(url)?.[0];
      const id = ghsa ? ghsa.toLowerCase() : `${String(via.name)}: ${String(via.title)} ${url}`;
      found.set(id, `${String(via.severity)} in ${String(via.name)}: ${String(via.title)} ${url}`.trim());
    }
  }
  return found;
}

/** Whether `ignored` lists the advisory `id`, whatever the case of its id. */
const isIgnored = (id: string, ignored: Record<string, string>) =>
  Object.keys(ignored).some((key) => key.toLowerCase() === id);

/** The advisories in `report` that `ignored` doesn't list, each once, as a line to print. */
export function unignoredAdvisories(report: AuditReport, ignored: Record<string, string> = IGNORED): string[] {
  return [...advisories(report)].filter(([id]) => !isIgnored(id, ignored)).map(([, line]) => line);
}

/** Whether a value is a JSON object, not a list or `null`. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A run's report, or why there's none: npm not starting, no JSON, or npm saying it couldn't audit. */
function reportOf(run: AuditRun, what: string): AuditReport | string {
  if (run.error) return `npm audit${what} didn't start: ${run.error.message}`;
  let report: unknown;
  try {
    report = JSON.parse(run.stdout ?? "");
  } catch {
    return run.stderr?.trim() || `npm audit${what} gave no report.`;
  }
  if (!isRecord(report)) return `npm audit${what} gave no report.`;
  // Such as the registry not answering: that's not an audit that passed.
  const error = (report as AuditReport).error;
  if (error) return `npm audit${what} didn't run: ${error.summary ?? JSON.stringify(error)}`;
  // Every report npm writes lists its vulnerabilities, none included, so one without them isn't an audit that passed.
  if (!isRecord(report.vulnerabilities)) return `npm audit${what} gave no report.`;
  return report as AuditReport;
}

/**
 * Whether the audit fails, and what to print: every advisory in `all`, the whole tree's report, that `ignored` doesn't
 * list, and every advisory at all in `production`, the report of the packages sites install with the plugin.
 */
export function auditOutcome(
  all: AuditRun,
  production: AuditRun,
  ignored: Record<string, string> = IGNORED,
): { failed: boolean; lines: string[] } {
  const whole = reportOf(all, "");
  const shipped = reportOf(production, " --omit=dev");
  const problems = [whole, shipped].filter((report) => typeof report === "string");
  if (problems.length > 0) return { failed: true, lines: problems };
  const wholeReport = whole as AuditReport;
  const left = [
    ...unignoredAdvisories(wholeReport, ignored),
    // Left out only where it reaches nothing sites install.
    ...[...advisories(shipped as AuditReport).values()].map((line) => `${line} (in what sites install)`),
  ];
  if (left.length > 0) return { failed: true, lines: [...new Set(left)] };
  const reported = advisories(wholeReport);
  const used = Object.keys(ignored).filter((id) => reported.has(id.toLowerCase()));
  const stale = Object.keys(ignored).filter((id) => !reported.has(id.toLowerCase()));
  return {
    failed: false,
    lines: [
      `No advisories${used.length > 0 ? `, apart from ${used.join(", ")}, left out in scripts/audit.ts` : ""}.`,
      ...stale.map((id) => `${id} is no longer reported: take it out of scripts/audit.ts.`),
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Reports can be long, so more than the default megabyte of them is read.
  const audit = (...args: string[]) =>
    spawnSync("npm", ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const { failed, lines } = auditOutcome(audit(), audit("--omit=dev"));
  for (const line of lines) (failed ? console.error : console.log)(line);
  process.exit(failed ? 1 : 0);
}
