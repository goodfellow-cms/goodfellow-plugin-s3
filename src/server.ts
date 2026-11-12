/**
 * The plugin's server module, for full-stack sites whose server keeps the
 * keys (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_BUCKET` in its
 * environment): it signs uploads straight away, rather than through the
 * site's CI. Without the keys it says so, and the admin module uses the CI's
 * task instead.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SignError } from "./errors.js";
import { MEDIA_STORAGE_FILE, parseSettings, parseStoredMedia, SETTINGS_FILE } from "./settings.js";
import { keysFrom, signInput, signRequests } from "./signing.js";
import type { PluginServerContext } from "./types.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Answers `sign` for editors signed in to the site, deletes and replacing a
 * stored file for its owners only; reads its settings, and the files the site
 * keeps in the bucket, from the site's files beside the server.
 */
export function s3Server(options: { root?: string; env?: Record<string, string | undefined> } = {}) {
  return async (request: Request, context: PluginServerContext): Promise<Response> => {
    if (context.path !== "sign") return json(404, { error: "not-found" });
    if (request.method !== "POST") return json(405, { error: "method-not-allowed" });
    if (!context.editor) return json(401, { error: "signed-out" });
    const keys = keysFrom(options.env ?? process.env);
    if (!keys.credentials) return json(404, { error: "no-keys" });
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
      // An upload to an address the bucket already has replaces that file, which is deleting it as far as visitors
      // can tell, so that's for owners too. The list is the server's own copy of the site's, the one it was built
      // with, so a file added since isn't in it, and where it can't be read nothing is refused: the bucket's
      // versioning covers both, as it does deletes.
      if (input.action === "upload" && context.editor.role !== "owner") {
        const stored = parseStoredMedia(await readFile(join(root, MEDIA_STORAGE_FILE), "utf8").catch(() => undefined));
        const taken = input.files.find(({ address }) => stored?.files[address] !== undefined);
        if (taken) {
          return json(403, {
            error: "not-allowed",
            message: `Only the site's owners can replace files kept in S3 storage, such as ${taken.address}. Upload it under another name.`,
          });
        }
      }
      return json(200, { requests: await signRequests(input, settings, keys) });
    } catch (error) {
      // Only problems worded for the editor go back as they are; any other error's message could name the server's
      // own files or code, so it gets a fixed one.
      const message = error instanceof SignError ? error.message : "S3 storage couldn't sign that request.";
      return json(400, { error: "not-signed", message });
    }
  };
}

export default s3Server();
