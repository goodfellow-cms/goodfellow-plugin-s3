/**
 * Putting and deleting the site's media in the bucket, at addresses signed
 * where the keys are (`signing.ts`). Requests come from the plugin's
 * sandboxed frame, whose origin is `null`, so the bucket's CORS settings must
 * allow PUT and DELETE from any origin (`*`).
 */
import { objectUrl, type StorageSettings } from "./settings.js";
import type { SignedRequest } from "./signing.js";

/** The bucket refused a request, or couldn't be reached, with what it said in words for the editor. */
export class StorageError extends Error {
  override name = "StorageError";
  constructor(
    message: string,
    /** The HTTP status, or none when the bucket couldn't be reached. */
    readonly status?: number,
    /** S3's error code, such as `AccessDenied`. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** What a failed answer says, from S3's XML error. */
async function refusal(response: Response, what: string): Promise<StorageError> {
  const text = await response.text().catch(() => "");
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  const said = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
  const advice =
    response.status === 403
      ? " Check that the site's keys can put and delete files in this bucket."
      : response.status === 404
        ? " Check the bucket's name and the service's address."
        : "";
  return new StorageError(
    `The storage refused to ${what} (${response.status}${code ? ` ${code}` : ""}${said ? `: ${said}` : ""}).${advice}`,
    response.status,
    code,
  );
}

/** How many times a request is tried where the connection dropped or the storage was briefly unavailable. */
export const ATTEMPTS = 3;

/** Answers that mean the storage couldn't take the request just then, which S3 asks to be tried again. */
const TRY_AGAIN = [500, 502, 503, 504];

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Makes a signed request, with a file's contents for a PUT. A request whose
 * connection dropped, as a large upload's can, or that the storage was too
 * busy for, is tried again, up to `ATTEMPTS` times, waiting a little longer
 * each time, since putting or deleting the same file twice does the same as
 * once. Its address works for an hour, which a large upload that dropped
 * may have used up, so where `resign` is given each try after the first
 * has the request signed again.
 */
export async function sendSigned(
  first: SignedRequest,
  what: string,
  body?: Blob,
  fetcher: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = pause,
  resign?: () => Promise<SignedRequest>,
): Promise<void> {
  let request = first;
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1 && resign) request = await resign();
    let response: Response | undefined;
    try {
      response = await fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        ...(body && { body }),
        cache: "no-store",
        credentials: "omit",
      });
    } catch {
      response = undefined;
    }
    // Deleting a file that isn't there is done too.
    if (response && (response.ok || (request.method === "DELETE" && response.status === 404))) return;
    if (attempt >= ATTEMPTS || (response && !TRY_AGAIN.includes(response.status))) {
      if (response) throw await refusal(response, what);
      throw new StorageError(
        `The storage at ${new URL(request.url).origin} didn't answer. Check its address, and that the bucket's CORS settings allow PUT and DELETE from any origin.`,
      );
    }
    await wait(1000 * 2 ** (attempt - 1));
  }
}

/** The headers a signed request may have the browser send. */
const SENT_HEADERS = new Set(["content-type", "content-disposition", "x-amz-acl"]);

/** Whether an answer is a list of signed requests, as the task and the server module give them. */
export function isSignedRequests(value: unknown): value is SignedRequest[] {
  return (
    Array.isArray(value) &&
    value.every(
      (request) =>
        (request?.method === "PUT" || request?.method === "DELETE") &&
        typeof request.url === "string" &&
        /^https?:\/\//.test(request.url) &&
        typeof request.headers === "object" &&
        request.headers !== null &&
        Object.entries(request.headers).every(
          ([name, header]) => SENT_HEADERS.has(name.toLowerCase()) && typeof header === "string",
        ),
    )
  );
}

/**
 * Whether a signed request goes where the settings keep the object: the
 * method asked for, at the service's address, in the bucket, at the key,
 * with nothing in its address but the signature's own query. Signing
 * happens in the site's CI or on its server, so the frame checks what comes
 * back before sending a file anywhere.
 */
export function isSignedFor(
  request: SignedRequest,
  settings: StorageSettings,
  method: SignedRequest["method"],
  key: string,
): boolean {
  if (request.method !== method) return false;
  let url: URL;
  let expected: URL;
  try {
    url = new URL(request.url);
    expected = objectUrl(settings, key);
  } catch {
    return false;
  }
  return (
    url.origin === expected.origin &&
    url.pathname === expected.pathname &&
    !url.username &&
    !url.password &&
    !url.hash &&
    [...url.searchParams.keys()].every((name) => name.startsWith("X-Amz-"))
  );
}
