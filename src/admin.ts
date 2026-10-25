/**
 * The plugin's admin module, which runs in its own sandboxed frame in the
 * admin panel: the settings screen, and the media storage the admin panel's
 * Media screen uploads through. Requests go straight from the frame to the
 * bucket, signed with the editor's own keys, which the admin panel keeps for
 * the plugin in the editor's browser.
 */
import { checkStorage, deleteMedia, putMedia, StorageError } from "./client.js";
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
import type { Credentials } from "./sigv4.js";
import type { PluginAdmin, PluginAdminApi, PluginMediaReady } from "./types.js";

const KEY_ID = "accessKeyId";
const SECRET = "secretAccessKey";

/** The settings and Goodfellow's list of stored media, as the site has them. */
async function loadSite(api: PluginAdminApi): Promise<{ settings?: StorageSettings; stored?: StoredMediaFile }> {
  const files = await api.read([SETTINGS_FILE, MEDIA_STORAGE_FILE]);
  const settings = parseSettings(files[SETTINGS_FILE]);
  const stored = parseStoredMedia(files[MEDIA_STORAGE_FILE]);
  return { ...(settings && { settings }), ...(stored && { stored }) };
}

/** The editor's keys, where they've given both. */
export async function editorCredentials(api: PluginAdminApi): Promise<Credentials | undefined> {
  const keys = await api.keys.get();
  const accessKeyId = keys?.[KEY_ID]?.trim();
  const secretAccessKey = keys?.[SECRET]?.trim();
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
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
  if (!(await editorCredentials(api))) {
    return {
      ready: false,
      message: "Give your keys for the bucket in its settings first. Each editor uses their own.",
      screen: "settings",
    };
  }
  return undefined;
}

/** The settings and keys an upload or removal needs, or why there are none. */
async function ready(api: PluginAdminApi): Promise<{ settings: StorageSettings; credentials: Credentials }> {
  const problem = await notReady(api);
  if (problem) throw new StorageError(problem.message);
  const { settings } = await loadSite(api);
  const credentials = await editorCredentials(api);
  if (!settings || !credentials) throw new StorageError("S3 storage isn't set up.");
  return { settings, credentials };
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

/** The settings screen: where files are kept, which publishes for the whole site, and the editor's own keys. */
async function settingsScreen(element: { ownerDocument: unknown }, api: PluginAdminApi) {
  const root = element as HTMLElement;
  const doc = root.ownerDocument;
  const site = await loadSite(api);
  const keys = await api.keys.get();

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

  // The editor's own keys, kept in their browser.
  const yours = create("section");
  const yoursHeading = create("h2", "Your keys");
  const yoursIntro = create(
    "p",
    "Each editor who uploads gives their own keys, which stay in their browser and are forgotten when they sign out. Use keys that can only put and delete files in this bucket.",
  );
  const keyId = field("access-key-id", "Access key ID", keys?.[KEY_ID] ?? "");
  const secret = field("secret-access-key", "Secret access key", keys?.[SECRET] ?? "", undefined, "password");
  const rememberWrapper = create("p");
  const remember = create("input");
  remember.type = "checkbox";
  remember.id = "remember";
  const rememberLabel = create("label", " Remember them on this computer");
  rememberLabel.htmlFor = "remember";
  rememberWrapper.append(remember, rememberLabel);
  const saveKeys = button("Save your keys");
  const forgetKeys = button("Forget your keys");
  const check = button("Try the bucket");
  const keysStatus = status();
  run(saveKeys, keysStatus, async () => {
    const accessKeyId = keyId.input.value.trim();
    const secretAccessKey = secret.input.value.trim();
    if (!accessKeyId || !secretAccessKey) return "Give both the access key ID and the secret access key.";
    await api.keys.set({ [KEY_ID]: accessKeyId, [SECRET]: secretAccessKey }, { remember: remember.checked });
    return "Your keys are saved in this browser.";
  });
  run(forgetKeys, keysStatus, async () => {
    await api.keys.set(null);
    keyId.input.value = "";
    secret.input.value = "";
    return "Your keys are forgotten.";
  });
  run(check, keysStatus, async () => {
    const { settings: saved, credentials } = await ready(api);
    await checkStorage(saved, credentials);
    return "The bucket took a test file and removed it again: uploads will work.";
  });
  yours.append(
    yoursHeading,
    yoursIntro,
    keyId.wrapper,
    secret.wrapper,
    rememberWrapper,
    saveKeys,
    forgetKeys,
    check,
    keysStatus,
  );

  root.append(heading, intro, where, yours);
}

export default {
  screens: { settings: settingsScreen },
  media: {
    async ready(api) {
      return (await notReady(api)) ?? { ready: true };
    },
    async upload(file, api) {
      const { settings, credentials } = await ready(api);
      await putMedia(settings, credentials, file);
    },
    async remove(addresses, api) {
      const { settings, credentials } = await ready(api);
      const failed: string[] = [];
      for (const address of addresses) {
        await deleteMedia(settings, credentials, address).catch(() => failed.push(address));
      }
      if (failed.length > 0) throw new StorageError(`The storage kept ${failed.join(", ")}.`);
    },
  },
} satisfies PluginAdmin;
