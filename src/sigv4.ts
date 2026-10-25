/**
 * AWS Signature Version 4, as every S3-compatible service checks it, with Web
 * Crypto, which Node and browsers both have. Uploads are signed with
 * `UNSIGNED-PAYLOAD`, which S3 accepts over HTTPS, so a long video is sent as
 * it's read rather than hashed first.
 */

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignOptions {
  method: string;
  url: URL;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`, which are added. */
  headers?: Record<string, string>;
  /** The payload's SHA-256 in hex, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  credentials: Credentials;
  region: string;
  service?: string;
  date?: Date;
}

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** The SHA-256 of nothing, for requests without a body. */
export const EMPTY_PAYLOAD = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text) as Uint8Array<ArrayBuffer>;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(text));
}

/** RFC 3986 encoding, as SigV4 wants it: everything but unreserved characters, and `/` kept in paths. */
export function uriEncode(text: string, keepSlash: boolean): string {
  return [...encoder.encode(text)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) return char;
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([name, value]) => [uriEncode(name, false), uriEncode(value, false)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** `20130524T000000Z`. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * The headers that sign a request: the ones given, with `x-amz-date`,
 * `x-amz-content-sha256` and `authorization` added. Browsers set `host`
 * themselves, from the address, which is what's signed.
 */
export async function signRequest(options: SignOptions): Promise<Record<string, string>> {
  const { method, url, payloadHash, credentials, region } = options;
  const service = options.service ?? "s3";
  const timestamp = amzDate(options.date ?? new Date());
  const day = timestamp.slice(0, 8);
  const given = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const signed: Record<string, string> = {
    ...given,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };
  const names = Object.keys(signed).sort();
  const canonicalRequest = [
    method.toUpperCase(),
    // The path as the service receives it: already encoded once by the URL.
    uriEncode(decodeURIComponent(url.pathname), true),
    canonicalQuery(url),
    ...names.map((name) => `${name}:${signed[name]}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(bytes(`AWS4${credentials.secretAccessKey}`), day);
  for (const part of [region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  const { host: _host, ...headers } = signed;
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export interface PresignOptions {
  method: string;
  url: URL;
  /** Headers the request must send with these values, besides `host`, such as `content-type`. */
  headers?: Record<string, string>;
  credentials: Credentials;
  region: string;
  /** How long the address works for, in seconds: at most a week, as S3 allows. */
  expires: number;
  service?: string;
  date?: Date;
}

/**
 * An address that makes one request without the keys: SigV4 in the query
 * string, as S3's presigned URLs are. Whoever has it can make that request
 * until it expires, so it's given only to the editor who asked.
 */
export async function presignUrl(options: PresignOptions): Promise<string> {
  const { method, credentials, region, expires } = options;
  const service = options.service ?? "s3";
  const timestamp = amzDate(options.date ?? new Date());
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const signed: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value.trim()]),
    ),
    host: options.url.host,
  };
  const names = Object.keys(signed).sort();
  const url = new URL(options.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", timestamp);
  url.searchParams.set("X-Amz-Expires", String(Math.min(Math.max(1, Math.floor(expires)), 604800)));
  url.searchParams.set("X-Amz-SignedHeaders", names.join(";"));
  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(decodeURIComponent(url.pathname), true),
    canonicalQuery(url),
    ...names.map((name) => `${name}:${signed[name]}`),
    "",
    names.join(";"),
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  let key = await hmac(bytes(`AWS4${credentials.secretAccessKey}`), day);
  for (const part of [region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  // In the canonical query's own encoding, so the address sent is the one signed.
  return `${url.origin}${url.pathname}?${canonicalQuery(url)}&X-Amz-Signature=${signature}`;
}
