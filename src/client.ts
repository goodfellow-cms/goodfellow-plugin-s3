/**
 * Putting and deleting the site's media in the bucket, at addresses signed
 * where the keys are (`signing.ts`). Requests come from the plugin's
 * sandboxed frame, whose origin is `null`, so the bucket's CORS settings must
 * allow PUT and DELETE from any origin (`*`).
 */
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

/** Makes a signed request, with a file's contents for a PUT. */
export async function sendSigned(
  request: SignedRequest,
  what: string,
  body?: Blob,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      ...(body && { body }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new StorageError(
      `The storage at ${new URL(request.url).origin} didn't answer. Check its address, and that the bucket's CORS settings allow PUT and DELETE from any origin.`,
    );
  }
  // Deleting a file that isn't there is done too.
  if (!response.ok && !(request.method === "DELETE" && response.status === 404)) throw await refusal(response, what);
}

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
        request.headers !== null,
    )
  );
}
