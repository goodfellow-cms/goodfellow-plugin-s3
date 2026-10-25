import { describe, expect, it } from "vitest";
import { credentialsFrom, MAX_SIGNED, type SignedRequest, signInput, signRequests } from "../src/signing.js";

const settings = {
  endpoint: "https://s3.eu-west-1.amazonaws.com",
  bucket: "parish-media",
  region: "eu-west-1",
  folder: "site/",
  publicUrl: "https://media.example.org",
};
const credentials = { accessKeyId: "KEY", secretAccessKey: "SECRET" };

describe("signing", () => {
  it("signs each file's upload with its type, for an hour", async () => {
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/a%20b.jpg", type: "image/jpeg" }] },
      settings,
      credentials,
      new Date("2026-10-25T10:00:00Z"),
    );
    expect(put).toMatchObject({
      method: "PUT",
      address: "/media/a%20b.jpg",
      headers: { "content-type": "image/jpeg" },
    });
    const url = new URL((put as SignedRequest).url);
    expect(url.pathname).toBe("/parish-media/site/a%20b.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect((put as SignedRequest).url).not.toContain("SECRET");
  });

  it("signs nothing it wasn't made for", async () => {
    expect(() => signInput({ action: "list" })).toThrow();
    expect(() => signInput({ action: "upload", files: [{ address: 1 }] })).toThrow();
    expect(() =>
      signInput({ action: "remove", addresses: Array.from({ length: MAX_SIGNED + 1 }, () => "/media/a.jpg") }),
    ).toThrow();
    await expect(
      signRequests({ action: "remove", addresses: ["/media/../code.js"] }, settings, credentials),
    ).rejects.toThrow(/isn't a media address/);
  });

  it("needs both keys", () => {
    expect(credentialsFrom({ S3_ACCESS_KEY_ID: "KEY" })).toBeUndefined();
    expect(credentialsFrom({ S3_ACCESS_KEY_ID: " KEY ", S3_SECRET_ACCESS_KEY: "S" })).toEqual({
      accessKeyId: "KEY",
      secretAccessKey: "S",
    });
  });
});
