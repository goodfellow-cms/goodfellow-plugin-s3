---
"goodfellow-plugin-s3": patch
---

Signs requests only at the address the service gives the bucket, worked out from the service and its region or account, never the settings file's own address, which editors can change: some services read an address such as `https://other-bucket.s3.amazonaws.com` as another bucket, so settings giving it got files signed in a bucket `S3_BUCKET` never named. A service added in the site's config has its address at the start of `S3_BUCKET` (`https://minio.example.org/parish-media/site/`), which the settings screen shows; until a developer adds it, nothing is signed for that service, and the admin panel says why.

On a full-stack site's server, only owners can have an upload signed over a file the site already keeps in the bucket, since that replaces the file, as only they can have deletes signed. The server answers a request it can't sign with the plugin's own explanation, or a fixed one, never another error's message, which could name its files or code. The README says which addresses the plugin's screen may reach.

Releases are built and tested in a job of their own, and staged from a second job that runs none of the repository's code, so no package the build installs runs where npm's publishing token can be had.
