# goodfellow-plugin-s3

S3 storage for [Goodfellow](https://github.com/goodfellow-cms/goodfellow-cms) sites: the site's media kept in a bucket of any S3-compatible service, such as Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces or MinIO, instead of the site's repository. Files can be much larger, up to 5 GB each, such as long videos, and nothing goes into the repository's history.

Content still refers to files as `/media/…`, so pages don't change when the site's media moves. Goodfellow lists the files the bucket keeps in `content/media-storage.json`, and builds show them from the bucket's public address.

It needs Goodfellow 0.6 or later, with the starters' setup for plugins' tasks: `.github/workflows/plugin-task.yml` on GitHub, or the `plugin-task` job in `.gitlab-ci.yml` on GitLab. Sites made before 0.6 copy them from the starter.

## How it works

- **Keys:** the bucket's keys are kept in the site's CI secrets, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (GitHub Actions secrets, or GitLab CI/CD variables), never in the admin panel, an editor's browser or the site's files.
- **Uploading:** the admin panel's Media screen hands each batch of files to the plugin, which runs in a sandboxed frame of its own. The plugin asks the site's CI to sign the uploads, with its `sign` task, which gets only those two secrets and takes about a minute. The task answers with an address for each file that works for an hour and only for putting that file, sealed so only that admin panel can read it, and the frame sends the files straight to the bucket. Then the admin panel publishes the list of files.
- **Full-stack sites** can keep the keys in their server's environment instead, which signs uploads straight away (see below).
- **Moving the site's media:** once the plugin is set up, the Media screen offers to move the files already in the site's own files to the bucket, and to move them back (files up to 25 MB), in one publish each.
- **Settings:** the bucket, the service's address and the files' public address are in `content/s3-storage.json`, which holds no keys.

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

The admin panel can reach only the services the plugin names: Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Wasabi, Linode (Akamai) Object Storage and Google Cloud Storage. For another service, such as your own MinIO, add the plugin in the config with its address:

```tsx
import { s3 } from "goodfellow-plugin-s3";

plugins: [s3({ connect: ["https://minio.example.org"] })],
```

## Setting up the bucket

1. **Create a bucket** for the site.
2. **Make its files public** for reading, the way the service does it: on Cloudflare R2, connect a custom domain or turn on its `r2.dev` address; on Amazon S3, a bucket policy that allows `s3:GetObject` to everyone, or CloudFront in front of it; on Backblaze B2, make the bucket public. The address visitors' browsers read files from is the **public address**.
3. **Allow the admin panel's requests** in the bucket's CORS settings. The plugin's frame is sandboxed, so its requests come from no origin of their own, and the rule has to allow any:

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

5. **Add the keys to the site's secrets** as `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: on GitHub under the repository's **Settings → Secrets and variables → Actions**; on GitLab under **Settings → CI/CD → Variables**, masked (and protected, since tasks run on the main branch). The plugin's task gets only these two; nothing else in the site's CI does unless it asks for them.
6. In the admin panel, open **Site Settings → S3 storage**, fill in the service's address (such as `https://s3.eu-west-1.amazonaws.com`, or `https://<account id>.r2.cloudflarestorage.com` for R2), the bucket, its region (`auto` for R2), an optional folder and the public address, and save. New uploads go to the bucket from then on. **Try the bucket** puts a small file and removes it, which checks the settings, the keys and the CORS settings together.
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

`goodfellow dev` and `next dev` run plugins' tasks on your computer, with the development server's environment as their secrets, so start it with the keys set:

```sh
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npm run dev
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

## License

MIT
