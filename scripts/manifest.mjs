// Writes goodfellow-plugin.json from the built plugin, as Goodfellow's
// `pluginManifest()` would: what the plugin asks to do, which the admin
// panel's Plugins screen shows before it's installed.
import { writeFileSync } from "node:fs";
import plugin from "../dist/index.js";

const manifest = {
  version: 1,
  title: plugin.title,
  ...(plugin.description && { description: plugin.description }),
  permissions: Object.fromEntries(
    ["connect", "files", "secrets", "read", "write"].flatMap((key) =>
      plugin.permissions?.[key]?.length ? [[key, [...plugin.permissions[key]]]] : [],
    ),
  ),
  ...(plugin.admin && { admin: true }),
  ...(plugin.screens?.length && { screens: plugin.screens.map(({ id, title }) => ({ id, title })) }),
  ...(plugin.mediaStorage && { mediaStorage: true }),
};

writeFileSync(new URL("../goodfellow-plugin.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
