/**
 * Signing the browser's requests to the bucket, where the keys are: in the
 * site's CI, through the plugin's `sign` task, or on a full-stack site's
 * server. The browser gets an address for each request, which works for
 * an hour and for that request alone, and never the keys.
 */
import { objectKey, objectUrl, type StorageSettings } from "./settings.js";
import { type Credentials, presignUrl } from "./sigv4.js";

/**
 * The secrets the keys are kept in: the site's GitHub Actions secrets, GitLab
 * CI/CD variables, Bitbucket Pipelines variables or server's environment.
 */
export const KEY_ID_SECRET = "S3_ACCESS_KEY_ID";
export const SECRET_KEY_SECRET = "S3_SECRET_ACCESS_KEY";
/**
 * The bucket the keys may be used for, with the site's folder in it where it
 * has one (`parish-media` or `parish-media/site/`). Editors can change the
 * settings file, so without it they could point the keys at any bucket the
 * keys reach, and delete what's there; the signer signs only for this one.
 */
export const BUCKET_SECRET = "S3_BUCKET";

/**
 * As large a file as the admin panel sends, in one upload: S3 takes up to
 * 5 GiB in one, and Cloudflare R2 5 MiB less.
 */
export const MAX_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;

/** How long a signed address works for, in seconds: long enough for a large file to start uploading. */
export const SIGNED_SECONDS = 3600;
/** At most this many files are signed at once. */
export const MAX_SIGNED = 100;

/** What the admin module asks to have signed. */
export type SignInput =
  /** Each file's size is signed, so the bucket takes only a file of that size. */
  | { action: "upload"; files: { address: string; type: string; size: number }[] }
  | { action: "remove"; addresses: string[] }
  /** A small file to put and delete again, to try the settings, keys and the bucket's CORS settings together. */
  | { action: "check" };

/**
 * A request the browser makes, at a signed address, with these headers. A
 * PUT's `content-length` is signed too, but not among them, since browsers
 * send it themselves, from the body.
 */
export interface SignedRequest {
  method: "PUT" | "DELETE";
  /** The media address it's for; none for the check's file. */
  address?: string;
  url: string;
  headers: Record<string, string>;
}

/** The check's file's contents, whose size its signature names. */
export const CHECK_BODY = "ok";

/**
 * The type each kind of file the bucket keeps is served as, by its address's
 * extension: the kinds Goodfellow's media library takes (core's
 * `mediaKind()`), none of which runs code where it's served. The signer
 * chooses the type rather than taking the browser's word for it, since anyone
 * who can ask for a signature could ask for `text/html`.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  vtt: "text/vtt",
};

/** The type a media address is kept as, by its extension, or `undefined` for a kind the bucket doesn't keep. */
export function contentTypeOf(address: string): string | undefined {
  const name = address.slice(address.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** The address of the check's file in the bucket, which no media address can be. */
export const CHECK_KEY = ".goodfellow-check";

/** The keys, from the secrets the task or server was given, or nothing without both. */
export function credentialsFrom(secrets: Record<string, string | undefined>): Credentials | undefined {
  const accessKeyId = secrets[KEY_ID_SECRET]?.trim();
  const secretAccessKey = secrets[SECRET_KEY_SECRET]?.trim();
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

/** Where the keys may be used: a bucket, and a folder in it, or `""` for the whole bucket. */
export interface PinnedPlace {
  bucket: string;
  folder: string;
}

/** The place `BUCKET_SECRET` names, or nothing without it, or where it isn't a bucket's name and folder. */
export function pinnedFrom(secrets: Record<string, string | undefined>): PinnedPlace | undefined {
  const value = secrets[BUCKET_SECRET]?.trim().replace(/^\/+/, "");
  if (!value) return undefined;
  const slash = value.indexOf("/");
  const bucket = slash < 0 ? value : value.slice(0, slash);
  const rest = slash < 0 ? "" : value.slice(slash + 1);
  const folder = rest && !rest.endsWith("/") ? `${rest}/` : rest;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return undefined;
  if (folder && !/^([\w.~-]+\/)+$/.test(folder)) return undefined;
  if (folder.split("/").some((part) => part === "." || part === "..")) return undefined;
  return { bucket, folder };
}

/** What signing needs from the secrets: the keys and the place they're for. */
export interface SigningKeys {
  credentials: Credentials | undefined;
  place: PinnedPlace | undefined;
}

/** The keys and their place, from the secrets the task or server was given. */
export function keysFrom(secrets: Record<string, string | undefined>): SigningKeys {
  return { credentials: credentialsFrom(secrets), place: pinnedFrom(secrets) };
}

/** Whether settings keep files where the secrets say the keys may be used: the same bucket, in the folder or under it. */
export function isPinnedPlace(settings: StorageSettings, place: PinnedPlace): boolean {
  return settings.bucket === place.bucket && settings.folder.startsWith(place.folder);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The input as asked, checked, since anyone who can run the task can send anything. */
export function signInput(value: unknown): SignInput {
  const input = (value ?? {}) as Record<string, unknown>;
  if (input.action === "check") return { action: "check" };
  if (input.action === "remove" && strings(input.addresses) && input.addresses.length <= MAX_SIGNED) {
    return { action: "remove", addresses: input.addresses };
  }
  if (
    input.action === "upload" &&
    Array.isArray(input.files) &&
    input.files.length <= MAX_SIGNED &&
    input.files.every(
      (file) =>
        typeof file?.address === "string" &&
        (file.type === undefined || typeof file.type === "string") &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0,
    )
  ) {
    const files = input.files as { address: string; type?: string; size: number }[];
    const large = files.find((file) => file.size > MAX_BYTES);
    if (large) throw new Error(`${large.address} is larger than S3 storage takes in one upload.`);
    return {
      action: "upload",
      files: files.map(({ address, type, size }) => ({ address, type: type || "application/octet-stream", size })),
    };
  }
  throw new Error("S3 storage was asked for something it doesn't sign.");
}

/** Signs what the admin module asked for. Throws, in words for the editor, when it can't. */
export async function signRequests(
  input: unknown,
  settings: StorageSettings | undefined,
  keys: SigningKeys,
  date: Date = new Date(),
): Promise<SignedRequest[]> {
  const asked = signInput(input);
  if (!settings) throw new Error("S3 storage isn't set up yet: save its settings first.");
  const { credentials, place } = keys;
  if (!credentials) {
    throw new Error(
      `The site has no keys for the bucket. A developer needs to add ${KEY_ID_SECRET} and ${SECRET_KEY_SECRET} to its secrets.`,
    );
  }
  if (!place) {
    throw new Error(
      `The site doesn't say which bucket its keys are for. A developer needs to add ${BUCKET_SECRET} to its secrets: the bucket's name, with the folder after a slash where the settings have one.`,
    );
  }
  if (!isPinnedPlace(settings, place)) {
    throw new Error(
      `The settings keep files somewhere other than the bucket and folder the site's ${BUCKET_SECRET} secret names, so nothing was signed. Change the settings back, or have a developer change the secret.`,
    );
  }
  const sign = async (
    method: SignedRequest["method"],
    key: string,
    headers: Record<string, string> = {},
    size?: number,
  ): Promise<SignedRequest> => ({
    method,
    url: await presignUrl({
      method,
      url: objectUrl(settings, key),
      headers: size === undefined ? headers : { ...headers, "content-length": String(size) },
      credentials,
      region: settings.region,
      expires: SIGNED_SECONDS,
      date,
    }),
    headers,
  });
  if (asked.action === "check") {
    const key = `${settings.folder}${CHECK_KEY}`;
    return [await sign("PUT", key, { "content-type": "text/plain" }, CHECK_BODY.length), await sign("DELETE", key)];
  }
  if (asked.action === "remove") {
    return Promise.all(
      asked.addresses.map(async (address) => ({ ...(await sign("DELETE", objectKey(settings, address))), address })),
    );
  }
  // The type's signed too, chosen by the address, so the file is served as what its name says, and on services
  // without bucket-wide settings, that anyone may read it.
  const readable: Record<string, string> = settings.publicRead ? { "x-amz-acl": "public-read" } : {};
  return Promise.all(
    asked.files.map(async ({ address, size }) => {
      const key = objectKey(settings, address);
      const type = contentTypeOf(address);
      if (!type) throw new Error(`${address} isn't a kind of file S3 storage keeps.`);
      // An SVG can hold a script, which runs where it's opened on its own: it's downloaded instead, and still
      // shows in pages' images. The admin panel cleans SVGs first, but a signed address takes whatever is sent.
      const opened: Record<string, string> = type === "image/svg+xml" ? { "content-disposition": "attachment" } : {};
      return { ...(await sign("PUT", key, { "content-type": type, ...opened, ...readable }, size)), address };
    }),
  );
}
