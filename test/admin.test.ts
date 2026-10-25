import { afterEach, describe, expect, it, vi } from "vitest";
import admin, { editorCredentials, reachable } from "../src/admin.js";
import plugin, { KNOWN_SERVICES } from "../src/index.js";
import { MEDIA_STORAGE_FILE, SETTINGS_FILE, settingsText } from "../src/settings.js";
import type { PluginAdminApi } from "../src/types.js";
import { fakeS3 } from "./fake-s3.js";

const settings = {
  endpoint: "https://account.r2.cloudflarestorage.com",
  bucket: "parish-media",
  region: "auto",
  folder: "",
  publicUrl: "https://media.example.org",
};

/** The admin panel's side, as a plugin's frame sees it, with files and keys in memory. */
function fakeApi(files: Record<string, string>, keys: Record<string, string> | null = null): PluginAdminApi {
  let kept = keys;
  return {
    plugin: { name: plugin.name, title: plugin.title, id: plugin.name, permissions: plugin.permissions ?? {} },
    siteUrl: "https://parish.example",
    read: async (paths) => Object.fromEntries(paths.map((path) => [path, files[path] ?? null])),
    publish: async () => ({ published: true }),
    navigate: () => {},
    keys: {
      get: async () => kept,
      set: async (next) => {
        kept = next;
      },
    },
  };
}

const media = admin.media;

describe("media storage in the admin panel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says what's missing before it takes files", async () => {
    expect(await media.ready(fakeApi({}))).toEqual({
      ready: false,
      message: expect.stringContaining("set up"),
      screen: "settings",
    });
    const configured = { [SETTINGS_FILE]: settingsText(settings) };
    expect(await media.ready(fakeApi(configured))).toMatchObject({
      ready: false,
      message: expect.stringContaining("keys"),
    });
    expect(await media.ready(fakeApi(configured, { accessKeyId: "KEY", secretAccessKey: "SECRET" }))).toEqual({
      ready: true,
    });
    const elsewhere = { [SETTINGS_FILE]: settingsText({ ...settings, endpoint: "https://minio.example.org" }) };
    expect(await media.ready(fakeApi(elsewhere, { accessKeyId: "KEY", secretAccessKey: "SECRET" }))).toMatchObject({
      ready: false,
      message: expect.stringContaining("can't reach https://minio.example.org"),
    });
  });

  it("uploads and removes files with the editor's keys", async () => {
    const s3 = fakeS3({ keys: { KEY: "SECRET" } });
    vi.stubGlobal("fetch", s3.fetch);
    const api = fakeApi({ [SETTINGS_FILE]: settingsText(settings) }, { accessKeyId: "KEY", secretAccessKey: "SECRET" });
    await media.upload({ address: "/media/sermon.mp4", type: "video/mp4", size: 5, data: new Blob(["video"]) }, api);
    expect([...s3.objects.keys()]).toEqual(["parish-media/sermon.mp4"]);
    await media.remove(["/media/sermon.mp4"], api);
    expect(s3.objects.size).toBe(0);
    await expect(
      media.upload({ address: "/media/a.jpg", type: "image/jpeg", size: 1, data: new Blob(["x"]) }, fakeApi({})),
    ).rejects.toThrow(/set up/);
  });

  it("reads the editor's keys only where both are given", async () => {
    expect(await editorCredentials(fakeApi({}, { accessKeyId: "KEY" }))).toBeUndefined();
    expect(await editorCredentials(fakeApi({}, { accessKeyId: " KEY ", secretAccessKey: "S" }))).toEqual({
      accessKeyId: "KEY",
      secretAccessKey: "S",
    });
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
  it("asks for its settings and Goodfellow's list of stored media, and says it keeps media", () => {
    expect(plugin.permissions?.files).toEqual([SETTINGS_FILE, MEDIA_STORAGE_FILE]);
    expect(plugin.mediaStorage?.maxBytes).toBe(5 * 1024 ** 3);
    expect(plugin.admin).toBe("goodfellow-plugin-s3/admin");
  });
});
