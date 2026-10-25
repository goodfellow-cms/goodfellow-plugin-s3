/**
 * The S3-compatible services the plugin knows, so owners choose one from a
 * list and give only what it needs to find their bucket, such as its region,
 * rather than the service's address. A site's config can add others, such as
 * its own MinIO server (`s3({ services })`).
 */

/** What a service needs besides the bucket's name: its region, or the account it's in. */
export interface ServiceQuestion {
  kind: "region" | "account";
  label: string;
  /** Where to find it, in the service's own words. */
  hint: string;
  /** What it looks like, such as `eu-west-1`. */
  example: string;
}

export interface StorageService {
  id: string;
  name: string;
  /** What else it asks for, if anything. */
  asks?: ServiceQuestion;
  /** The address requests go to, from the answer to `asks`. */
  endpoint(answer: string): string;
  /** The region requests are signed for. */
  signingRegion(answer: string): string;
  /**
   * The bucket's own public address, where the service gives one, once the
   * bucket lets anyone read its files. Without one, owners give the address
   * the service shows them.
   */
  publicUrl?(bucket: string, answer: string): string;
  /** How the bucket's files are made public, in words for the owner. */
  publicHelp: string;
  /** Whether each upload has to say anyone may read it (`x-amz-acl: public-read`), for services without bucket-wide settings. */
  publicRead?: boolean;
  /** How to make keys that can only put and delete files in the bucket. */
  keysHelp: string;
  /** Where its settings let the admin panel upload (CORS). */
  corsHelp: string;
  /** The addresses the plugin's frame may reach for it, as origins. */
  connect: string[];
}

/** A service a site's config adds, as JSON. */
export interface CustomService {
  id: string;
  name: string;
  /** Its address, such as `https://minio.example.org`. */
  endpoint: string;
  /** The region it signs for, `us-east-1` if it doesn't say. */
  region?: string;
  /** Where its buckets' files are public, with `{bucket}` for the bucket's name. */
  publicUrl?: string;
}

const REGION_PATTERN = /^[a-z0-9-]{2,32}$/;
const ACCOUNT_PATTERN = /^[0-9a-f]{32}$/;

/** Whether an answer could be what a service asks for. */
export function isAnswer(question: ServiceQuestion | undefined, answer: string): boolean {
  if (!question) return true;
  return (question.kind === "account" ? ACCOUNT_PATTERN : REGION_PATTERN).test(answer);
}

/** Buckets whose names have dots can't use an address under the service's own, whose certificate covers one level. */
function bucketHost(bucket: string, host: string, path: string): string {
  return bucket.includes(".") ? `https://${path}/${bucket}` : `https://${bucket}.${host}`;
}

const CORS =
  "allow PUT, DELETE and GET from any origin (*), with any headers, since the plugin's screen has no origin of its own.";

export const SERVICES: readonly StorageService[] = [
  {
    id: "aws",
    name: "Amazon S3",
    asks: {
      kind: "region",
      label: "Region",
      hint: "The bucket's AWS Region, shown in its Properties, as a code such as eu-west-1.",
      example: "eu-west-1",
    },
    endpoint: (region) => `https://s3.${region}.amazonaws.com`,
    signingRegion: (region) => region,
    publicUrl: (bucket, region) => bucketHost(bucket, `s3.${region}.amazonaws.com`, `s3.${region}.amazonaws.com`),
    publicHelp:
      "Amazon S3 keeps files private until the bucket allows anyone to read them: in the bucket's Permissions, turn off Block public access, and add a bucket policy that allows s3:GetObject to everyone (the plugin's guide has one to copy).",
    keysHelp:
      "In AWS's IAM, make a user whose policy allows only s3:PutObject and s3:DeleteObject on this bucket, then make an access key for it under Security credentials.",
    corsHelp: `In the bucket's Permissions, under Cross-origin resource sharing (CORS), ${CORS}`,
    connect: ["https://*.amazonaws.com"],
  },
  {
    id: "r2",
    name: "Cloudflare R2",
    asks: {
      kind: "account",
      label: "Account ID",
      hint: "Shown on the R2 overview page in Cloudflare's dashboard, as Account ID: 32 letters and digits.",
      example: "0123456789abcdef0123456789abcdef",
    },
    endpoint: (account) => `https://${account}.r2.cloudflarestorage.com`,
    signingRegion: () => "auto",
    publicHelp:
      "In Cloudflare's dashboard, open the bucket's Settings. Under Public access, turn on its r2.dev address, or connect a domain of your own there, and copy the address it shows into Public address.",
    keysHelp:
      "On the R2 overview page, choose Manage API tokens and create one with Object Read & Write permission for this bucket alone. Copy its Access Key ID and Secret Access Key.",
    corsHelp: `In the bucket's Settings, under CORS policy, ${CORS}`,
    connect: ["https://*.r2.cloudflarestorage.com"],
  },
  {
    id: "b2",
    name: "Backblaze B2",
    asks: {
      kind: "region",
      label: "Region",
      hint: "The middle part of the bucket's Endpoint, shown in its details as s3.<region>.backblazeb2.com, such as us-west-004.",
      example: "us-west-004",
    },
    endpoint: (region) => `https://s3.${region}.backblazeb2.com`,
    signingRegion: (region) => region,
    publicUrl: (bucket, region) => `https://s3.${region}.backblazeb2.com/${bucket}`,
    publicHelp:
      "In the bucket's settings, set Files in Bucket to Public (Backblaze asks you to confirm your email first).",
    keysHelp:
      "Under Application Keys, add a key with access to this bucket alone, allowing Read and Write. Its keyID is the access key ID, and its applicationKey the secret.",
    corsHelp: `B2's own CORS settings can't allow uploads, so a developer sets the bucket's CORS rules with B2's S3 API or command-line tool to ${CORS}`,
    connect: ["https://*.backblazeb2.com"],
  },
  {
    id: "spaces",
    name: "DigitalOcean Spaces",
    asks: {
      kind: "region",
      label: "Region",
      hint: "The datacenter in the Space's address, https://<name>.<region>.digitaloceanspaces.com, such as nyc3.",
      example: "nyc3",
    },
    endpoint: (region) => `https://${region}.digitaloceanspaces.com`,
    signingRegion: () => "us-east-1",
    publicUrl: (bucket, region) =>
      bucketHost(bucket, `${region}.digitaloceanspaces.com`, `${region}.digitaloceanspaces.com`),
    publicHelp:
      "Nothing to do: the plugin makes each file it uploads readable by anyone. The Space's CDN address works too, if you turn it on.",
    publicRead: true,
    keysHelp:
      "Under API → Spaces Keys, generate a key with access to this Space alone. Copy its Access Key and Secret Key.",
    corsHelp: `In the Space's Settings, under CORS Configurations, ${CORS}`,
    connect: ["https://*.digitaloceanspaces.com"],
  },
  {
    id: "wasabi",
    name: "Wasabi",
    asks: {
      kind: "region",
      label: "Region",
      hint: "The bucket's region, shown in its details, such as us-east-1 or eu-central-1.",
      example: "us-east-1",
    },
    endpoint: (region) => `https://s3.${region}.wasabisys.com`,
    signingRegion: (region) => region,
    publicUrl: (bucket, region) => `https://s3.${region}.wasabisys.com/${bucket}`,
    publicHelp:
      "Give the bucket a policy that allows anyone to read its files, in the bucket's Settings → Policies. Wasabi allows public buckets on paid accounts.",
    keysHelp:
      "Under Users, make a user whose policy allows only putting and deleting files in this bucket, and create an access key for it.",
    corsHelp: `Wasabi allows requests from any origin by default; if the bucket has CORS settings, they need to ${CORS}`,
    connect: ["https://*.wasabisys.com"],
  },
  {
    id: "linode",
    name: "Akamai (Linode) Object Storage",
    asks: {
      kind: "region",
      label: "Region",
      hint: "The region in the bucket's address, https://<name>.<region>.linodeobjects.com, such as us-east-1.",
      example: "us-east-1",
    },
    endpoint: (region) => `https://${region}.linodeobjects.com`,
    signingRegion: () => "us-east-1",
    publicUrl: (bucket, region) => bucketHost(bucket, `${region}.linodeobjects.com`, `${region}.linodeobjects.com`),
    publicHelp: "Nothing to do: the plugin makes each file it uploads readable by anyone.",
    publicRead: true,
    keysHelp: "Under Object Storage → Access Keys, create a key limited to this bucket, with Read/Write access.",
    corsHelp: `Linode's buckets allow uploads from any origin unless their CORS settings say otherwise; if they have any, they need to ${CORS}`,
    connect: ["https://*.linodeobjects.com"],
  },
  {
    id: "gcs",
    name: "Google Cloud Storage",
    endpoint: () => "https://storage.googleapis.com",
    signingRegion: () => "auto",
    publicUrl: (bucket) => `https://storage.googleapis.com/${bucket}`,
    publicHelp: "In the bucket's Permissions, grant allUsers the Storage Object Viewer role.",
    keysHelp:
      "In Cloud Storage's Settings → Interoperability, create an HMAC key for a service account that can only create and delete objects in this bucket. Its Access key and Secret are the keys.",
    corsHelp: `Google Cloud Storage sets CORS with its command-line tool: a developer sets the bucket's CORS to ${CORS}`,
    connect: ["https://storage.googleapis.com"],
  },
];

/** A service a site's config adds, if it's one the plugin can use. */
function customService(value: unknown): StorageService | undefined {
  const given = (value ?? {}) as Partial<Record<keyof CustomService, unknown>>;
  if (typeof given.id !== "string" || typeof given.name !== "string" || typeof given.endpoint !== "string") return;
  let origin: string;
  try {
    origin = new URL(given.endpoint).origin;
  } catch {
    return undefined;
  }
  const region = typeof given.region === "string" && given.region ? given.region : "us-east-1";
  const publicUrl = typeof given.publicUrl === "string" ? given.publicUrl : undefined;
  return {
    id: `custom:${given.id}`,
    name: given.name,
    endpoint: () => origin,
    signingRegion: () => region,
    ...(publicUrl && { publicUrl: (bucket: string) => publicUrl.replaceAll("{bucket}", bucket) }),
    publicHelp:
      "Ask whoever runs the service how its buckets' files are made public, and give the address they're public at.",
    keysHelp: "Ask whoever runs the service for keys that can only put and delete files in this bucket.",
    corsHelp: `Ask whoever runs the service to ${CORS}`,
    connect: [origin],
  };
}

/** The services to offer: the plugin's own, and any the site's config adds (`s3({ services })`). */
export function servicesFrom(options: { services?: unknown } | undefined): StorageService[] {
  const added = Array.isArray(options?.services) ? options.services.map(customService) : [];
  return [...SERVICES, ...added.filter((service): service is StorageService => service !== undefined)];
}
