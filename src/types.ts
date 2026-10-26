/**
 * The parts of Goodfellow's plugin format this plugin uses, as
 * `@goodfellow-cms/core` declares them (`GoodfellowPlugin`, `PluginAdmin` and
 * `PluginAdminApi`), so the package needs none of Goodfellow's code: a site
 * gives it everything at run time.
 */

export interface PluginPermissions {
  connect?: string[];
  files?: string[];
  secrets?: string[];
  read?: string[];
}

export interface GoodfellowPlugin {
  name: string;
  title: string;
  version?: string;
  description?: string;
  permissions?: PluginPermissions;
  admin?: string;
  screens?: { id: string; title: string }[];
  tasks?: { id: string; module: string; title?: string }[];
  server?: string;
  mediaStorage?: { maxBytes?: number };
  options?: { [key: string]: unknown };
}

/** What a task gets besides its input. */
export interface PluginTaskContext {
  root: string;
  secrets: Record<string, string>;
}

/** What a server module is told about a request. */
export interface PluginServerContext {
  path: string;
  editor: { login: string; role: "owner" | "editor" } | null;
}

export interface PluginDescription {
  name: string;
  title: string;
  id: string;
  permissions: PluginPermissions;
  /** Whether it has a server module, on a full-stack site. */
  server?: boolean;
  /** What the site's config chose for it. */
  options?: { [key: string]: unknown };
}

export type PluginFileChange = { path: string; text: string } | { path: string; delete: true };

export interface PluginAdminApi {
  plugin: PluginDescription;
  siteUrl: string;
  read(paths: string[]): Promise<Record<string, string | null>>;
  publish(changes: PluginFileChange[], message: string): Promise<{ published: boolean }>;
  navigate(href: string): void;
  server(
    path: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: string }>;
  task(id: string, input?: unknown): Promise<unknown>;
  secretsHelp(): Promise<PluginSecretsHelp[]>;
  openSecretsLink(url: string): void;
}

/** How to add the secrets the plugin declared, for this site, in the admin panel's words. */
export interface PluginSecretsHelp {
  where: "development" | "server" | "github" | "gitlab" | "bitbucket";
  title: string;
  link?: { url: string; label: string };
  steps: { text: string; code?: string }[];
  notes: string[];
}

export interface PluginMediaFile {
  address: string;
  type: string;
  size: number;
  data: Blob;
}

export type PluginMediaReady = { ready: true } | { ready: false; message: string; screen?: string };

export interface PluginAdmin {
  screens?: Record<string, (element: { ownerDocument: unknown }, api: PluginAdminApi) => unknown>;
  media?: {
    ready(api: PluginAdminApi): Promise<PluginMediaReady>;
    upload(files: PluginMediaFile[], api: PluginAdminApi): Promise<void>;
    remove(addresses: string[], api: PluginAdminApi): Promise<void>;
  };
}
