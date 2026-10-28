# goodfellow-plugin-s3

S3 storage for [Goodfellow](https://github.com/goodfellow-cms/goodfellow-cms) sites: the site's media kept in a bucket of any S3-compatible service, such as Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces or MinIO, instead of the site's repository. Files can be much larger, up to 5 GB each, such as long videos, and nothing goes into the repository's history.

Content still refers to files as `/media/…`, so pages don't change when the site's media moves. Goodfellow lists the files the bucket keeps in `content/media-storage.json`, and builds show them from the bucket's public address.

It needs Goodfellow 0.6 or later, with the starters' setup for plugins' tasks: `.github/workflows/plugin-task.yml` on GitHub, the `plugin-task` job in `.gitlab-ci.yml` on GitLab, or the `plugin-task` pipeline in `bitbucket-pipelines.yml` on Bitbucket, which `create-goodfellow` writes for sites stored there. Sites made before 0.6 copy them from the starter.

## How it works

- **Keys:** the bucket's keys are kept in the site's CI secrets, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (GitHub Actions secrets, GitLab CI/CD variables or Bitbucket's secured Pipelines variables), never in the admin panel, an editor's browser or the site's files.
- **Uploading:** the admin panel's Media screen hands each batch of files to the plugin, which runs in a sandboxed frame of its own. The plugin asks the site's CI to sign the uploads, with its `sign` task, which gets only those two secrets and takes about a minute. The task answers with an address for each file that works for an hour and only for putting that file, sealed so only that admin panel can read it, and the frame sends the files straight to the bucket. Then the admin panel publishes the list of files.
- **Full-stack sites** can keep the keys in their server's environment instead, which signs uploads straight away (see below).
- **Moving the site's media:** once the plugin is set up, the Media screen offers to move the files already in the site's own files to the bucket, and to move them back (files up to 25 MB), in one publish each.
- **Settings:** the service, the bucket, its region (or Cloudflare account) and the files' public address are in `content/s3-storage.json`, which holds no keys.

## Installing

At a checked admin address or with a token broker, an owner installs it from **Site Settings → Plugins**. Otherwise a developer adds it to the site:

```sh
npm install goodfellow-plugin-s3
```

```tsx
// goodfellow.config.tsx
import s3 from "goodfellow-plugin-s3";

export default defineConfig({
  // …
  plugins: [s3, ...installedPlugins],
});
```

Owners choose the service from a list: Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi, Akamai (Linode) Object Storage and Google Cloud Storage, and give only what it needs to find the bucket, such as its region. The admin panel can reach only those. For another service, such as your own MinIO, a developer adds it in the config, and it joins the list:

```tsx
import { s3 } from "goodfellow-plugin-s3";

plugins: [
  s3({
    services: [
      {
        id: "minio",
        name: "Our MinIO server",
        endpoint: "https://minio.example.org",
        // Optional: the region it signs for (us-east-1 if not given), and
        // where its buckets' files are public, with {bucket} for the name.
        region: "us-east-1",
        publicUrl: "https://media.example.org/{bucket}",
      },
    ],
  }),
],
```

## Setting up the bucket

The plugin's screen, **Site Settings → S3 storage**, walks through these steps for the service chosen, with the words its dashboard uses.

1. **Create a bucket** for the site, and choose its service, bucket and region on the plugin's screen.
2. **Make its files public**, so visitors' browsers can show them. The screen says how for the service chosen, and the address they're shown from:
   - Amazon S3, Backblaze B2, Wasabi and Google Cloud Storage give each bucket an address of their own, which works once the bucket lets anyone read its files (on Amazon S3, turn off *Block public access* and add a bucket policy that allows `s3:GetObject` to everyone; on Backblaze B2, make the bucket public; on Google Cloud Storage, give `allUsers` the *Storage Object Viewer* role).
   - DigitalOcean Spaces and Akamai (Linode) Object Storage need nothing: the plugin makes each file it uploads readable by anyone.
   - Cloudflare R2 has no address until you turn one on: in the bucket's settings, turn on its `r2.dev` address or connect a domain, and copy the address it shows into **Public address**.

   **Use an address of my own** is for files shown from somewhere else, such as a domain of your own or a service that copies them closer to visitors (a CDN, such as CloudFront in front of Amazon S3). Leave it off if you're not sure.
3. **Allow the admin panel's requests** in the bucket's CORS settings. The plugin's frame is sandboxed, so its requests come from no origin of their own, and the rule has to allow any (the screen has this to copy, under *Let the admin panel upload to the bucket*):

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["PUT", "DELETE", "GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Requests are still signed, so only someone the site's CI signed for can change the bucket.
4. **Make keys for the site** that can only put and delete files in this bucket: on Cloudflare R2, an API token with *Object Read & Write* for the one bucket; on Amazon S3, an IAM user with a policy like this one:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::your-bucket/*"
       }
     ]
   }
   ```

5. **Add the keys to the site's secrets** as `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The screen shows only the steps for this site, with a link to the page where they're added: on GitHub, the repository's **Settings → Secrets and variables → Actions → New repository secret**; on GitLab, **Settings → CI/CD → Variables**, masked and protected, since tasks run on the main branch; on Bitbucket, **Repository settings → Pipelines → Repository variables**, secured, with Pipelines turned on; on a full-stack site, the server's environment; in `goodfellow dev` and `next dev`, the site's `.env.local` (see below). The plugin's task gets only these two. On GitHub nothing else in the site's CI gets them; GitLab and Bitbucket give every job in the site's pipelines the variables, so keep only what the site needs there.
6. **Save** the settings. New uploads go to the bucket from then on. **Try the bucket** puts a small file and removes it, which checks the settings, the keys and the CORS settings together.
7. On the **Media** screen, **Move … files to S3 storage** moves the files the site already has.

## Full-stack sites

A full-stack Next.js site can sign uploads on its own server, straight away, rather than through its CI. Put `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in the server's environment and pass the plugin's server module to the API route:

```ts
// app/api/goodfellow/[...path]/route.ts
import s3Server from "goodfellow-plugin-s3/server";

export const { GET, POST } = goodfellowApi({
  // …
  plugins: { "goodfellow-plugin-s3": s3Server },
});
```

It reads the bucket's settings from the server's copy of the site's files, so a change to them takes effect once the server has been rebuilt. Without the keys, the plugin signs through the CI as on any other site.

## Trying it out locally

`goodfellow dev` and `next dev` run plugins' tasks on your computer. They read the secrets from the site's `.env.local` each time, which the starters' `.gitignore` keeps out of the site's files:

```sh
# .env.local
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

## Removing it

Move the media back on the Media screen first: the Plugins screen won't remove the plugin while the bucket keeps files the site shows. Files larger than 25 MB can't go into the site's own files, so pages need other files in their place before then.

## Developing

```sh
npm install
npm test
npm run build
```

`npm run build` also writes `goodfellow-plugin.json`, what the plugin asks to do, which Goodfellow's Plugins screen shows before it's installed; commit it with any change to the plugin's permissions.

Every change that reaches the published plugin needs a changeset: run `npx changeset`, choose patch, minor or major, and describe the change for the plugin's users. It writes a file in `.changeset/`, which goes in the same pull request. To release, run `npm run release:version`, which turns the changesets into a new `version` in `package.json` and an entry in `CHANGELOG.md`, and puts the same version in the plugin's description in `src/index.ts`, which a test keeps the same; commit what it changes, then publish that commit to npm.

`peerDependencies` names the Goodfellow releases it works with, as a range on `@goodfellow-cms/core` (`>=0.6.0 <1.0.0`). Goodfellow's Plugins screen offers a release only to sites on a Goodfellow release in that range, so narrow it in a new version if a Goodfellow release breaks the plugin. A caret range such as `^0.6.0` would mean 0.6 alone.

## License

MIT
