import { generateJwt } from "@coinbase/cdp-sdk/auth";

const apiKeyId = process.env.CDP_API_KEY_ID;
const apiKeySecret = process.env.CDP_API_KEY_SECRET;
const resourceHost = process.env.LINKLENS_BAZAAR_HOST || "linklens-sand.vercel.app";
const cdpBaseUrl = "https://api.cdp.coinbase.com";
const agenticUrl = new URL("https://api.agentic.market/v1/search/services");

if (!apiKeyId || !apiKeySecret) {
  console.error("Missing CDP_API_KEY_ID or CDP_API_KEY_SECRET.");
  process.exit(1);
}

agenticUrl.searchParams.set("q", resourceHost);
agenticUrl.searchParams.set("limit", "24");
agenticUrl.searchParams.set("offset", "0");

async function cdpRequest(path, { method = "GET", query = "", body } = {}) {
  const accessToken = await generateJwt({
    apiKeyId,
    apiKeySecret,
    requestMethod: method,
    requestHost: "api.cdp.coinbase.com",
    requestPath: path,
    expiresIn: 120,
  });

  const response = await fetch(`${cdpBaseUrl}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(`CDP ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getAgenticServices(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.services || payload?.items || payload?.results || [];
}

function agenticItemMatches(item) {
  const searchable = JSON.stringify(item).toLowerCase();
  return searchable.includes(resourceHost.toLowerCase());
}

function printResult(label, passed, details) {
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}`);
  if (details) console.log(`      ${details}`);
}

try {
  const [discovery, agenticResponse] = await Promise.all([
    cdpRequest("/platform/v2/x402/discovery/search", {
      query: `?urlSubstring=${encodeURIComponent(resourceHost)}&limit=20`,
    }),
    fetch(agenticUrl, { signal: AbortSignal.timeout(20_000) }),
  ]);

  const cdpResources = discovery?.resources || discovery?.items || [];
  const cdpMatches = cdpResources.filter((item) =>
    JSON.stringify(item).toLowerCase().includes(resourceHost.toLowerCase()),
  );

  if (!agenticResponse.ok) {
    throw new Error(`Agentic Market returned ${agenticResponse.status}`);
  }
  const agenticPayload = await readJson(agenticResponse);
  const agenticMatches = getAgenticServices(agenticPayload).filter(agenticItemMatches);

  const cdpListed = cdpMatches.length > 0;
  const agenticListed = agenticMatches.length > 0;

  console.log(`\nLinkLens listing check: ${resourceHost}\n`);
  printResult("CDP Bazaar listing", cdpListed, `${cdpMatches.length} matching resource(s)`);
  printResult("Agentic Market listing", agenticListed, `${agenticMatches.length} matching service(s)`);

  if (process.argv.includes("--json")) {
    console.log("\nDetails:");
    console.log(
      JSON.stringify(
        {
          resourceHost,
          cdp: { matches: cdpMatches },
          agentic: { matches: agenticMatches },
        },
        null,
        2,
      ),
    );
  }

  if (!(cdpListed && agenticListed)) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error("Listing check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
