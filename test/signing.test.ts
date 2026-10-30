import { describe, expect, it } from "vitest";
import {
  credentialsFrom,
  isPinnedPlace,
  keysFrom,
  MAX_BYTES,
  MAX_SIGNED,
  pinnedFrom,
  type SignedRequest,
  signInput,
  signRequests,
} from "../src/signing.js";

const settings = {
  service: "r2",
  location: "0123456789abcdef0123456789abcdef",
  ownAddress: true,
  publicRead: false,
  endpoint: "https://s3.eu-west-1.amazonaws.com",
  bucket: "parish-media",
  region: "eu-west-1",
  folder: "site/",
  publicUrl: "https://media.example.org",
};
const keys = {
  credentials: { accessKeyId: "KEY", secretAccessKey: "SECRET" },
  place: { bucket: "parish-media", folder: "site/" },
};

describe("signing", () => {
  it("signs each file's upload with its type, for an hour", async () => {
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/a%20b.jpg", type: "image/jpeg", size: 10 }] },
      settings,
      keys,
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
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect((put as SignedRequest).url).not.toContain("SECRET");
  });

  it("has each upload say anyone may read it, where the service needs that", async () => {
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg", size: 1 }] },
      { ...settings, publicRead: true },
      keys,
    );
    expect((put as SignedRequest).headers).toEqual({ "content-type": "image/jpeg", "x-amz-acl": "public-read" });
    expect(new URL((put as SignedRequest).url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;x-amz-acl",
    );
  });

  it("chooses each file's type by its address, whatever the browser says it is, and keeps only the media library's kinds", async () => {
    const [jpeg, svg] = await signRequests(
      {
        action: "upload",
        files: [
          { address: "/media/choir.JPG", type: "text/html", size: 1 },
          { address: "/media/logo.svg", type: "image/svg+xml", size: 1 },
        ],
      },
      settings,
      keys,
    );
    expect((jpeg as SignedRequest).headers).toEqual({ "content-type": "image/jpeg" });
    // An SVG opened on its own is downloaded, so a script in it never runs at the bucket's address.
    expect((svg as SignedRequest).headers).toEqual({
      "content-type": "image/svg+xml",
      "content-disposition": "attachment",
    });
    expect(new URL((svg as SignedRequest).url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-disposition;content-length;content-type;host",
    );
    for (const address of ["/media/page.html", "/media/code.js", "/media/README", "/media/.htaccess"]) {
      await expect(
        signRequests({ action: "upload", files: [{ address, type: "image/png", size: 1 }] }, settings, keys),
        address,
      ).rejects.toThrow(/isn't a kind of file/);
    }
  });

  it("signs nothing it wasn't made for", async () => {
    expect(() => signInput({ action: "list" })).toThrow();
    expect(() => signInput({ action: "upload", files: [{ address: 1 }] })).toThrow();
    expect(() =>
      signInput({ action: "remove", addresses: Array.from({ length: MAX_SIGNED + 1 }, () => "/media/a.jpg") }),
    ).toThrow();
    await expect(signRequests({ action: "remove", addresses: ["/media/../code.js"] }, settings, keys)).rejects.toThrow(
      /isn't a media address/,
    );
  });

  it("needs both keys", () => {
    expect(credentialsFrom({ S3_ACCESS_KEY_ID: "KEY" })).toBeUndefined();
    expect(credentialsFrom({ S3_ACCESS_KEY_ID: " KEY ", S3_SECRET_ACCESS_KEY: "S" })).toEqual({
      accessKeyId: "KEY",
      secretAccessKey: "S",
    });
  });

  it("signs each upload's size, and refuses one larger than the bucket takes", async () => {
    const [put] = await signRequests(
      { action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg", size: 1234 }] },
      settings,
      keys,
    );
    // Browsers send the size themselves, so it's signed, but not among the headers the frame sends.
    expect((put as SignedRequest).headers).toEqual({ "content-type": "image/jpeg" });
    expect(() => signInput({ action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg" }] })).toThrow();
    expect(() =>
      signInput({ action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg", size: -1 }] }),
    ).toThrow();
    expect(() =>
      signInput({ action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg", size: 1.5 }] }),
    ).toThrow();
    expect(() =>
      signInput({ action: "upload", files: [{ address: "/media/big.mp4", type: "video/mp4", size: MAX_BYTES + 1 }] }),
    ).toThrow(/big\.mp4 is larger than/);
  });

  it("signs only for the bucket and folder the site's secrets name, whatever the settings say", async () => {
    const check = { action: "check" };
    await expect(signRequests(check, settings, { ...keys, place: undefined })).rejects.toThrow(/add S3_BUCKET/);
    for (const place of [
      { bucket: "other-bucket", folder: "" },
      { bucket: "parish-media", folder: "elsewhere/" },
      { bucket: "parish-media", folder: "site/deeper/" },
    ]) {
      await expect(signRequests(check, settings, { ...keys, place }), JSON.stringify(place)).rejects.toThrow(
        /somewhere other than the bucket and folder/,
      );
    }
    // The settings may keep files in a folder under the one named.
    expect(
      await signRequests(check, settings, { ...keys, place: { bucket: "parish-media", folder: "" } }),
    ).toHaveLength(2);
    expect(isPinnedPlace({ ...settings, folder: "site/2026/" }, { bucket: "parish-media", folder: "site/" })).toBe(
      true,
    );
    expect(isPinnedPlace({ ...settings, folder: "" }, { bucket: "parish-media", folder: "site/" })).toBe(false);
  });

  it("reads the bucket's secret as a bucket's name and a folder", () => {
    expect(pinnedFrom({ S3_BUCKET: " parish-media " })).toEqual({ bucket: "parish-media", folder: "" });
    expect(pinnedFrom({ S3_BUCKET: "parish-media/site" })).toEqual({ bucket: "parish-media", folder: "site/" });
    expect(pinnedFrom({ S3_BUCKET: "/parish-media/site/2026/" })).toEqual({
      bucket: "parish-media",
      folder: "site/2026/",
    });
    for (const value of ["", "Parish_Media", "parish-media/../x/", "parish-media//x/", "parish-media/a b/"]) {
      expect(pinnedFrom({ S3_BUCKET: value }), value).toBeUndefined();
    }
    expect(keysFrom({ S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "parish-media" })).toEqual({
      credentials: { accessKeyId: "KEY", secretAccessKey: "SECRET" },
      place: { bucket: "parish-media", folder: "" },
    });
  });
});
