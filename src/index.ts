/**
 * S3 storage for Goodfellow: the site's media kept in any S3-compatible
 * service instead of its repository, so large files such as long videos never
 * go into the repository's history. Content still refers to files as
 * `/media/…`, and builds show them from the bucket's public address. The keys
 * stay in the site's CI secrets, or a full-stack site's server, which sign
 * each upload; the browser sends files straight to the bucket.
 */

import { type CustomService, servicesFrom } from "./services.js";
import { MEDIA_STORAGE_FILE, SETTINGS_FILE } from "./settings.js";
import { KEY_ID_SECRET, SECRET_KEY_SECRET } from "./signing.js";
import type { GoodfellowPlugin } from "./types.js";

export { type CustomService, SERVICES, type StorageService } from "./services.js";

export interface S3Options {
  /**
   * More services to offer, such as a MinIO server of the site's own:
   * `{ id, name, endpoint, region?, publicUrl? }`, with `{bucket}` in
   * `publicUrl` for the bucket's name.
   */
  services?: CustomService[];
}

/** S3 takes files up to 5 GB in one upload, which is as large as the admin panel sends. */
export const MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** The plugin, offering the services in `SERVICES` and any more given. */
export function s3(options: S3Options = {}): GoodfellowPlugin {
  const services = servicesFrom(options);
  return {
    name: "goodfellow-plugin-s3",
    title: "S3 storage",
    version: "0.1.1",
    description:
      "Keeps the site's media in any S3-compatible storage, such as Amazon S3, Cloudflare R2 or Backblaze B2.",
    permissions: {
      // Its screen sends files to the services it offers, and nowhere else.
      connect: [...new Set(services.flatMap((service) => service.connect))],
      files: [SETTINGS_FILE, MEDIA_STORAGE_FILE],
      secrets: [KEY_ID_SECRET, SECRET_KEY_SECRET],
      read: [SETTINGS_FILE],
    },
    admin: "goodfellow-plugin-s3/admin",
    screens: [{ id: "settings", title: "S3 storage" }],
    tasks: [{ id: "sign", module: "goodfellow-plugin-s3/sign", title: "Sign uploads to the bucket" }],
    server: "goodfellow-plugin-s3/server",
    mediaStorage: { maxBytes: MAX_BYTES },
    ...(options.services?.length && { options: { services: options.services } }),
  };
}

export default s3();
