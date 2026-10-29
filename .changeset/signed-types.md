---
"goodfellow-plugin-s3": patch
---

Signs uploads only for the kinds of file Goodfellow's media library takes, each with the type its address says, rather than the type the browser asks for, so no one with a signed address can put a page or a script at the bucket's address. SVGs are served to download when opened on their own, and still show in pages. A full-stack site's server signs deletes for the site's owners only, and the admin panel says when it refuses rather than asking the site's CI instead.
