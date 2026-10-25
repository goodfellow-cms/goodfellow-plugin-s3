import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import admin, { checkBucket, reachable, signed } from "../src/admin.js";
import plugin, { KNOWN_SERVICES } from "../src/index.js";
import { MEDIA_STORAGE_FILE, SETTINGS_FILE, settingsText } from "../src/settings.js";
import sign from "../src/sign.js";
import type { PluginAdminApi } from "../src/types.js";
import { fakeS3 } from "./fake-s3.js";

const settings = {
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "parish-media",
  region: "auto",
  folder: "",
  publicUrl: "https://media.example.org",
};
const secrets = { S3_ACCESS_KEY_ID: "KEY", S3_SECRET_ACCESS_KEY: "SECRET" };

/**
 * The admin panel's side, as a plugin's frame sees it, with files in memory
 * and the `sign` task run as the site's CI would, in a folder of its own
 * holding the site's settings.
 */
async function fakeApi(
  files: Record<string, string>,
  options: { secrets?: Record<string, string>; server?: (body: string) => { status: number; body: string } } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "s3-site-"));
  await mkdir(join(root, "content"));
  if (files[SETTINGS_FILE]) await writeFile(join(root, SETTINGS_FILE), files[SETTINGS_FILE]);
  const tasks: unknown[] = [];
  const api: PluginAdminApi = {
    plugin: {
      name: plugin.name,
      title: plugin.title,
      id: plugin.name,
      permissions: plugin.permissions ?? {},
      ...(options.server && { server: true }),
    },
    siteUrl: "https://parish.example",
    read: async (paths) => Object.fromEntries(paths.map((path) => [path, files[path] ?? null])),
    publish: async () => ({ published: true }),
    navigate: () => {},
    server: async (_path, init) => {
      if (!options.server) throw new Error("S3 storage has no server here.");
      return options.server(init?.body ?? "");
    },
    task: async (id, input) => {
      expect(id).toBe("sign");
      tasks.push(input);
      // As the CI's answer comes back: plain data, through JSON.
      return JSON.parse(JSON.stringify(await sign(input, { root, secrets: options.secrets ?? secrets })));
    },
  };
  return { api, tasks, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const media = admin.media;
const configured = { [SETTINGS_FILE]: settingsText(settings) };
const cleanups: (() => Promise<void>)[] = [];

describe("media storage in the admin panel", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const site = async (...args: Parameters<typeof fakeApi>) => {
    const made = await fakeApi(...args);
    cleanups.push(made.cleanup);
    return made;
  };

  it("says what's missing before it takes files", async () => {
    expect(await media.ready((await site({})).api)).toEqual({
      ready: false,
      message: expect.stringContaining("set up"),
      screen: "settings",
    });
    expect(await media.ready((await site(configured)).api)).toEqual({ ready: true });
    const elsewhere = { [SETTINGS_FILE]: settingsText({ ...settings, endpoint: "https://minio.example.org" }) };
    expect(await media.ready((await site(elsewhere)).api)).toMatchObject({
      ready: false,
      message: expect.stringContaining("can't reach https://minio.example.org"),
    });
  });

  it("uploads a batch with one task, and removes files, never holding the keys", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    vi.stubGlobal("fetch", s3.fetch);
    const { api, tasks } = await site(configured);
    await media.upload(
      [
        { address: "/media/sermon.mp4", type: "video/mp4", size: 5, data: new Blob(["video"]) },
        { address: "/media/choir.jpg", type: "image/jpeg", size: 5, data: new Blob(["photo"]) },
      ],
      api,
    );
    expect([...s3.objects.keys()].sort()).toEqual(["parish-media/choir.jpg", "parish-media/sermon.mp4"]);
    expect(s3.objects.get("parish-media/sermon.mp4")?.type).toBe("video/mp4");
    expect(tasks).toEqual([
      {
        action: "upload",
        files: [
          { address: "/media/sermon.mp4", type: "video/mp4" },
          { address: "/media/choir.jpg", type: "image/jpeg" },
        ],
      },
    ]);
    // Nothing the browser sends carries the secret key.
    expect(s3.requests.every((request) => !request.url.includes("SECRET"))).toBe(true);
    await media.remove(["/media/sermon.mp4", "/media/choir.jpg"], api);
    expect(s3.objects.size).toBe(0);
    expect(tasks).toHaveLength(2);
  });

  it("says what the site's CI is missing, in words for the editor", async () => {
    const { api } = await site(configured, { secrets: {} });
    await expect(signed(api, { action: "check" })).rejects.toThrow(/S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    const unset = await site({});
    await expect(
      media.upload([{ address: "/media/a.jpg", type: "image/jpeg", size: 1, data: new Blob(["x"]) }], unset.api),
    ).rejects.toThrow(/set up/);
  });

  it("tries the bucket with a test file it removes again", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    const { api } = await site(configured);
    await checkBucket(api, s3.fetch);
    expect(s3.requests.map((request) => request.method)).toEqual(["PUT", "DELETE"]);
    expect(s3.objects.size).toBe(0);
  });

  it("uses a full-stack site's server where it has the keys, and the CI where it doesn't", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    let keys = true;
    const server = () =>
      keys ? { status: 200, body: JSON.stringify({ requests: [] }) } : { status: 404, body: '{"error":"no-keys"}' };
    const { api, tasks } = await site(configured, { server });
    expect(await signed(api, { action: "remove", addresses: [] })).toEqual([]);
    expect(tasks).toHaveLength(0);
    keys = false;
    await checkBucket(api, s3.fetch);
    expect(tasks).toEqual([{ action: "check" }]);
  });

  it("reaches only the services its permissions name", () => {
    expect(reachable("https://account.r2.cloudflarestorage.com", KNOWN_SERVICES)).toBe(true);
    expect(reachable("https://s3.eu-west-1.amazonaws.com", KNOWN_SERVICES)).toBe(true);
    expect(reachable("https://storage.googleapis.com", KNOWN_SERVICES)).toBe(true);
    expect(reachable("https://amazonaws.com.evil.example", KNOWN_SERVICES)).toBe(false);
    expect(reachable("http://account.r2.cloudflarestorage.com", KNOWN_SERVICES)).toBe(false);
  });
});

describe("the plugin", () => {
  it("asks for its settings, its keys in the site's secrets, and a task to sign with them", () => {
    expect(plugin.permissions?.files).toEqual([SETTINGS_FILE, MEDIA_STORAGE_FILE]);
    expect(plugin.permissions?.secrets).toEqual(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    expect(plugin.permissions?.read).toEqual([SETTINGS_FILE]);
    expect(plugin.tasks?.map((task) => [task.id, task.module])).toEqual([["sign", "goodfellow-plugin-s3/sign"]]);
    expect(plugin.server).toBe("goodfellow-plugin-s3/server");
    expect(plugin.mediaStorage?.maxBytes).toBe(5 * 1024 ** 3);
    expect(plugin.admin).toBe("goodfellow-plugin-s3/admin");
  });
});
