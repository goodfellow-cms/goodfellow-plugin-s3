/**
 * S3 storage for Goodfellow: the site's media kept in any S3-compatible
 * service instead of its repository, so large files such as long videos never
 * go into the repository's history. Content still refers to files as
 * `/media/…`, and builds show them from the bucket's public address.
 */
import { MEDIA_STORAGE_FILE, SETTINGS_FILE } from "./settings.js";
import type { GoodfellowPlugin } from "./types.js";

/** Services the admin panel can reach without the site naming them: the S3-compatible ones most sites use. */
export const KNOWN_SERVICES = [
  "https://*.amazonaws.com",
  "https://*.r2.cloudflarestorage.com",
  "https://*.backblazeb2.com",
  "https://*.digitaloceanspaces.com",
  "https://*.wasabisys.com",
  "https://*.linodeobjects.com",
  "https://storage.googleapis.com",
];

/** S3 takes files up to 5 GB in one upload, which is as large as the admin panel sends. */
export const MAX_BYTES = 5 * 1024 * 1024 * 1024;

export interface S3Options {
  /**
   * More services' addresses, as origins, such as a MinIO server's
   * `https://minio.example.org`, for a site that lists the plugin in its own
   * config rather than installing it from the admin panel.
   */
  connect?: string[];
}

/** The plugin, reaching the services in `KNOWN_SERVICES` and any more given. */
export function s3(options: S3Options = {}): GoodfellowPlugin {
  return {
    name: "goodfellow-plugin-s3",
    title: "S3 storage",
    version: "0.1.0",
    description:
      "Keeps the site's media in any S3-compatible storage, such as Amazon S3, Cloudflare R2 or Backblaze B2.",
    permissions: {
      connect: [...KNOWN_SERVICES, ...(options.connect ?? [])],
      files: [SETTINGS_FILE, MEDIA_STORAGE_FILE],
    },
    admin: "goodfellow-plugin-s3/admin",
    screens: [{ id: "settings", title: "S3 storage" }],
    mediaStorage: { maxBytes: MAX_BYTES },
  };
}

export default s3();
