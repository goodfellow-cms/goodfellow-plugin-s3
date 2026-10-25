/**
 * Putting and deleting the site's media in the bucket, signed with the
 * editor's keys. Requests come from the plugin's sandboxed frame, whose origin
 * is `null`, so the bucket's CORS settings must allow any origin (`*`).
 */
import { objectKey, objectUrl, type StorageSettings } from "./settings.js";
import { type Credentials, EMPTY_PAYLOAD, signRequest, UNSIGNED_PAYLOAD } from "./sigv4.js";

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
      ? " Check that your keys can put and delete files in this bucket."
      : response.status === 404
        ? " Check the bucket's name and the service's address."
        : "";
  return new StorageError(
    `The storage refused to ${what} (${response.status}${code ? ` ${code}` : ""}${said ? `: ${said}` : ""}).${advice}`,
    response.status,
    code,
  );
}

async function send(
  settings: StorageSettings,
  credentials: Credentials,
  request: { method: "PUT" | "DELETE"; key: string; body?: Blob; type?: string },
  what: string,
  fetcher: typeof fetch,
): Promise<void> {
  const url = objectUrl(settings, request.key);
  const headers = await signRequest({
    method: request.method,
    url,
    // The type's signed too, so the file is served as what it is.
    headers: request.type ? { "content-type": request.type } : {},
    payloadHash: request.body ? UNSIGNED_PAYLOAD : EMPTY_PAYLOAD,
    credentials,
    region: settings.region,
  });
  let response: Response;
  try {
    response = await fetcher(url, {
      method: request.method,
      headers,
      ...(request.body && { body: request.body }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new StorageError(
      `The storage at ${settings.endpoint} didn't answer. Check its address, and that the bucket's CORS settings allow PUT and DELETE from any origin.`,
    );
  }
  // Deleting a file that isn't there is done too.
  if (!response.ok && !(request.method === "DELETE" && response.status === 404)) throw await refusal(response, what);
}

/** Keeps a file at its media address, replacing any there. */
export function putMedia(
  settings: StorageSettings,
  credentials: Credentials,
  file: { address: string; type: string; data: Blob },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  return send(
    settings,
    credentials,
    {
      method: "PUT",
      key: objectKey(settings, file.address),
      body: file.data,
      type: file.type || "application/octet-stream",
    },
    `keep ${file.address}`,
    fetcher,
  );
}

/** Removes a file by its media address. */
export function deleteMedia(
  settings: StorageSettings,
  credentials: Credentials,
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  return send(
    settings,
    credentials,
    { method: "DELETE", key: objectKey(settings, address) },
    `remove ${address}`,
    fetcher,
  );
}

/** Puts a small file and deletes it again, to check the address, keys and CORS settings work together. */
export async function checkStorage(
  settings: StorageSettings,
  credentials: Credentials,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const key = `${settings.folder}.goodfellow-check`;
  await send(
    settings,
    credentials,
    { method: "PUT", key, body: new Blob(["ok"], { type: "text/plain" }), type: "text/plain" },
    "keep a test file",
    fetcher,
  );
  await send(settings, credentials, { method: "DELETE", key }, "remove the test file", fetcher);
}
