---
"goodfellow-plugin-s3": patch
---

Sign uploads and deletes through the site's CI on sites with no server of their own, rather than saying the server couldn't be reached. Every site's description names the plugin's server module, so only a full-stack site's server is asked first.
