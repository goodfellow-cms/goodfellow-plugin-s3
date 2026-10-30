import { presignUrl } from "../src/sigv4.js";

/**
 * An S3-compatible service in memory, as a `fetch`: it checks each request's
 * presigned address against the keys it knows, as S3 does (the signature,
 * the signed headers' values, the body's size where it's signed, and that it
 * hasn't expired), and keeps objects
 * by bucket and key.
 */
export function fakeS3(options: { keys: Record<string, string>; region?: string; now?: () => Date }) {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const requests: { method: string; url: string }[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    requests.push({ method, url: url.href });
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    const error = (status: number, code: string) =>
      new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code} message</Message></Error>`, {
        status,
      });
    const query = url.searchParams;
    const [keyId = "", day, region = ""] = (query.get("X-Amz-Credential") ?? "").split("/");
    const secret = options.keys[keyId];
    if (!secret || !day) return error(403, "InvalidAccessKeyId");
    const time = query.get("X-Amz-Date") ?? "";
    const date = new Date(
      `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}Z`,
    );
    const expires = Number(query.get("X-Amz-Expires"));
    if ((options.now?.() ?? new Date()).getTime() > date.getTime() + expires * 1000) {
      return error(403, "AccessDenied");
    }
    // Browsers send a body's size themselves, which S3 checks where it's signed.
    const body = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : new Uint8Array();
    if (method === "PUT") headers["content-length"] = String(body.byteLength);
    const signedNames = (query.get("X-Amz-SignedHeaders") ?? "").split(";").filter((name) => name !== "host");
    const unsigned = new URL(url);
    for (const name of [...unsigned.searchParams.keys()]) {
      if (name.startsWith("X-Amz-")) unsigned.searchParams.delete(name);
    }
    const expected = await presignUrl({
      method,
      url: unsigned,
      headers: Object.fromEntries(signedNames.map((name) => [name, headers[name] ?? ""])),
      credentials: { accessKeyId: keyId, secretAccessKey: secret },
      region,
      expires,
      date,
    });
    if (expected !== url.href || region !== (options.region ?? "auto")) return error(403, "SignatureDoesNotMatch");
    const key = decodeURIComponent(url.pathname.slice(1));
    if (method === "PUT") {
      objects.set(key, { body, type: headers["content-type"] ?? "" });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return error(405, "MethodNotAllowed");
  };
  return { fetch: fetch as typeof globalThis.fetch, objects, requests };
}
