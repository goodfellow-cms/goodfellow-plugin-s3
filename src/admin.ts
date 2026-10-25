/**
 * The plugin's admin module, which runs in its own sandboxed frame in the
 * admin panel: the settings screen, and the media storage the admin panel's
 * Media screen uploads through. The keys never reach the browser: the site's
 * CI signs each batch of requests with the keys in its secrets (the `sign`
 * task, about a minute), or a full-stack site's server does straight away,
 * and the frame sends files to the bucket at the signed addresses.
 */
import { isSignedRequests, StorageError, sendSigned } from "./client.js";
import {
  MEDIA_STORAGE_FILE,
  parseSettings,
  parseStoredMedia,
  SETTINGS_FILE,
  type SettingsProblem,
  type StorageSettings,
  type StoredMediaFile,
  settingsProblems,
  settingsText,
  storedMediaText,
  tidySettings,
} from "./settings.js";
import { KEY_ID_SECRET, SECRET_KEY_SECRET, type SignedRequest, type SignInput } from "./signing.js";
import type { PluginAdmin, PluginAdminApi, PluginMediaFile, PluginMediaReady } from "./types.js";

/** How many files go to the bucket at once. */
const PARALLEL = 3;

/** The settings and Goodfellow's list of stored media, as the site has them. */
async function loadSite(api: PluginAdminApi): Promise<{ settings?: StorageSettings; stored?: StoredMediaFile }> {
  const files = await api.read([SETTINGS_FILE, MEDIA_STORAGE_FILE]);
  const settings = parseSettings(files[SETTINGS_FILE]);
  const stored = parseStoredMedia(files[MEDIA_STORAGE_FILE]);
  return { ...(settings && { settings }), ...(stored && { stored }) };
}

/** Whether the plugin's frame may reach an address: its Content Security Policy allows only what it declared. */
export function reachable(endpoint: string, connect: readonly string[] = []): boolean {
  let host: string;
  let protocol: string;
  try {
    ({ host, protocol } = new URL(endpoint));
  } catch {
    return false;
  }
  return connect.some((allowed) => {
    const match = /^(https?:)\/\/(\*\.)?(.+)$/.exec(allowed);
    if (!match || match[1] !== protocol) return false;
    const [, , wildcard, rest = ""] = match;
    return wildcard ? host.endsWith(`.${rest}`) : host === rest;
  });
}

/** Why the storage can't take files now, in words for the editor, or nothing when it can. */
async function notReady(api: PluginAdminApi): Promise<Exclude<PluginMediaReady, { ready: true }> | undefined> {
  const { settings } = await loadSite(api);
  if (!settings) return { ready: false, message: "Its bucket hasn't been set up yet.", screen: "settings" };
  if (!reachable(settings.endpoint, api.plugin.permissions.connect)) {
    return {
      ready: false,
      message: `The admin panel can't reach ${settings.endpoint}: a developer needs to add it to the plugin's addresses in the site's config.`,
      screen: "settings",
    };
  }
  return undefined;
}

/** Throws, in words for the editor, where the storage can't take or remove files now. */
async function ready(api: PluginAdminApi): Promise<void> {
  const problem = await notReady(api);
  if (problem) throw new StorageError(problem.message);
}

/**
 * Has requests signed where the keys are: a full-stack site's server, where
 * it has them, straight away, or else the site's CI, through the `sign` task.
 */
export async function signed(api: PluginAdminApi, input: SignInput): Promise<SignedRequest[]> {
  if (api.plugin.server) {
    const answer = await api
      .server("sign", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } })
      .catch(() => undefined);
    if (answer?.status === 200) {
      const { requests } = JSON.parse(answer.body) as { requests?: unknown };
      if (isSignedRequests(requests)) return requests;
    }
    if (answer?.status === 400) {
      const { message } = JSON.parse(answer.body) as { message?: unknown };
      throw new StorageError(typeof message === "string" ? message : "The site's server didn't sign the upload.");
    }
    // Without keys of its own, the server leaves it to the CI.
  }
  const requests = await api.task("sign", input);
  if (!isSignedRequests(requests)) throw new StorageError("The site's build service didn't sign the upload.");
  return requests;
}

/** Runs `send` for each item, a few at a time, stopping at the first that fails. */
async function eachLimited<T>(items: readonly T[], send: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await send(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

/** Keeps files in the bucket at their media addresses, signed together. */
export async function uploadFiles(
  api: PluginAdminApi,
  files: readonly PluginMediaFile[],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (files.length === 0) return;
  await ready(api);
  const requests = await signed(api, {
    action: "upload",
    files: files.map(({ address, type }) => ({ address, type: type || "application/octet-stream" })),
  });
  const byAddress = new Map(requests.map((request) => [request.address, request]));
  await eachLimited(files, async (file) => {
    const request = byAddress.get(file.address);
    if (request?.method !== "PUT") throw new StorageError(`The upload of ${file.address} wasn't signed.`);
    await sendSigned(request, `keep ${file.address}`, file.data, fetcher);
  });
}

/** Removes files from the bucket by their media addresses. */
export async function removeFiles(
  api: PluginAdminApi,
  addresses: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (addresses.length === 0) return;
  await ready(api);
  const requests = await signed(api, { action: "remove", addresses: [...addresses] });
  const failed: string[] = [];
  await eachLimited(requests, async (request) => {
    await sendSigned(request, `remove ${request.address}`, undefined, fetcher).catch(() => {
      failed.push(request.address ?? "");
    });
  });
  if (failed.length > 0) throw new StorageError(`The storage kept ${failed.join(", ")}.`);
}

/** Puts a small file and deletes it again, to try the settings, the site's keys and the bucket's CORS settings. */
export async function checkBucket(api: PluginAdminApi, fetcher: typeof fetch = fetch): Promise<void> {
  await ready(api);
  const [put, remove] = await signed(api, { action: "check" });
  if (put?.method !== "PUT" || remove?.method !== "DELETE") throw new StorageError("The test file wasn't signed.");
  await sendSigned(put, "keep a test file", new Blob(["ok"], { type: "text/plain" }), fetcher);
  await sendSigned(remove, "remove the test file", undefined, fetcher);
}

const FIELD_LABELS: Record<SettingsProblem, string> = {
  endpoint: "The service's address should start with https://, such as https://s3.eu-west-1.amazonaws.com.",
  bucket: "Bucket names are 3 to 63 lowercase letters, digits, dots and dashes.",
  region: "Regions are lowercase letters, digits and dashes, such as eu-west-1, or auto for Cloudflare R2.",
  folder: "A folder is names separated by slashes, ending in one, such as media/.",
  publicUrl: "The public address should start with https://, with no ? or #.",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The settings screen: where files are kept, which publishes for the whole site, and where the keys go. */
async function settingsScreen(element: { ownerDocument: unknown }, api: PluginAdminApi) {
  const root = element as HTMLElement;
  const doc = root.ownerDocument;
  const site = await loadSite(api);

  const create = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const field = (id: string, label: string, value: string, hint?: string, type = "text") => {
    const wrapper = create("p");
    const labelNode = create("label", label);
    labelNode.htmlFor = id;
    const input = create("input");
    input.id = id;
    input.type = type;
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    wrapper.append(labelNode, create("br"), input);
    if (hint) {
      const hintNode = create("small", hint);
      hintNode.id = `${id}-hint`;
      input.setAttribute("aria-describedby", hintNode.id);
      wrapper.append(create("br"), hintNode);
    }
    return { wrapper, input };
  };
  const button = (text: string) => {
    const node = create("button", text);
    node.type = "button";
    return node;
  };
  const status = () => {
    const node = create("p");
    node.setAttribute("role", "status");
    return node;
  };
  const run = (node: HTMLButtonElement, out: HTMLElement, action: () => Promise<string>) => {
    node.addEventListener("click", () => {
      node.disabled = true;
      out.textContent = "";
      action()
        .then(
          (message) => {
            out.textContent = message;
          },
          (error: unknown) => {
            out.textContent = errorText(error);
          },
        )
        .finally(() => {
          node.disabled = false;
        });
    });
  };

  const settings = site.settings;
  const inUse = site.stored?.plugin === api.plugin.name;

  const heading = create("h1", api.plugin.title);
  const intro = create(
    "p",
    "Keeps the site's media in a bucket of an S3-compatible service, such as Amazon S3, Cloudflare R2 or Backblaze B2, instead of the site's own files, so large files such as long videos can be uploaded. Pages show the files from the bucket's public address, at the same /media/ addresses as before.",
  );

  // Where files are kept, for the whole site.
  const where = create("section");
  const whereHeading = create("h2", "Where files are kept");
  const endpoint = field(
    "endpoint",
    "Service address",
    settings?.endpoint ?? "",
    "Such as https://s3.eu-west-1.amazonaws.com, or https://<account id>.r2.cloudflarestorage.com for Cloudflare R2.",
  );
  const bucket = field("bucket", "Bucket", settings?.bucket ?? "");
  const region = field("region", "Region", settings?.region ?? "auto", "Such as eu-west-1, or auto for Cloudflare R2.");
  const folder = field(
    "folder",
    "Folder in the bucket (optional)",
    settings?.folder ?? "",
    "Such as media/, for a bucket shared with other things.",
  );
  const publicUrl = field(
    "public-url",
    "Public address",
    settings?.publicUrl ?? "",
    "Where visitors' browsers get the files, the folder included, such as https://media.example.org.",
  );
  const save = button(inUse ? "Save" : "Save and keep the site's media here");
  const saveStatus = status();
  const using = create(
    "p",
    inUse
      ? "The site keeps its media here. Files already in the site's own files can be moved here from the Media screen."
      : "Once saved, new uploads go to the bucket. Files already in the site's own files can then be moved there from the Media screen.",
  );
  const openMedia = button("Open the Media screen");
  openMedia.addEventListener("click", () => api.navigate("#/media"));
  run(save, saveStatus, async () => {
    const next = tidySettings({
      endpoint: endpoint.input.value,
      bucket: bucket.input.value,
      region: region.input.value,
      folder: folder.input.value,
      publicUrl: publicUrl.input.value,
    });
    const problems = settingsProblems(next);
    if (problems.length > 0) return problems.map((problem) => FIELD_LABELS[problem]).join(" ");
    const { stored } = await loadSite(api);
    if (stored && stored.plugin !== api.plugin.name && Object.keys(stored.files).length > 0) {
      return "Another plugin keeps the site's media. Move it back to the site from the Media screen first.";
    }
    // A bucket other than the one keeping the site's files would lose them.
    if (
      stored &&
      stored.plugin === api.plugin.name &&
      Object.keys(stored.files).length > 0 &&
      stored.url !== next.publicUrl
    ) {
      return "The site already keeps files at another public address. Move them back to the site from the Media screen before using another bucket, or keep the same public address.";
    }
    const { published } = await api.publish(
      [
        { path: SETTINGS_FILE, text: settingsText(next) },
        { path: MEDIA_STORAGE_FILE, text: storedMediaText(api.plugin.name, next.publicUrl, stored) },
      ],
      "Keep the site's media in S3 storage",
    );
    return published ? "Saved. New uploads go to the bucket." : "Not saved.";
  });
  where.append(
    whereHeading,
    endpoint.wrapper,
    bucket.wrapper,
    region.wrapper,
    folder.wrapper,
    publicUrl.wrapper,
    save,
    saveStatus,
    using,
    openMedia,
  );

  // The keys, which stay with the site's CI or server.
  const keys = create("section");
  const keysHeading = create("h2", "The bucket's keys");
  const keysIntro = create(
    "p",
    `The keys never go into the admin panel. A developer adds them to the site's secrets as ${KEY_ID_SECRET} and ${SECRET_KEY_SECRET}: on GitHub under the repository's Settings → Secrets and variables → Actions, or on GitLab under Settings → CI/CD → Variables, masked. Each upload is then signed by the site's build service, which takes about a minute. On a site with a server of its own, they can go in the server's environment instead, which signs uploads straight away. Use keys that can only put and delete files in this bucket.`,
  );
  const check = button("Try the bucket");
  const checkStatus = status();
  run(check, checkStatus, async () => {
    checkStatus.textContent = "Trying the bucket… This takes about a minute.";
    await checkBucket(api);
    return "The bucket took a test file and removed it again: uploads will work.";
  });
  keys.append(keysHeading, keysIntro, check, checkStatus);

  root.append(heading, intro, where, keys);
}

export default {
  screens: { settings: settingsScreen },
  media: {
    async ready(api) {
      return (await notReady(api)) ?? { ready: true };
    },
    upload: (files, api) => uploadFiles(api, files),
    remove: (addresses, api) => removeFiles(api, addresses),
  },
} satisfies PluginAdmin;
