import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import { BASE_MAINNET, Paywall, type Receipt } from "@seedhape/x402-merchant-sdk";
import { createPaywall, evmPaywall } from "@x402/paywall";
export const runtime = "nodejs";
const receipts: Receipt[] = [];
const facilitatorUrl = process.env.FACILITATOR_URL || BASE_MAINNET.facilitator.url;
const paywall = process.env.MERCHANT_WALLET ? new Paywall({
  ...BASE_MAINNET,
  payTo: process.env.MERCHANT_WALLET,
  facilitator: {
    url: facilitatorUrl,
    ...(process.env.FACILITATOR_API_KEY ? { apiKey: process.env.FACILITATOR_API_KEY } : {})
  },
  paymentMethods: ["eip3009", "erc7710"],
  price: { amount: BigInt(10000), ...BASE_MAINNET },
  description: "Extract metadata and readable text from a public URL",
  receipts: { record: async receipt => { receipts.push(receipt); } }
}) : null;
const browserPaywall = createPaywall().withNetwork(evmPaywall).withConfig({ appName: "Link Lens", testnet: false }).build();
function safeUrl(value: string): URL | null {
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null; if (["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) return null; return url; } catch { return null; }
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
  const target = request.nextUrl.searchParams.get("url"); const url = target ? safeUrl(target) : null;
  if (!url) return Response.json({ error: "Only safe public HTTP(S) URLs are supported." }, { status: 400 });
  if (!paywall) return Response.json({ error: "Payment service is not configured." }, { status: 503 });
  if (paywall) {
    const outcome = await paywall.handle({ path: "/api/inspect", method: "GET", query: request.nextUrl.searchParams, resource: request.url, paymentHeader: request.headers.get("payment-signature") ?? request.headers.get("x-payment") });
    const paymentHeaders = outcome.paymentRequiredHeader ? { "PAYMENT-REQUIRED": outcome.paymentRequiredHeader } : undefined;
    const wantsBrowserPaywall = request.headers.get("accept")?.includes("text/html");
    if (outcome.kind === "challenge") {
      if (wantsBrowserPaywall) return new Response(browserPaywall.generateHtml(outcome.challenge as any, { appName: "Link Lens", currentUrl: request.url, testnet: false }), { status: 402, headers: { ...paymentHeaders, "content-type": "text/html; charset=utf-8" } });
      return Response.json(outcome.challenge, { status: 402, headers: paymentHeaders });
    }
    if (outcome.kind === "rejected") {
      console.error("[x402] payment rejected:", outcome.reason);
      if (wantsBrowserPaywall && outcome.challenge) return new Response(browserPaywall.generateHtml(outcome.challenge as any, { appName: "Link Lens", currentUrl: request.url, testnet: false }), { status: outcome.status ?? 402, headers: { ...paymentHeaders, "content-type": "text/html; charset=utf-8" } });
      return Response.json({ error: outcome.reason, ...(outcome.challenge as object ?? {}) }, { status: outcome.status ?? 402, headers: paymentHeaders });
    }
  }
  try { const fetched = await fetchPublicPage(url); const response = fetched.response; if (!response.ok) return Response.json({ error: "Target returned " + response.status + "." }, { status: 502 }); const html = (await response.text()).slice(0, 1000000); const $ = cheerio.load(html); $("script,style,noscript").remove(); return Response.json({ url: fetched.url.toString(), canonicalUrl: $("link[rel=canonical]").attr("href") ?? fetched.url.toString(), title: $("title").first().text().trim(), description: $("meta[name=description]").attr("content")?.trim() ?? "", contentType: response.headers.get("content-type"), text: $("body").text().replace(/\s+/g, " ").trim().slice(0, 20000), links: $("a[href]").toArray().slice(0, 100).map(element => $(element).attr("href")) }); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not reach target URL." }, { status: 502 }); }
}

export async function HEAD(request: NextRequest) {
  if (!request.nextUrl.searchParams.get("url")) return new Response(null, { status: 204 });
  return new Response(null, { status: 200 });
}
