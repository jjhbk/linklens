import { generateJwt } from "@coinbase/cdp-sdk/auth";

const apiKeyId = process.env.CDP_API_KEY_ID;
const apiKeySecret = process.env.CDP_API_KEY_SECRET;
const payTo = process.env.MERCHANT_WALLET;
const resourceHost = process.env.LINKLENS_BAZAAR_HOST || "linklens-sand.vercel.app";
const validationResource = process.env.LINKLENS_VALIDATE_URL || `https://${resourceHost}/api/inspect?url=https://example.com`;
const showToken = process.argv.includes("--show-token");
const searchAll = process.argv.includes("--all");
const validate = process.argv.includes("--validate");

if (!apiKeyId || !apiKeySecret) {
  console.error("Missing CDP_API_KEY_ID or CDP_API_KEY_SECRET.");
  process.exit(1);
}

const baseUrl = "https://api.cdp.coinbase.com";
const path = validate
  ? "/platform/v2/x402/validate"
  : payTo && !searchAll ? "/platform/v2/x402/discovery/merchant" : "/platform/v2/x402/discovery/resources";
const query = validate ? "" : payTo && !searchAll ? `?payTo=${encodeURIComponent(payTo)}&limit=20` : "?limit=100";

try {
  const accessToken = await generateJwt({
    apiKeyId,
    apiKeySecret,
    requestMethod: "GET",
    requestHost: "api.cdp.coinbase.com",
    requestPath: path,
    expiresIn: 120,
  });

  const response = await fetch(`${baseUrl}${path}${query}`, {
    method: validate ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(validate ? { "content-type": "application/json" } : {}),
    },
    ...(validate ? { body: JSON.stringify({ resource: validationResource, method: "GET" }) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();

  if (!response.ok) {
    console.error(`CDP Bazaar returned ${response.status}:`, body);
    process.exit(1);
  }

  if (validate) {
    console.log(JSON.stringify(body, null, 2));
    process.exit(body.valid === true ? 0 : 1);
  }

  const resources = body.resources || body.items || [];
  const matches = resources.filter((item) => item.resource?.includes(resourceHost));

  console.log(matches.length ? "LinkLens is listed in the CDP Bazaar." : "LinkLens was not found in the CDP Bazaar.");
  console.log(JSON.stringify({
    resourceHost,
    merchant: payTo || null,
    searchMode: searchAll ? "all-resources" : payTo ? "merchant" : "all-resources",
    matches,
    pagination: body.pagination || null,
    accessTokenExpiresInSeconds: 120,
    ...(showToken ? { accessToken } : {}),
  }, null, 2));
} catch (error) {
  console.error("Unable to check the CDP Bazaar:", error instanceof Error ? error.message : error);
  process.exit(1);
}
