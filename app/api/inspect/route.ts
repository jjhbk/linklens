import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { base, merchantConfig, Paywall, type Receipt } from "@seedhape/x402-merchant-sdk";
import { createPaywall, evmPaywall } from "@x402/paywall";
export const runtime = "nodejs";
const receipts: Receipt[] = [];
const cdpCredentialsConfigured = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
const cdpFacilitatorClient = cdpCredentialsConfigured ? createCdpFacilitatorClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET
}) : undefined;
const eip3009Facilitator = {
  url: process.env.CDP_FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402",
  ...(cdpFacilitatorClient ? { client: cdpFacilitatorClient } : {})
};
const erc7710Facilitator = {
  url: process.env.ERC7710_FACILITATOR_URL || process.env.FACILITATOR_URL || base.facilitator.url
};
let paywallPromise: Promise<Paywall | null> | undefined;

async function getPaywall() {
  if (!paywallPromise) {
    paywallPromise = (async () => {
      let merchantWallet = process.env.MERCHANT_WALLET;
      if (!merchantWallet && process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET) {
        const cdp = new CdpClient({
          apiKeyId: process.env.CDP_API_KEY_ID,
          apiKeySecret: process.env.CDP_API_KEY_SECRET,
          walletSecret: process.env.CDP_WALLET_SECRET
        });
        const account = await cdp.evm.getOrCreateAccount({ name: process.env.CDP_WALLET_NAME || "link-lens-merchant" });
        merchantWallet = account.address;
      }
      if (!merchantWallet) return null;
      return new Paywall(merchantConfig(base, {
  payTo: merchantWallet,
  facilitator: eip3009Facilitator,
  paymentMethods: ["eip3009", "erc7710"],
  facilitators: {
    eip3009: eip3009Facilitator,
    erc7710: erc7710Facilitator
  },
  price: { amount: 10000n, ...base },
  description: "Extract metadata and readable text from a public URL",
  ...(process.env.MERCHANT_AP2_ISSUER && process.env.MERCHANT_AP2_PRIVATE_KEY_PEM ? {
    ap2: {
      issuer: process.env.MERCHANT_AP2_ISSUER,
      privateKeyPem: process.env.MERCHANT_AP2_PRIVATE_KEY_PEM,
      ...(process.env.MERCHANT_AP2_KEY_ID ? { keyId: process.env.MERCHANT_AP2_KEY_ID } : {})
    }
  } : {}),
  route: {
    name: "Link Lens URL Inspector",
    description: "Extract metadata and readable text from a public URL.",
    category: "url-intelligence",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", format: "uri", description: "Public HTTP(S) URL" } },
      required: ["url"]
    },
    outputSchema: { type: "object" }
  },
  receipts: { record: async receipt => { receipts.push(receipt); } }
      }));
    })();
  }
  return paywallPromise;
}
const browserPaywall = createPaywall().withNetwork(evmPaywall).withConfig({ appName: "Link Lens", testnet: false }).build();
const bazaarServiceName = "Link Lens URL Inspector";
const bazaarTags = ["url-intelligence", "metadata", "web", "links", "scraping"];
function safeUrl(value: string): URL | null {
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null; if (["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) return null; return url; } catch { return null; }
}
function enrichBazaarChallenge(challenge: unknown) {
  if (!challenge || typeof challenge !== "object") return challenge;
  const value = challenge as {
    resource?: Record<string, unknown>;
    extensions?: {
      bazaar?: {
        category?: string;
        tags?: string[];
        info?: {
          name?: string;
          serviceName?: string;
          input?: { queryParams?: Record<string, unknown> };
        };
      };
    };
  };
  const bazaar = value.extensions?.bazaar;
  if (value.resource) {
    value.resource.serviceName = bazaarServiceName;
    value.resource.tags = bazaarTags;
  }
  if (bazaar) {
    bazaar.category = "search";
    bazaar.tags = bazaarTags;
    if (bazaar.info) {
      bazaar.info.name = bazaarServiceName;
      bazaar.info.serviceName = bazaarServiceName;
    }
  }
  if (bazaar?.info?.input) {
    bazaar.info.input.queryParams = { url: "https://example.com" };
  }
  return challenge;
}
function enrichPaymentRequiredHeader(header?: string) {
  if (!header) return header;
  try {
    const challenge = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    enrichBazaarChallenge(challenge);
    return Buffer.from(JSON.stringify(challenge)).toString("base64");
  } catch {
    return header;
  }
}
async function fetchPublicPage(startUrl: URL) {
  let currentUrl = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(currentUrl, { headers: { "user-agent": "LinkLens/1.0" }, signal: AbortSignal.timeout(8000), redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return { response, url: currentUrl };
    const location = response.headers.get("location");
    const nextUrl = location ? safeUrl(new URL(location, currentUrl).toString()) : null;
    if (!nextUrl) throw new Error("Target redirect was not a safe public URL.");
    currentUrl = nextUrl;
  }
  throw new Error("Target exceeded the redirect limit.");
}
export async function GET(request: NextRequest) {
  const paywall = await getPaywall();
  if (!paywall) return Response.json({ error: "Payment service is not configured." }, { status: 503 });
  const paymentHeader = request.headers.get("payment-signature") ?? request.headers.get("x-payment");
  const outcome = await paywall.handle({
    path: "/api/inspect",
    method: "GET",
    query: request.nextUrl.searchParams,
    resource: request.url,
    paymentHeader
  });
  const challenge = enrichBazaarChallenge(outcome.challenge);
  const paymentHeaders = outcome.paymentRequiredHeader || outcome.ap2CheckoutJwt ? {
    ...(outcome.paymentRequiredHeader ? { "PAYMENT-REQUIRED": enrichPaymentRequiredHeader(outcome.paymentRequiredHeader) } : {}),
    ...(outcome.ap2CheckoutJwt ? { "AP2-CHECKOUT-JWT": outcome.ap2CheckoutJwt, "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, AP2-CHECKOUT-JWT" } : {})
  } : undefined;
  const wantsBrowserPaywall = request.headers.get("accept")?.includes("text/html");
  if (outcome.kind === "challenge") {
    if (wantsBrowserPaywall) return new Response(browserPaywall.generateHtml(challenge as any, { appName: "Link Lens", currentUrl: request.url, testnet: false }), { status: 402, headers: { ...paymentHeaders, "content-type": "text/html; charset=utf-8" } });
    return Response.json(challenge, { status: 402, headers: paymentHeaders });
  }
  if (outcome.kind === "rejected") {
    console.error("[x402] payment rejected:", outcome.reason);
    if (wantsBrowserPaywall && challenge) return new Response(browserPaywall.generateHtml(challenge as any, { appName: "Link Lens", currentUrl: request.url, testnet: false }), { status: outcome.status ?? 402, headers: { ...paymentHeaders, "content-type": "text/html; charset=utf-8" } });
    return Response.json({ error: outcome.reason, ...(challenge as object ?? {}) }, { status: outcome.status ?? 402, headers: paymentHeaders });
  }

  const paymentResponseHeaders = outcome.settlementHeader ? { "PAYMENT-RESPONSE": outcome.settlementHeader } : undefined;
  const target = request.nextUrl.searchParams.get("url");
  const url = target ? safeUrl(target) : null;
  if (!url) {
    return Response.json(
      { error: "The url query parameter must be a safe public HTTP(S) URL." },
      { status: 400, headers: paymentResponseHeaders }
    );
  }
  try {
    const fetched = await fetchPublicPage(url);
    const response = fetched.response;
    if (!response.ok) return Response.json({ error: "Target returned " + response.status + "." }, { status: 502 });
    const html = (await response.text()).slice(0, 1000000);
    const $ = cheerio.load(html);
    $("script,style,noscript").remove();
    return Response.json({
      url: fetched.url.toString(),
      canonicalUrl: $("link[rel=canonical]").attr("href") ?? fetched.url.toString(),
      title: $("title").first().text().trim(),
      description: $("meta[name=description]").attr("content")?.trim() ?? "",
      contentType: response.headers.get("content-type"),
      text: $("body").text().replace(/\s+/g, " ").trim().slice(0, 20000),
      links: $("a[href]").toArray().slice(0, 100).map(element => $(element).attr("href"))
    }, { headers: paymentResponseHeaders });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not reach target URL." }, { status: 502 });
  }
}

export async function HEAD(request: NextRequest) {
  if (!request.nextUrl.searchParams.get("url")) return new Response(null, { status: 204 });
  return new Response(null, { status: 200 });
}
