import { describe, expect, it } from "vitest";
import { amzDate, EMPTY_PAYLOAD, presignUrl, signRequest, uriEncode } from "../src/sigv4.js";

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

  it("presigns an address as Amazon's documentation does", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await presignUrl({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      credentials,
      region: "us-east-1",
      expires: 86400,
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("encodes as signatures expect", () => {
    expect(uriEncode("a b/c(1)~.jpg", true)).toBe("a%20b/c%281%29~.jpg");
    expect(uriEncode("a/b", false)).toBe("a%2Fb");
    expect(amzDate(new Date("2026-10-25T20:01:02.345Z"))).toBe("20261025T200102Z");
  });
});
