import { signRequest } from "../src/sigv4.js";

/**
 * An S3-compatible service in memory, as a `fetch`: it checks each request's
 * signature against the keys it knows, and keeps objects by bucket and key.
 */
export function fakeS3(options: { keys: Record<string, string>; region?: string }) {
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
    const match = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=(\w+)/.exec(
      headers.authorization ?? "",
    );
    const secret = match && options.keys[match[1] ?? ""];
    const error = (status: number, code: string) =>
      new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code} message</Message></Error>`, {
        status,
      });
    if (!match || !secret) return error(403, "InvalidAccessKeyId");
    const signedNames = (match[4] ?? "")
      .split(";")
      .filter((name) => !["host", "x-amz-date", "x-amz-content-sha256"].includes(name));
    const time = headers["x-amz-date"] ?? "";
    const date = new Date(
      `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}Z`,
    );
    const expected = await signRequest({
      method,
      url,
      headers: Object.fromEntries(signedNames.map((name) => [name, headers[name] ?? ""])),
      payloadHash: headers["x-amz-content-sha256"] ?? "",
      credentials: { accessKeyId: match[1] ?? "", secretAccessKey: secret },
      region: match[3] ?? "",
      date,
    });
    if (expected.authorization !== headers.authorization || match[3] !== (options.region ?? "auto")) {
      return error(403, "SignatureDoesNotMatch");
    }
    const key = decodeURIComponent(url.pathname.slice(1));
    if (method === "PUT") {
      const body = init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : new Uint8Array();
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
