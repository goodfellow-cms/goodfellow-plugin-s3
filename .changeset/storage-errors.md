---
"goodfellow-plugin-s3": patch
---

Uploads and deletes of more than 100 files at once are signed a hundred at a time, rather than refused. A full-stack site's server that fails to sign them is said, in words for the editor, rather than each upload quietly waiting a minute for the site's CI instead, and only a server without the keys leaves it to the CI. An upload whose connection drops, or that the storage is too busy for, is tried again, up to three times. Files are at most 5 MiB under 5 GiB, which Cloudflare R2 takes in one upload as well as S3.
