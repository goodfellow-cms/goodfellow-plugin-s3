# goodfellow-plugin-s3

S3 storage for [Goodfellow](https://github.com/goodfellow-cms/goodfellow-cms) sites: the site's media kept in a bucket of any S3-compatible service, such as Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces or MinIO, instead of the site's repository. Files can be much larger, up to 5 GB each, such as long videos, and nothing goes into the repository's history.

Content still refers to files as `/media/…`, so pages don't change when the site's media moves. Goodfellow lists the files the bucket keeps in `content/media-storage.json`, and builds show them from the bucket's public address.

It needs Goodfellow 0.6 or later.

## How it works

- **Uploading:** the admin panel's Media screen sends each file to the plugin, which runs in a sandboxed frame of its own and puts the file straight into the bucket, signed with the editor's own keys. Then the admin panel publishes the list of files.
- **Moving the site's media:** once the plugin is set up, the Media screen offers to move the files already in the site's own files to the bucket, and to move them back (files up to 25 MB), in one publish each.
- **Keys:** each editor who uploads gives their own access keys on the plugin's screen. The admin panel keeps them in that editor's browser, for the tab or, if they choose, until they sign out, and gives them only to this plugin. They're never in the site's files.
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

   Requests are still signed, so only someone with keys can change the bucket.
4. **Make keys for each editor** that can only put and delete files in this bucket: on Cloudflare R2, an API token with *Object Read & Write* for the one bucket; on Amazon S3, an IAM user with a policy like this one:

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

5. In the admin panel, open **Site Settings → S3 storage**, fill in the service's address (such as `https://s3.eu-west-1.amazonaws.com`, or `https://<account id>.r2.cloudflarestorage.com` for R2), the bucket, its region (`auto` for R2), an optional folder and the public address, and save. New uploads go to the bucket from then on.
6. Each editor gives their keys under **Your keys** and can **Try the bucket**, which puts a small file and removes it.
7. On the **Media** screen, **Move … files to S3 storage** moves the files the site already has.

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
