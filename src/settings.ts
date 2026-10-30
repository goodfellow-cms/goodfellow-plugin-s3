/**
 * Where the site's media is kept: the bucket, the service's address and the
 * address the files are public at, in `content/s3-storage.json`, which holds
 * no keys: they stay in the site's CI secrets or a full-stack site's server.
 */
import { uriEncode } from "./sigv4.js";

export const SETTINGS_FILE = "content/s3-storage.json";
/** Goodfellow's list of media a plugin keeps, which builds read to show it from the bucket. */
export const MEDIA_STORAGE_FILE = "content/media-storage.json";

export interface StorageSettings {
  /** Which service it is (`services.ts`), and what was given to find the bucket there, such as its region. */
  service: string;
  location: string;
  /** Whether the public address is one the owner gave, rather than the bucket's own. */
  ownAddress: boolean;
  /** Whether each upload says anyone may read it, for services without bucket-wide settings. */
  publicRead: boolean;
  /** The S3 service's address, such as `https://s3.eu-west-1.amazonaws.com` or `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** The bucket's region, such as `eu-west-1`; `auto` for Cloudflare R2. */
  region: string;
  /** A folder in the bucket for the site's files, such as `media/`, or nothing. */
  folder: string;
  /** The address the bucket's files are public at, folder included, such as `https://media.example.org`. */
  publicUrl: string;
}

export interface StoredMediaFile {
  version: 1;
  plugin: string;
  url: string;
  files: Record<string, { size: number; width?: number; height?: number }>;
}

export type SettingsProblem = "endpoint" | "bucket" | "region" | "folder" | "publicUrl";

/** An `https://` origin, or `http://` on this computer for trying out a local service such as MinIO. */
export function isServiceAddress(address: string): boolean {
  return (
    /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(address) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(address)
  );
}

/** Where files can be public, as Goodfellow takes it: `https://`, with no `?` or `#`. */
export function isPublicAddress(address: string): boolean {
  if (/[?#\s]/.test(address)) return false;
  return (
    /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/.*)?$/i.test(address) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/.*)?$/.test(address)
  );
}

/** What's wrong with settings, field by field. */
export function settingsProblems(settings: StorageSettings): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  if (!isServiceAddress(settings.endpoint)) problems.push("endpoint");
  // S3's own rules for bucket names, which every compatible service follows.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(settings.bucket)) problems.push("bucket");
  if (!/^[a-z0-9-]{1,32}$/.test(settings.region)) problems.push("region");
  if (settings.folder && !/^([\w.~-]+\/)+$/.test(settings.folder)) problems.push("folder");
  if (!isPublicAddress(settings.publicUrl)) problems.push("publicUrl");
  return problems;
}

/** Settings as typed: addresses without a trailing slash, and a folder ending in one. */
export function tidySettings(settings: StorageSettings): StorageSettings {
  const folder = settings.folder.trim().replace(/^\/+/, "");
  return {
    service: settings.service,
    location: settings.location.trim(),
    ownAddress: settings.ownAddress,
    publicRead: settings.publicRead,
    endpoint: settings.endpoint.trim().replace(/\/+$/, ""),
    bucket: settings.bucket.trim(),
    region: settings.region.trim() || "auto",
    folder: folder && !folder.endsWith("/") ? `${folder}/` : folder,
    publicUrl: settings.publicUrl.trim().replace(/\/+$/, ""),
  };
}

/** The settings from the file's text, or `undefined` without any or when they can't be used. */
export function parseSettings(text: string | null | undefined): StorageSettings | undefined {
  if (!text) return undefined;
  try {
    const file = JSON.parse(text) as Partial<StorageSettings> & { version?: number };
    if (file.version !== 1) return undefined;
    const settings = tidySettings({
      service: String(file.service ?? ""),
      location: String(file.location ?? ""),
      ownAddress: file.ownAddress === true,
      publicRead: file.publicRead === true,
      endpoint: String(file.endpoint ?? ""),
      bucket: String(file.bucket ?? ""),
      region: String(file.region ?? ""),
      folder: String(file.folder ?? ""),
      publicUrl: String(file.publicUrl ?? ""),
    });
    return settingsProblems(settings).length === 0 ? settings : undefined;
  } catch {
    return undefined;
  }
}

/** The settings file's text, with a trailing newline, as Goodfellow writes content. */
export function settingsText(settings: StorageSettings): string {
  const { service, location, endpoint, bucket, region, folder, publicUrl, ownAddress, publicRead } = settings;
  const file = { version: 1, service, location, endpoint, bucket, region, folder, publicUrl, ownAddress, publicRead };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Goodfellow's list of stored media from its text, or `undefined`. */
export function parseStoredMedia(text: string | null | undefined): StoredMediaFile | undefined {
  if (!text) return undefined;
  try {
    const file = JSON.parse(text) as Partial<StoredMediaFile>;
    if (file.version !== 1 || typeof file.plugin !== "string" || typeof file.url !== "string") return undefined;
    return { version: 1, plugin: file.plugin, url: file.url, files: file.files ?? {} };
  } catch {
    return undefined;
  }
}

/** The list of stored media with this plugin keeping new files at `url`, keeping the files it lists. */
export function storedMediaText(plugin: string, url: string, before: StoredMediaFile | undefined): string {
  const files = Object.fromEntries(Object.entries(before?.files ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ version: 1, plugin, url, files }, null, 2)}\n`;
}

/** A media address's part, decoded, if it's one a file can have: not `.` or `..`, and no `/`, `\`, `%` or control characters. */
function keyPart(part: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(part);
  } catch {
    return undefined;
  }
  // Checked once decoded, since that's what the key holds: `%2e%2e` is `..`, and `%252e` would be `%2e` in a key.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (decoded === "" || /^\.+$/.test(decoded) || /[/\\%\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  return decoded;
}

/** The object's key in the bucket for a media address: `/media/sermon.mp4` is `<folder>sermon.mp4`. */
export function objectKey(settings: StorageSettings, address: string): string {
  const parts = /^\/media\/[\w.~%-]+(\/[\w.~%-]+)*$/.test(address)
    ? address.slice("/media/".length).split("/").map(keyPart)
    : [undefined];
  if (parts.some((part) => part === undefined)) {
    throw new Error(`${address} isn't a media address S3 storage can keep.`);
  }
  return `${settings.folder}${parts.join("/")}`;
}

/**
 * The address requests for an object go to, in path style, which every
 * S3-compatible service answers. Refuses a key the address would read
 * differently, such as one with `..` in it, so what's signed is only ever
 * an object in the site's folder.
 */
export function objectUrl(settings: StorageSettings, key: string): URL {
  // Encoded as signatures encode it, so the address sent is the one signed.
  const path = uriEncode(`${settings.bucket}/${key}`, true);
  const url = new URL(`${settings.endpoint}/${path}`);
  const expected = `${new URL(settings.endpoint).pathname.replace(/\/$/, "")}/${path}`;
  if (url.pathname !== expected || !key.startsWith(settings.folder)) {
    throw new Error(`${key} isn't an object S3 storage can keep.`);
  }
  return url;
}
