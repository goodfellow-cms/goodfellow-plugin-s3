import { describe, expect, it } from "vitest";
import { isSignedRequests, StorageError, sendSigned } from "../src/client.js";
import { objectKey, objectUrl, type StorageSettings } from "../src/settings.js";
import { type SignedRequest, signRequests } from "../src/signing.js";
import { fakeS3 } from "./fake-s3.js";

const settings: StorageSettings = {
  service: "r2",
  location: "0123456789abcdef0123456789abcdef",
  ownAddress: true,
  publicRead: false,
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "parish-media",
  region: "auto",
  folder: "site/",
  publicUrl: "https://media.example.org/site",
};
const credentials = { accessKeyId: "KEY", secretAccessKey: "SECRET" };

describe("the bucket", () => {
  it("keeps and removes files at their signed addresses", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/sermon.mp4", type: "video/mp4" }] },
      settings,
      credentials,
    );
    await sendSigned(put as SignedRequest, "keep it", new Blob(["video"]), s3.fetch);
    expect(s3.requests[0]?.url).toMatch(
      /^https:\/\/account\.r2\.cloudflarestorage\.com\/parish-media\/site\/sermon\.mp4\?/,
    );
    expect(s3.objects.get("parish-media/site/sermon.mp4")?.type).toBe("video/mp4");
    expect(new TextDecoder().decode(s3.objects.get("parish-media/site/sermon.mp4")?.body)).toBe("video");
    const [remove] = await signRequests({ action: "remove", addresses: ["/media/sermon.mp4"] }, settings, credentials);
    await sendSigned(remove as SignedRequest, "remove it", undefined, s3.fetch);
    expect(s3.objects.size).toBe(0);
    // A file that's already gone is removed too.
    await sendSigned(remove as SignedRequest, "remove it", undefined, s3.fetch);
  });

  it("says what the bucket refused, such as an upload of another type than was signed", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg" }] },
      settings,
      credentials,
    );
    const refused = sendSigned(
      { ...(put as SignedRequest), headers: { "content-type": "text/html" } },
      "keep a.jpg",
      new Blob(["x"]),
      s3.fetch,
    );
    await expect(refused).rejects.toThrow(StorageError);
    await expect(refused).rejects.toThrow(/403 SignatureDoesNotMatch.*put and delete files/);
  });

  it("refuses addresses once they've expired", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" }, now: () => new Date("2026-10-25T12:00:00Z") });
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg" }] },
      settings,
      credentials,
      new Date("2026-10-25T10:00:00Z"),
    );
    await expect(sendSigned(put as SignedRequest, "keep a.jpg", new Blob(["x"]), s3.fetch)).rejects.toThrow(
      /403 AccessDenied/,
    );
  });

  it("says when the bucket can't be reached, such as without CORS settings", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const [put] = await signRequests({ action: "check" }, settings, credentials);
    await expect(sendSigned(put as SignedRequest, "keep a test file", new Blob(["ok"]), failing)).rejects.toThrow(
      /CORS settings allow PUT and DELETE/,
    );
  });

  it("takes only signed requests from the task or the server", () => {
    expect(isSignedRequests([{ method: "PUT", url: "https://bucket.example/a", headers: {} }])).toBe(true);
    expect(isSignedRequests([{ method: "GET", url: "https://bucket.example/a", headers: {} }])).toBe(false);
    expect(isSignedRequests([{ method: "PUT", url: "javascript:alert(1)", headers: {} }])).toBe(false);
    expect(isSignedRequests({})).toBe(false);
  });

  it("keeps only media addresses, in the site's folder", () => {
    expect(objectKey(settings, "/media/2024/choir.jpg")).toBe("site/2024/choir.jpg");
    expect(() => objectKey(settings, "/media/../secrets")).toThrow();
    expect(() => objectKey(settings, "/about")).toThrow();
    expect(objectUrl({ ...settings, folder: "" }, "a b.jpg").href).toBe(
      "https://account.r2.cloudflarestorage.com/parish-media/a%20b.jpg",
    );
  });
});
