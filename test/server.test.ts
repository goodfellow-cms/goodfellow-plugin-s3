import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { s3Server } from "../src/server.js";
import { MEDIA_STORAGE_FILE, SETTINGS_FILE, settingsText } from "../src/settings.js";
import { fakeS3 } from "./fake-s3.js";

const settings = {
  service: "r2",
  location: "0123456789abcdef0123456789abcdef",
  ownAddress: true,
  publicRead: false,
  endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  bucket: "parish-media",
  region: "auto",
  folder: "",
  publicUrl: "https://media.example.org",
};
const editor = { login: "alice", role: "editor" as const };

describe("the server module", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "s3-server-"));
    await mkdir(join(root, "content"));
    await writeFile(join(root, SETTINGS_FILE), settingsText(settings));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  const ask = (body: unknown) =>
    new Request("https://parish.example/api/goodfellow/plugins/goodfellow-plugin-s3/sign", {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("signs uploads straight away for editors, with the keys in the server's environment", async () => {
    const answer = s3Server({
      root,
      env: { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "parish-media" },
    });
    const response = await answer(ask({ action: "check" }), { path: "sign", editor });
    expect(response.status).toBe(200);
    const { requests } = (await response.json()) as {
      requests: { method: string; url: string; headers: Record<string, string> }[];
    };
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    const put = requests[0] as (typeof requests)[number];
    expect((await s3.fetch(put.url, { method: "PUT", headers: put.headers, body: new Blob(["ok"]) })).status).toBe(200);
    expect((await answer(ask({ action: "steal" }), { path: "sign", editor })).status).toBe(400);
  });

  it("signs deletes for the site's owners only, since editors can be limited to some of the site", async () => {
    const answer = s3Server({
      root,
      env: { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "parish-media" },
    });
    const remove = { action: "remove", addresses: ["/media/sermon.mp4"] };
    const refused = await answer(ask(remove), { path: "sign", editor });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "not-allowed", message: expect.stringMatching(/owners/) });
    const owner = { login: "olive", role: "owner" as const };
    expect((await answer(ask(remove), { path: "sign", editor: owner })).status).toBe(200);
    // Editors still upload.
    const upload = { action: "upload", files: [{ address: "/media/a.jpg", type: "image/jpeg", size: 1 }] };
    expect((await answer(ask(upload), { path: "sign", editor })).status).toBe(200);
  });

  it("signs replacing a file the bucket already keeps for owners only, since that deletes the file before", async () => {
    await writeFile(
      join(root, MEDIA_STORAGE_FILE),
      JSON.stringify({
        version: 1,
        plugin: "goodfellow-plugin-s3",
        url: "https://media.example.org",
        files: { "/media/sermon.mp4": { size: 10 } },
      }),
    );
    try {
      const answer = s3Server({
        root,
        env: { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "parish-media" },
      });
      const files = [
        { address: "/media/new.jpg", type: "image/jpeg", size: 1 },
        { address: "/media/sermon.mp4", type: "video/mp4", size: 1 },
      ];
      const refused = await answer(ask({ action: "upload", files }), { path: "sign", editor });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: "not-allowed",
        message: expect.stringMatching(/owners can replace.*\/media\/sermon\.mp4/),
      });
      const owner = { login: "olive", role: "owner" as const };
      expect((await answer(ask({ action: "upload", files }), { path: "sign", editor: owner })).status).toBe(200);
      // New files are still the editors' to upload.
      const fresh = { action: "upload", files: files.slice(0, 1) };
      expect((await answer(ask(fresh), { path: "sign", editor })).status).toBe(200);
    } finally {
      await rm(join(root, MEDIA_STORAGE_FILE), { force: true });
    }
  });

  it("signs nothing without the bucket its keys are for", async () => {
    const answer = s3Server({ root, env: { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET" } });
    const response = await answer(ask({ action: "check" }), { path: "sign", editor });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "not-signed", message: expect.stringMatching(/S3_BUCKET/) });
  });

  it("words only its own problems, never another error's message", async () => {
    const answer = s3Server({
      root,
      env: { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "parish-media" },
    });
    const broken = new Request("https://parish.example/api/goodfellow/plugins/goodfellow-plugin-s3/sign", {
      method: "POST",
      body: "{not json",
    });
    const response = await answer(broken, { path: "sign", editor });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not-signed", message: "S3 storage couldn't sign that request." });
    const refused = await answer(ask({ action: "delete-everything" }), { path: "sign", editor });
    expect(await refused.json()).toMatchObject({ message: "S3 storage was asked for something it doesn't sign." });
  });

  it("answers only signed-in editors, and leaves it to the CI without keys", async () => {
    const withKeys = s3Server({
      root,
      env: { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET", S3_BUCKET: "parish-media" },
    });
    expect((await withKeys(ask({ action: "check" }), { path: "sign", editor: null })).status).toBe(401);
    expect((await withKeys(ask({ action: "check" }), { path: "other", editor })).status).toBe(404);
    const without = s3Server({ root, env: {} });
    const response = await without(ask({ action: "check" }), { path: "sign", editor });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no-keys" });
  });
});
