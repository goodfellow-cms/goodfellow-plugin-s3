---
"goodfellow-plugin-s3": minor
---

Signs only for the bucket and folder named in a new secret, `S3_BUCKET` (`parish-media`, or `parish-media/site/`), beside the keys. Editors can change `content/s3-storage.json`, so before, anyone who could edit the site could point the keys at any other bucket they reached and have its files deleted. Sites need to add `S3_BUCKET` where the keys are, which the plugin's screen shows, and an owner approves the plugin's new secret on the Plugins screen; until then, nothing is signed, and the admin panel says why.

Each upload's size is signed too, so a signed address takes only a file of the size the admin panel said, and nothing larger than the bucket takes in one upload. The plugin's frame checks that each signed address goes to the bucket, folder and file it asked for before sending anything, and an upload tried again after its connection dropped is signed again first, since a large one may outlast its address. The bucket's CORS rules allow only PUT and DELETE with the headers the plugin sends. Settings can't use a public address on the site's own domain, and can't change the service, bucket or folder while files are kept there. The README says who can delete files, and recommends turning on the bucket's versioning.
