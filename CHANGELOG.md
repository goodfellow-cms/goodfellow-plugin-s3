# goodfellow-plugin-s3

## 0.2.1

### Patch Changes

- 6454532: Signs requests only at the address the service gives the bucket, worked out from the service and its region or account, never the settings file's own address, which editors can change: some services read an address such as `https://other-bucket.s3.amazonaws.com` as another bucket, so settings giving it got files signed in a bucket `S3_BUCKET` never named. A service added in the site's config has its address at the start of `S3_BUCKET` (`https://minio.example.org/parish-media/site/`), which the settings screen shows; until a developer adds it, nothing is signed for that service, and the admin panel says why.
  
  On a full-stack site's server, only owners can have an upload signed over a file the site already keeps in the bucket, however its address is spelled (`/media/%73ermon.mp4` is `/media/sermon.mp4`), since that replaces the file, as only they can have deletes signed. The server answers a request it can't sign with the plugin's own explanation, or a fixed one, never another error's message, which could name its files or code. The README says which addresses the plugin's screen may reach.
  
  Releases are built and tested in a job of their own, and staged from a second job that runs none of the repository's code, so no package the build installs runs where npm's publishing token can be had.
- d4ae47b: Sign uploads and deletes through the site's CI on sites with no server of their own, rather than saying the server couldn't be reached. Every site's description names the plugin's server module, so only a full-stack site's server is asked first.

## 0.2.0

### Minor Changes

- a8d0d76: Signs only for the bucket and folder named in a new secret, `S3_BUCKET` (`parish-media`, or `parish-media/site/`), beside the keys. Editors can change `content/s3-storage.json`, so before, anyone who could edit the site could point the keys at any other bucket they reached and have its files deleted. Sites need to add `S3_BUCKET` where the keys are, which the plugin's screen shows, and an owner approves the plugin's new secret on the Plugins screen; until then, nothing is signed, and the admin panel says why.
  
  Each upload's size is signed too, so a signed address takes only a file of the size the admin panel said, and nothing larger than the bucket takes in one upload. The plugin's frame checks that each signed address goes to the bucket, folder and file it asked for before sending anything, and an upload tried again after its connection dropped is signed again first, since a large one may outlast its address. The bucket's CORS rules allow only PUT and DELETE with the headers the plugin sends. Settings can't use a public address on the site's own domain, and can't change the service, bucket or folder while files are kept there. The README says who can delete files, and recommends turning on the bucket's versioning.

### Patch Changes

- dd8829a: Links to Goodfellow's GitHub Sponsors page from npm.

## 0.1.2

### Patch Changes

- b950c3a: Refuses media addresses that only look like they stay in the site's folder: `%2e%2e` (`..`), `%2f` (`/`), `%5c` (`\`), `%00` and other encoded control characters, and doubly encoded ones. Before, `/media/%2e%2e/escaped.txt` was signed as `escaped.txt` at the top of the bucket, and two of them could reach another bucket the keys could write to, so any signed-in editor of a full-stack site, or anyone who could start the site's CI, could have files written or deleted outside the site's folder. Addresses are now checked once decoded, and a signed address is refused unless it's exactly the one asked for, in the site's folder.
- e2b892a: Releases are published to npm from GitHub Actions with npm's provenance, which Goodfellow's Plugins screen shows owners: which repository and commit a release was built from.
- 141ff93: Signs uploads only for the kinds of file Goodfellow's media library takes, each with the type its address says, rather than the type the browser asks for, so no one with a signed address can put a page or a script at the bucket's address. SVGs are served to download when opened on their own, and still show in pages. A full-stack site's server signs deletes for the site's owners only, and the admin panel says when it refuses rather than asking the site's CI instead.
- bcfb485: Uploads and deletes of more than 100 files at once are signed a hundred at a time, rather than refused. A full-stack site's server that fails to sign them is said, in words for the editor, rather than each upload quietly waiting a minute for the site's CI instead, and only a server without the keys leaves it to the CI. An upload whose connection drops, or that the storage is too busy for, is tried again, up to three times. Files are at most 5 MiB under 5 GiB, which Cloudflare R2 takes in one upload as well as S3.

## 0.1.1

### Patch Changes

- aba4181: Works with Goodfellow 0.7 and later 0.x releases. Its range on `@goodfellow-cms/core` was `^0.6.0`, which npm reads as 0.6 alone, so Goodfellow's Plugins screen didn't offer it to sites on 0.7.
