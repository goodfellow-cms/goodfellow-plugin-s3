/**
 * The plugin's admin module, which runs in its own sandboxed frame in the
 * admin panel: the settings screen, and the media storage the admin panel's
 * Media screen uploads through. The keys never reach the browser: the site's
 * CI signs each batch of requests with the keys in its secrets (the `sign`
 * task, about a minute), or a full-stack site's server does straight away,
 * and the frame sends files to the bucket at the signed addresses.
 */
import { isSignedRequests, StorageError, sendSigned } from "./client.js";
import { isAnswer, type StorageService, servicesFrom } from "./services.js";
import {
  MEDIA_STORAGE_FILE,
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
      message: `The admin panel can't reach ${settings.endpoint}: a developer needs to add the service back to the plugin's services in the site's config.`,
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
    // What the server refused, it refused: the CI isn't asked instead.
    if (answer?.status === 400 || answer?.status === 403) {
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

/** The CORS rules buckets need, for the plugin's frame, which has no origin of its own. */
const CORS_RULES = `[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "DELETE", "GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What's chosen on the screen, as settings, or what's wrong with it, in words for the owner. */
export function chosenSettings(
  service: StorageService | undefined,
  form: { location: string; bucket: string; folder: string; ownAddress: boolean; publicUrl: string },
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
    const next = chosenSettings(chosen(), {
      location: location.value,
      bucket: bucket.value,
      folder: folder.value,
      ownAddress: ownAddress.checked,
      publicUrl: publicUrl.value,
    });
    if (typeof next === "string") return next;
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
        text: `The bucket's keys never go into the admin panel: the site keeps them as ${KEY_ID_SECRET} and ${SECRET_KEY_SECRET}, and signs each upload with them.`,
      }),
    );
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

  showService();
  showKeys();
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
