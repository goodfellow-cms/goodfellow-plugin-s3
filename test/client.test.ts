import { describe, expect, it } from "vitest";
import { checkStorage, deleteMedia, putMedia, StorageError } from "../src/client.js";
import { objectKey, objectUrl, type StorageSettings } from "../src/settings.js";
import { fakeS3 } from "./fake-s3.js";

const settings: StorageSettings = {
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "parish-media",
  region: "auto",
  folder: "site/",
  publicUrl: "https://media.example.org/site",
};
const credentials = { accessKeyId: "KEY", secretAccessKey: "SECRET" };

describe("the bucket", () => {
  it("keeps and removes files at their media addresses, signed with the editor's keys", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    await putMedia(
      settings,
      credentials,
      { address: "/media/sermon.mp4", type: "video/mp4", data: new Blob(["video"]) },
      s3.fetch,
    );
    expect(s3.requests[0]?.url).toBe("https://account.r2.cloudflarestorage.com/parish-media/site/sermon.mp4");
    expect(s3.objects.get("parish-media/site/sermon.mp4")?.type).toBe("video/mp4");
    expect(new TextDecoder().decode(s3.objects.get("parish-media/site/sermon.mp4")?.body)).toBe("video");
    await deleteMedia(settings, credentials, "/media/sermon.mp4", s3.fetch);
    expect(s3.objects.size).toBe(0);
    // A file that's already gone is removed too.
    await deleteMedia(settings, credentials, "/media/sermon.mp4", s3.fetch);
  });

  it("says what the bucket refused", async () => {
    const s3 = fakeS3({ keys: { KEY: "OTHER" } });
    const refused = putMedia(
      settings,
      credentials,
      { address: "/media/a.jpg", type: "image/jpeg", data: new Blob(["x"]) },
      s3.fetch,
    );
    await expect(refused).rejects.toThrow(StorageError);
    await expect(refused).rejects.toThrow(/403 SignatureDoesNotMatch.*put and delete files/);
  });

  it("says when the bucket can't be reached, such as without CORS settings", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(checkStorage(settings, credentials, failing)).rejects.toThrow(/CORS settings allow PUT and DELETE/);
  });

  it("tries the bucket with a file it removes again", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    await checkStorage(settings, credentials, s3.fetch);
    expect(s3.requests.map((request) => request.method)).toEqual(["PUT", "DELETE"]);
    expect(s3.objects.size).toBe(0);
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
