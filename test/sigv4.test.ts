import { describe, expect, it } from "vitest";
import { amzDate, EMPTY_PAYLOAD, signRequest, uriEncode } from "../src/sigv4.js";

// The example in Amazon's documentation for signing a request with headers:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("signatures", () => {
  it("signs a request as Amazon's documentation does", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_PAYLOAD,
      credentials,
      region: "us-east-1",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers).not.toHaveProperty("host");
  });

  it("encodes as signatures expect", () => {
    expect(uriEncode("a b/c(1)~.jpg", true)).toBe("a%20b/c%281%29~.jpg");
    expect(uriEncode("a/b", false)).toBe("a%2Fb");
    expect(amzDate(new Date("2026-10-25T20:01:02.345Z"))).toBe("20261025T200102Z");
  });
});
