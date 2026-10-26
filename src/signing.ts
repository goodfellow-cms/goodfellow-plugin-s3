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

/** How long a signed address works for, in seconds: long enough for a large file to start uploading. */
export const SIGNED_SECONDS = 3600;
/** At most this many files are signed at once. */
export const MAX_SIGNED = 100;

/** What the admin module asks to have signed. */
export type SignInput =
  | { action: "upload"; files: { address: string; type: string }[] }
  | { action: "remove"; addresses: string[] }
  /** A small file to put and delete again, to try the settings, keys and the bucket's CORS settings together. */
  | { action: "check" };

/** A request the browser makes, at a signed address, with these headers. */
export interface SignedRequest {
  method: "PUT" | "DELETE";
  /** The media address it's for; none for the check's file. */
  address?: string;
  url: string;
  headers: Record<string, string>;
}

/** The address of the check's file in the bucket, which no media address can be. */
export const CHECK_KEY = ".goodfellow-check";

/** The keys, from the secrets the task or server was given, or nothing without both. */
export function credentialsFrom(secrets: Record<string, string | undefined>): Credentials | undefined {
  const accessKeyId = secrets[KEY_ID_SECRET]?.trim();
  const secretAccessKey = secrets[SECRET_KEY_SECRET]?.trim();
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
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
      (file) => typeof file?.address === "string" && (file.type === undefined || typeof file.type === "string"),
    )
  ) {
    const files = input.files as { address: string; type?: string }[];
    return {
      action: "upload",
      files: files.map(({ address, type }) => ({ address, type: type || "application/octet-stream" })),
    };
  }
  throw new Error("S3 storage was asked for something it doesn't sign.");
}

/** Signs what the admin module asked for. Throws, in words for the editor, when it can't. */
export async function signRequests(
  input: unknown,
  settings: StorageSettings | undefined,
  credentials: Credentials | undefined,
  date: Date = new Date(),
): Promise<SignedRequest[]> {
  const asked = signInput(input);
  if (!settings) throw new Error("S3 storage isn't set up yet: save its settings first.");
  if (!credentials) {
    throw new Error(
      `The site has no keys for the bucket. A developer needs to add ${KEY_ID_SECRET} and ${SECRET_KEY_SECRET} to its secrets.`,
    );
  }
  const sign = async (method: SignedRequest["method"], key: string, headers: Record<string, string> = {}) => ({
    method,
    url: await presignUrl({
      method,
      url: objectUrl(settings, key),
      headers,
      credentials,
      region: settings.region,
      expires: SIGNED_SECONDS,
      date,
    }),
    headers,
  });
  if (asked.action === "check") {
    const key = `${settings.folder}${CHECK_KEY}`;
    return [await sign("PUT", key, { "content-type": "text/plain" }), await sign("DELETE", key)];
  }
  if (asked.action === "remove") {
    return Promise.all(
      asked.addresses.map(async (address) => ({ ...(await sign("DELETE", objectKey(settings, address))), address })),
    );
  }
  // The type's signed too, so the file is served as what it is, and on services without bucket-wide
  // settings, that anyone may read it.
  const readable: Record<string, string> = settings.publicRead ? { "x-amz-acl": "public-read" } : {};
  return Promise.all(
    asked.files.map(async ({ address, type }) => ({
      ...(await sign("PUT", objectKey(settings, address), { "content-type": type, ...readable })),
      address,
    })),
  );
}
