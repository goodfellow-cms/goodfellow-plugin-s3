/**
 * The parts of Goodfellow's plugin format this plugin uses, as
 * `@goodfellow-cms/core` declares them (`GoodfellowPlugin`, `PluginAdmin` and
 * `PluginAdminApi`), so the package needs none of Goodfellow's code: a site
 * gives it everything at run time.
 */

export interface PluginPermissions {
  connect?: string[];
  files?: string[];
}

export interface GoodfellowPlugin {
  name: string;
  title: string;
  version?: string;
  description?: string;
  permissions?: PluginPermissions;
  admin?: string;
  screens?: { id: string; title: string }[];
  mediaStorage?: { maxBytes?: number };
}

export interface PluginDescription {
  name: string;
  title: string;
  id: string;
  permissions: PluginPermissions;
}

export type PluginFileChange = { path: string; text: string } | { path: string; delete: true };

export interface PluginAdminApi {
  plugin: PluginDescription;
  siteUrl: string;
  read(paths: string[]): Promise<Record<string, string | null>>;
  publish(changes: PluginFileChange[], message: string): Promise<{ published: boolean }>;
  navigate(href: string): void;
  keys: {
    get(): Promise<Record<string, string> | null>;
    set(keys: Record<string, string> | null, options?: { remember?: boolean }): Promise<void>;
  };
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
    upload(file: PluginMediaFile, api: PluginAdminApi): Promise<void>;
    remove(addresses: string[], api: PluginAdminApi): Promise<void>;
  };
}
