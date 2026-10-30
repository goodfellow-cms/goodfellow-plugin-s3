/**
 * The `sign` task, which the site's CI runs for the admin panel with the keys
 * in its secrets: it reads the bucket's settings from the site and signs the
 * requests the admin module asked for, only for the bucket and folder its
 * `S3_BUCKET` secret names. It reaches no service itself.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSettings, SETTINGS_FILE } from "./settings.js";
import { keysFrom, type SignedRequest, signRequests } from "./signing.js";
import type { PluginTaskContext } from "./types.js";

export default async function sign(input: unknown, context: PluginTaskContext): Promise<SignedRequest[]> {
  const settings = parseSettings(await readFile(join(context.root, SETTINGS_FILE), "utf8").catch(() => undefined));
  return signRequests(input, settings, keysFrom(context.secrets));
}
