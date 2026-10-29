// `npm run release:version`: `changeset version` raises `package.json`'s version and writes CHANGELOG.md, and this puts the
// same version in the plugin's description in `src/index.ts`, which a test keeps the same.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const index = new URL("../src/index.ts", import.meta.url);
const source = readFileSync(index, "utf8");
const updated = source.replace(/^([ \t]*)version: "[^"]*",(\r?)$/m, `$1version: "${version}",$2`);
if (!updated.includes(`version: "${version}",`)) throw new Error("src/index.ts has no version to update.");
writeFileSync(index, updated);
console.log(`The plugin's version is ${version}.`);
