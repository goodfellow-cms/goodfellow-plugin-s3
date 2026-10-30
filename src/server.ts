/**
 * The plugin's server module, for full-stack sites whose server keeps the
 * keys (`S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in its environment):
 * it signs uploads straight away, rather than through the site's CI. Without
 * the keys it says so, and the admin module uses the CI's task instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSettings, SETTINGS_FILE } from "./settings.js";
import { credentialsFrom, signInput, signRequests } from "./signing.js";
import type { PluginServerContext } from "./types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Answers `sign` for editors signed in to the site, deletes for its owners only;
 * reads its settings from the site's files beside the server.
 */
export function s3Server(options: { root?: string; env?: Record<string, string | undefined> } = {}) {
  return async (request: Request, context: PluginServerContext): Promise<Response> => {
    if (context.path !== "sign") return json(404, { error: "not-found" });
    if (request.method !== "POST") return json(405, { error: "method-not-allowed" });
    if (!context.editor) return json(401, { error: "signed-out" });
    const credentials = credentialsFrom(options.env ?? process.env);
    if (!credentials) return json(404, { error: "no-keys" });
    const root = options.root ?? process.cwd();
    const settings = parseSettings(await readFile(join(root, SETTINGS_FILE), "utf8").catch(() => undefined));
    try {
      const input = signInput(await request.json());
      // Deleting stored files is for owners: editors can be limited to some of the site, which the server can't
      // see, so it doesn't sign deletes for them.
      if (input.action === "remove" && context.editor.role !== "owner") {
        return json(403, {
          error: "not-allowed",
          message: "Only the site's owners can delete files kept in S3 storage.",
        });
      }
      return json(200, { requests: await signRequests(input, settings, credentials) });
    } catch (error) {
      return json(400, { error: "not-signed", message: error instanceof Error ? error.message : String(error) });
    }
  };
}

export default s3Server();
