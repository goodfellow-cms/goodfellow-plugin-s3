---
"goodfellow-plugin-s3": patch
---

Refuses media addresses that only look like they stay in the site's folder: `%2e%2e` (`..`), `%2f` (`/`), `%5c` (`\`), `%00` and other encoded control characters, and doubly encoded ones. Before, `/media/%2e%2e/escaped.txt` was signed as `escaped.txt` at the top of the bucket, and two of them could reach another bucket the keys could write to, so any signed-in editor of a full-stack site, or anyone who could start the site's CI, could have files written or deleted outside the site's folder. Addresses are now checked once decoded, and a signed address is refused unless it's exactly the one asked for, in the site's folder.
