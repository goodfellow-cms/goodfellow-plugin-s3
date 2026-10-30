/**
 * The plugin's admin module, which runs in its own sandboxed frame in the
 * admin panel: the settings screen, and the media storage the admin panel's
 * Media screen uploads through. The keys never reach the browser: the site's
 * CI signs each batch of requests with the keys in its secrets (the `sign`
 * task, about a minute), or a full-stack site's server does straight away,
 * and the frame sends files to the bucket at the signed addresses.
 */
import { isSignedFor, isSignedRequests, StorageError, sendSigned } from "./client.js";
import { isAnswer, type StorageService, servicesFrom } from "./services.js";
import {
  MEDIA_STORAGE_FILE,
  objectKey,
  parseSettings,
  parseStoredMedia,
  SETTINGS_FILE,
  type StorageSettings,
  type StoredMediaFile,
  settingsProblems,
  settingsText,
  storedMediaText,
  tidySettings,
} from "./settings.js";
import {
  BUCKET_SECRET,
  CHECK_BODY,
  CHECK_KEY,
  KEY_ID_SECRET,
  MAX_SIGNED,
  SECRET_KEY_SECRET,
  type SignedRequest,
  type SignInput,
} from "./signing.js";
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

/** The settings, or why the storage can't take files now, in words for the editor. */
async function readySettings(
  api: PluginAdminApi,
): Promise<StorageSettings | Exclude<PluginMediaReady, { ready: true }>> {
  const { settings } = await loadSite(api);
  if (!settings) return { ready: false, message: "Its bucket hasn't been set up yet.", screen: "settings" };
  if (!reachable(settings.endpoint, api.plugin.permissions.connect)) {
    return {
      ready: false,
      message: `The admin panel can't reach ${settings.endpoint}: a developer needs to add the service back to the plugin's services in the site's config.`,
      screen: "settings",
    };
  }
  return settings;
}

/** The settings, or throws, in words for the editor, where the storage can't take or remove files now. */
async function ready(api: PluginAdminApi): Promise<StorageSettings> {
  const settings = await readySettings(api);
  if ("ready" in settings) throw new StorageError(settings.message);
  return settings;
}

/** A signed request, once it's checked to go to the object it's for. */
function checked(
  request: SignedRequest | undefined,
  settings: StorageSettings,
  method: SignedRequest["method"],
  key: string,
  what: string,
): SignedRequest {
  if (!request || !isSignedFor(request, settings, method, key)) {
    throw new StorageError(`The ${what} wasn't signed for this bucket, so nothing was sent.`);
  }
  return request;
}

/** An answer's JSON, or `undefined` where it isn't any, such as a proxy's page. */
function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Has requests signed where the keys are: a full-stack site's server, where
 * it has them, straight away, or else the site's CI, through the `sign` task.
 * Only a server without the keys (404) leaves it to the CI: anything else it
 * answers is said, rather than costing each upload a minute without a word.
 */
export async function signed(api: PluginAdminApi, input: SignInput): Promise<SignedRequest[]> {
  if (api.plugin.server) {
    const answer = await api
      .server("sign", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } })
      .catch(() => undefined);
    if (!answer) throw new StorageError("The site's server couldn't be reached to sign the upload. Try again.");
    const body = parsed(answer.body);
    if (answer.status === 200) {
      if (isSignedRequests(body?.requests)) return body.requests;
      throw new StorageError("The site's server didn't answer with signed addresses for the upload.");
    }
    if (answer.status === 401) throw new StorageError("You've been signed out. Sign in again, then try again.");
    if (answer.status !== 404) {
      const message = body?.message;
      throw new StorageError(
        typeof message === "string"
          ? message
          : `The site's server didn't sign the upload (${answer.status}). A developer can find out why in its logs.`,
      );
    }
    // Without keys of its own, the server leaves it to the CI.
  }
  const requests = await api.task("sign", input);
  if (!isSignedRequests(requests)) throw new StorageError("The site's build service didn't sign the upload.");
  return requests;
}

/** Lists in pieces of at most `MAX_SIGNED`, as many as one request to sign may hold. */
function batches<T>(items: readonly T[]): T[][] {
  const pieces: T[][] = [];
  for (let start = 0; start < items.length; start += MAX_SIGNED) pieces.push(items.slice(start, start + MAX_SIGNED));
  return pieces;
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
  const settings = await ready(api);
  const asked = (file: PluginMediaFile) => ({
    address: file.address,
    type: file.type || "application/octet-stream",
    size: file.data.size,
  });
  const upload = (file: PluginMediaFile, request: SignedRequest | undefined) =>
    checked(request, settings, "PUT", objectKey(settings, file.address), `upload of ${file.address}`);
  // More files than one request to sign holds are signed, and sent, a batch at a time.
  for (const batch of batches(files)) {
    const requests = await signed(api, { action: "upload", files: batch.map(asked) });
    const byAddress = new Map(requests.map((request) => [request.address, request]));
    await eachLimited(batch, async (file) => {
      const request = upload(file, byAddress.get(file.address));
      // Tried again at a newly signed address, since a large upload may outlast the first.
      const resign = async () => upload(file, (await signed(api, { action: "upload", files: [asked(file)] }))[0]);
      await sendSigned(request, `keep ${file.address}`, file.data, fetcher, undefined, resign);
    });
  }
}

/** Removes files from the bucket by their media addresses. */
export async function removeFiles(
  api: PluginAdminApi,
  addresses: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (addresses.length === 0) return;
  const settings = await ready(api);
  const failed: string[] = [];
  for (const batch of batches(addresses)) {
    const requests = await signed(api, { action: "remove", addresses: batch });
    const byAddress = new Map(requests.map((request) => [request.address, request]));
    const removals = batch.map((address) =>
      checked(byAddress.get(address), settings, "DELETE", objectKey(settings, address), `removal of ${address}`),
    );
    await eachLimited(removals, async (request) => {
      await sendSigned(request, `remove ${request.address}`, undefined, fetcher).catch(() => {
        failed.push(request.address ?? "");
      });
    });
  }
  if (failed.length > 0) throw new StorageError(`The storage kept ${failed.join(", ")}.`);
}

/** Puts a small file and deletes it again, to try the settings, the site's keys and the bucket's CORS settings. */
export async function checkBucket(api: PluginAdminApi, fetcher: typeof fetch = fetch): Promise<void> {
  const settings = await ready(api);
  const [put, remove] = await signed(api, { action: "check" });
  const key = `${settings.folder}${CHECK_KEY}`;
  await sendSigned(
    checked(put, settings, "PUT", key, "test file"),
    "keep a test file",
    new Blob([CHECK_BODY], { type: "text/plain" }),
    fetcher,
  );
  await sendSigned(checked(remove, settings, "DELETE", key, "test file"), "remove the test file", undefined, fetcher);
}

/**
 * The CORS rules buckets need, for the plugin's frame, which has no origin of
 * its own: only the requests it makes, with only the headers it sends.
 * Pages show files with `<img>` and `<video>`, which need none.
 */
export const CORS_RULES = `[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "DELETE"],
    "AllowedHeaders": ["content-type", "content-disposition", "x-amz-acl"],
    "MaxAgeSeconds": 3600
  }
]`;

/** Whether two addresses are on the same host, by name. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** The value of the `S3_BUCKET` secret for settings: the bucket, and its folder after a slash. */
export function bucketSecretValue(settings: Pick<StorageSettings, "bucket" | "folder">): string {
  return `${settings.bucket}${settings.folder ? `/${settings.folder}` : ""}`;
}

/**
 * Why new settings would lose the site's stored files, or nothing: they must
 * stay at the same public address, in the same service, bucket and folder,
 * until they're moved back to the site.
 */
export function movesStoredFiles(
  saved: StorageSettings | undefined,
  next: StorageSettings,
  stored: StoredMediaFile | undefined,
  plugin: string,
): string | undefined {
  if (!stored || Object.keys(stored.files).length === 0) return undefined;
  if (stored.plugin !== plugin) {
    return "Another plugin keeps the site's media. Move it back to the site from the Media screen first.";
  }
  const moved =
    stored.url !== next.publicUrl ||
    (saved !== undefined &&
      (saved.endpoint !== next.endpoint || saved.bucket !== next.bucket || saved.folder !== next.folder));
  return moved
    ? "The site already keeps files in this bucket and folder. Move them back to the site from the Media screen before using another bucket, folder or public address."
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What's chosen on the screen, as settings, or what's wrong with it, in words for the owner. */
export function chosenSettings(
  service: StorageService | undefined,
  form: { location: string; bucket: string; folder: string; ownAddress: boolean; publicUrl: string },
  siteUrl?: string,
): StorageSettings | string {
  if (!service) return "Choose the service the bucket is in.";
  const location = form.location.trim();
  if (service.asks && !isAnswer(service.asks, location)) {
    return `${service.asks.label} should look like ${service.asks.example}. ${service.asks.hint}`;
  }
  const bucket = form.bucket.trim();
  const own = form.ownAddress || !service.publicUrl;
  const settings = tidySettings({
    service: service.id,
    location,
    ownAddress: own,
    publicRead: service.publicRead === true,
    endpoint: service.endpoint(location),
    bucket,
    region: service.signingRegion(location),
    folder: form.folder,
    publicUrl: own || !service.publicUrl ? form.publicUrl : service.publicUrl(bucket, location),
  });
  const problems = settingsProblems(settings);
  if (problems.includes("bucket")) return "Bucket names are 3 to 63 lowercase letters, digits, dots and dashes.";
  if (problems.includes("folder")) return "A folder is names separated by slashes, ending in one, such as media/.";
  if (problems.includes("publicUrl")) {
    return own
      ? "The public address should start with https://, such as https://media.example.org."
      : "The bucket's own address couldn't be worked out: give an address of your own.";
  }
  if (problems.length > 0) return "Those settings can't be used: check the service's details.";
  // Files at the site's own address could run there as the site's pages do, with the editors' sign-in.
  if (siteUrl && sameHost(settings.publicUrl, siteUrl)) {
    return "The public address needs a domain of its own, not the site's: use one such as media.example.org.";
  }
  // The bucket's own address, with the folder files go in.
  return own || !settings.folder
    ? settings
    : { ...settings, publicUrl: `${settings.publicUrl}/${settings.folder.replace(/\/$/, "")}` };
}

/** The settings screen: where files are kept, which publishes for the whole site, and where the keys go. */
async function settingsScreen(element: { ownerDocument: unknown }, api: PluginAdminApi) {
  const root = element as HTMLElement;
  const doc = root.ownerDocument;
  const services = servicesFrom(api.plugin.options);
  const site = await loadSite(api);
  const saved = site.settings;
  const inUse = site.stored?.plugin === api.plugin.name;

  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<Record<"text" | "id" | "className", string>> = {},
    ...children: (Node | string)[]
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (props.text !== undefined) node.textContent = props.text;
    if (props.id) node.id = props.id;
    if (props.className) node.className = props.className;
    node.append(...children);
    return node;
  };
  const labelled = (id: string, label: string, control: HTMLElement, hint?: HTMLElement | string) => {
    const wrapper = h("p");
    const labelNode = h("label", { text: label });
    labelNode.htmlFor = id;
    control.id = id;
    wrapper.append(labelNode, control);
    if (hint) {
      const hintNode = typeof hint === "string" ? h("small", { text: hint }) : hint;
      hintNode.id = `${id}-hint`;
      control.setAttribute("aria-describedby", hintNode.id);
      wrapper.append(hintNode);
    }
    return wrapper;
  };
  const input = (value = "") => {
    const node = h("input");
    node.value = value;
    node.autocomplete = "off";
    node.spellcheck = false;
    return node;
  };
  const button = (text: string) => {
    const node = h("button", { text });
    node.type = "button";
    return node;
  };
  const status = () => {
    const node = h("p");
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

  const heading = h("h1", { text: api.plugin.title });
  const intro = h("p", {
    text: "Keeps the site's media in a storage service instead of the site's own files, so large files such as long videos can be uploaded. Pages show each file from the storage, at the same address as before.",
  });

  // Where files are kept, for the whole site.
  const serviceSelect = h("select");
  serviceSelect.append(h("option", { text: "Choose a service" }));
  (serviceSelect.firstChild as HTMLOptionElement).value = "";
  for (const service of services) {
    const option = h("option", { text: service.name });
    option.value = service.id;
    serviceSelect.append(option);
  }
  serviceSelect.value = saved && services.some((service) => service.id === saved.service) ? saved.service : "";
  const location = input(saved?.location ?? "");
  const locationField = h("div");
  const bucket = input(saved?.bucket ?? "");
  const bucketHint = h("small");
  const ownAddress = h("input");
  ownAddress.type = "checkbox";
  ownAddress.checked = saved?.ownAddress === true;
  const publicUrl = input(saved?.ownAddress ? saved.publicUrl : "");
  const publicField = h("div");
  const folder = input(saved?.folder ?? "");

  const chosen = () => services.find((service) => service.id === serviceSelect.value);
  /** Shows only what the chosen service needs, with its own words for each. */
  const showService = () => {
    const service = chosen();
    locationField.replaceChildren();
    publicField.replaceChildren();
    bucketHint.textContent = service ? `The bucket's name, as you created it in ${service.name}.` : "";
    if (!service) return;
    if (service.asks) {
      location.placeholder = service.asks.example;
      locationField.append(labelled("location", service.asks.label, location, service.asks.hint));
    }
    const own = h("p");
    const ownLabel = h("label", { text: "Use an address of my own" });
    ownLabel.htmlFor = "own-address";
    ownAddress.id = "own-address";
    ownLabel.prepend(ownAddress);
    own.append(
      ownLabel,
      h("small", {
        text: " Only if the files are shown from somewhere else, such as a domain of your own connected to the bucket. Leave this off if you're not sure.",
        className: "gfa-hint",
      }),
    );
    const address = labelled(
      "public-url",
      "Public address",
      publicUrl,
      service.publicUrl
        ? `Where visitors' browsers get the files instead, such as https://media.example.org, once it's connected to the bucket in ${service.name}.`
        : service.publicHelp,
    );
    publicUrl.placeholder = "https://";
    if (service.publicUrl) {
      const shown = service.publicUrl(
        bucket.value.trim() || "<bucket>",
        location.value.trim() || service.asks?.example || "",
      );
      publicField.append(
        h("p", {
          text: `Visitors' browsers get the files from the bucket's own address, ${shown}, once the bucket lets anyone read them. ${service.publicHelp}`,
          className: "gfa-hint",
        }),
        own,
      );
      if (ownAddress.checked) publicField.append(address);
    } else {
      publicField.append(address);
    }
  };
  serviceSelect.addEventListener("change", () => {
    // A region from one service means nothing to another: start again, or with what's saved for this one.
    location.value = saved && saved.service === serviceSelect.value ? saved.location : "";
    showService();
    showKeys();
  });
  ownAddress.addEventListener("change", showService);
  bucket.addEventListener("change", showService);
  location.addEventListener("change", showService);

  const save = button(inUse ? "Save" : "Save and keep the site's media here");
  const saveStatus = status();
  run(save, saveStatus, async () => {
    const next = chosenSettings(
      chosen(),
      {
        location: location.value,
        bucket: bucket.value,
        folder: folder.value,
        ownAddress: ownAddress.checked,
        publicUrl: publicUrl.value,
      },
      api.siteUrl,
    );
    if (typeof next === "string") return next;
    // Anywhere other than where the site's files are kept would lose them.
    const current = await loadSite(api);
    const moves = movesStoredFiles(current.settings, next, current.stored, api.plugin.name);
    if (moves) return moves;
    const { stored } = current;
    const { published } = await api.publish(
      [
        { path: SETTINGS_FILE, text: settingsText(next) },
        { path: MEDIA_STORAGE_FILE, text: storedMediaText(api.plugin.name, next.publicUrl, stored) },
      ],
      "Keep the site's media in S3 storage",
    );
    return published ? "Saved. New uploads go to the bucket." : "Not saved.";
  });
  const more = h("details", {}, h("summary", { text: "More options" }));
  more.append(
    labelled(
      "folder",
      "Folder in the bucket (optional)",
      folder,
      "Such as media/, for a bucket shared with other things.",
    ),
  );
  more.open = Boolean(saved?.folder);
  const openMedia = button("Open the Media screen");
  openMedia.addEventListener("click", () => api.navigate("#/media"));
  const where = h(
    "section",
    {},
    h("h2", { text: "Where files are kept" }),
    labelled("service", "Storage service", serviceSelect),
    locationField,
    labelled("bucket", "Bucket", bucket, bucketHint),
    publicField,
    more,
    save,
    saveStatus,
    h("p", {
      text: inUse
        ? "The site keeps its media here. Files already in the site's own files can be moved here from the Media screen."
        : "Once saved, new uploads go to the bucket. Files already in the site's own files can then be moved there from the Media screen.",
    }),
    openMedia,
  );

  // The keys, which stay with the site's build service or server, and how to add them for this site.
  const keysBody = h("div");
  const helps = await api.secretsHelp().catch(() => []);
  const showKeys = () => {
    const service = chosen();
    keysBody.replaceChildren();
    keysBody.append(
      h("p", {
        text: `The bucket's keys never go into the admin panel: the site keeps them as ${KEY_ID_SECRET} and ${SECRET_KEY_SECRET}, and signs each upload with them. It also keeps ${BUCKET_SECRET}, the bucket and folder the keys are for, and signs nothing anywhere else, even if these settings change.`,
      }),
    );
    if (bucket.value.trim()) {
      const typed = folder.value.trim().replace(/^\/+/, "");
      const value = bucketSecretValue({
        bucket: bucket.value.trim(),
        folder: typed && !typed.endsWith("/") ? `${typed}/` : typed,
      });
      keysBody.append(
        h("p", { text: `For these settings, ${BUCKET_SECRET} is:` }),
        h("pre", {}, h("code", { text: value })),
      );
    }
    if (service) {
      keysBody.append(
        h("h3", { text: `1. Make the keys in ${service.name}` }),
        h("p", { text: `${service.keysHelp} Use keys that can only put and delete files in this bucket.` }),
      );
    }
    if (helps.length === 0) {
      keysBody.append(
        h("p", {
          text: "This site's setup can't run plugins' tasks yet, so there's nowhere to add them. A developer needs to copy the starter's plugin-task setup into the site first.",
        }),
      );
      return;
    }
    helps.forEach((help, index) => {
      const number = service ? `${index + 2}. ` : "";
      const lead = index > 0 ? "Or: " : "";
      keysBody.append(h("h3", { text: `${number}${lead}${help.title}` }));
      const steps = h("ol");
      for (const step of help.steps) {
        const item = h("li", { text: step.text });
        if (step.code) item.append(h("pre", {}, h("code", { text: step.code })));
        steps.append(item);
      }
      keysBody.append(steps);
      if (help.link) {
        const link = h("a", { text: help.link.label });
        const url = help.link.url;
        link.href = url;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          api.openSecretsLink(url);
        });
        keysBody.append(h("p", {}, link));
      }
      for (const note of help.notes) keysBody.append(h("small", { text: note }));
    });
  };
  const cors = h("details", {}, h("summary", { text: "Let the admin panel upload to the bucket" }));
  const corsText = h("p");
  cors.append(corsText, h("pre", {}, h("code", { text: CORS_RULES })));
  cors.addEventListener("toggle", () => {
    corsText.textContent = chosen()?.corsHelp ?? "The bucket's CORS settings need to allow uploads from any origin:";
  });
  const check = button("Try the bucket");
  const checkStatus = status();
  run(check, checkStatus, async () => {
    checkStatus.textContent = "Trying the bucket… This takes about a minute.";
    await checkBucket(api);
    return "The bucket took a test file and removed it again: uploads will work.";
  });
  const keys = h(
    "section",
    {},
    h("h2", { text: "The bucket's keys" }),
    keysBody,
    cors,
    h("p", {
      text: "Once the keys are added and the settings saved, try the bucket: it puts a small file there and removes it again.",
    }),
    check,
    checkStatus,
  );

  bucket.addEventListener("change", showKeys);
  folder.addEventListener("change", showKeys);
  showService();
  showKeys();
  root.append(heading, intro, where, keys);
}

export default {
  screens: { settings: settingsScreen },
  media: {
    async ready(api) {
      const settings = await readySettings(api);
      return "ready" in settings ? settings : { ready: true };
    },
    upload: (files, api) => uploadFiles(api, files),
    remove: (addresses, api) => removeFiles(api, addresses),
  },
} satisfies PluginAdmin;
