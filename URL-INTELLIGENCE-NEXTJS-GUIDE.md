# Build a URL Intelligence API with Seedhape

This guide shows how to build a simple paywalled URL inspection API with Next.js and `@seedhape/x402-merchant-sdk`, then list it on [Sonar](https://www.sonar.seedhape.com/).

The API will expose:

```text
GET /api/inspect?url=https://example.com
```

It will return the page title, description, canonical URL, content type, and extracted text after an x402 payment.

## 1. Create the Next.js app

```bash
npx create-next-app@latest url-intelligence --ts --app
cd url-intelligence
npm install @seedhape/x402-merchant-sdk cheerio
```

## 2. Configure the merchant wallet

Create `.env.local`:

```env
MERCHANT_WALLET=0xYourBaseReceivingWallet
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
```

Never expose `MERCHANT_WALLET` or facilitator credentials to the browser.

## 3. Add the paywalled route

Create `app/api/inspect/route.ts`:

```ts
import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import {
  BASE_MAINNET,
  Paywall,
  type Receipt,
} from "@seedhape/x402-merchant-sdk";

export const runtime = "nodejs";

const receipts: Receipt[] = [];

const paywall = new Paywall({
  ...BASE_MAINNET,
  payTo: process.env.MERCHANT_WALLET!,
  facilitator: {
    url: process.env.FACILITATOR_URL!,
  },
  paymentMethods: ["eip3009", "erc7710"],
  price: {
    amount: 2_000n, // 0.002 USDC
    ...BASE_MAINNET,
  },
  description: "Extract metadata and readable text from a public URL",
  receipts: {
    record: async (receipt) => {
      receipts.push(receipt);
      // Replace this with Postgres, SQLite, or another durable database.
    },
});

function isSafePublicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
    if (url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) return null;
    return url;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("url");
  if (!target) return Response.json({ error: "Missing url parameter." }, { status: 400 });

  const targetUrl = isSafePublicUrl(target);
  if (!targetUrl) return Response.json({ error: "Only safe public HTTP(S) URLs are supported." }, { status: 400 });

  const paymentHeader = request.headers.get("x-payment");
  const resource = request.url;
  const outcome = await paywall.handle({
    path: "/api/inspect",
    method: "GET",
    query: request.nextUrl.searchParams,
    resource,
    paymentHeader,
  });

  if (outcome.kind === "challenge") {
    return Response.json(outcome.challenge, { status: 402 });
  }
  if (outcome.kind === "rejected") {
    return Response.json({ error: outcome.reason, ...(outcome.challenge as object ?? {}) }, { status: outcome.status ?? 402 });
  }

  const response = await fetch(targetUrl, {
    headers: { "user-agent": "Seedhape-URL-Intelligence/1.0" },
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
  });
  if (!response.ok) return Response.json({ error: `Target returned ${response.status}.` }, { status: 502 });

  const html = (await response.text()).slice(0, 1_000_000);
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  return Response.json({
    url: targetUrl.toString(),
    canonicalUrl: $("link[rel=canonical]").attr("href") ?? targetUrl.toString(),
    title: $("title").first().text().trim(),
    description: $("meta[name=description]").attr("content")?.trim() ?? "",
    contentType: response.headers.get("content-type"),
    text: $("body").text().replace(/\\s+/g, " ").trim().slice(0, 20_000),
    links: $("a[href]").toArray().slice(0, 100).map((element) => $(element).attr("href")),
  });
}
```

The example uses an in-memory receipt list only to stay simple. Use durable storage in production.

## 4. Run and test locally

```bash
npm run dev
curl -i "http://localhost:3000/api/inspect?url=https://example.com"
```

The first request should return `402 Payment Required`. The response contains the amount, Base network, USDC contract, merchant wallet, and advertised payment methods.

Use a compatible x402 client to pay and retry the same URL with the returned payment header.

## 5. Add machine-readable documentation

Create `app/llms.txt/route.ts` or a static `public/llms.txt` describing:

```text
# URL Intelligence API

GET https://your-domain.com/api/inspect?url={url}
Price: 0.002 USDC per request
Network: Base mainnet (eip155:8453)
Asset: USDC
Payment methods: EIP-3009, ERC-7710
Returns: JSON metadata and extracted readable text
```

Also expose an OpenAPI document if you plan to support broad agent discovery.

## 6. Deploy

Deploy the Next.js app to your hosting provider and configure:

```env
MERCHANT_WALLET=0xYourBaseReceivingWallet
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
```

Verify that the deployed endpoint returns a `402` before listing it.

## 7. List it on Sonar

Open [sonar.seedhape.com](https://www.sonar.seedhape.com/) and create a service listing with:

- Service name: `URL Intelligence API`
- Public endpoint: `https://your-domain.com/api/inspect?url={url}`
- Method: `GET`
- Description: `Extract title, description, canonical URL, links, and readable text from a public webpage.`
- Input: `url` — public HTTP(S) URL
- Price: `0.002 USDC`
- Network: `Base mainnet / eip155:8453`
- Asset: Base USDC
- Payment methods: EIP-3009 and ERC-7710
- Output: JSON
- Documentation: `https://your-domain.com/llms.txt`

Test the endpoint from Sonar after submitting it. Confirm the listing shows the correct price, wallet, network, and URL before promoting it.

## Security checklist

- Block localhost, private IP ranges, cloud metadata addresses, and internal DNS names.
- Disable redirects or validate every redirect destination.
- Limit response size and request timeouts.
- Allow only HTTP and HTTPS.
- Strip scripts and styles before extracting text.
- Do not accept a merchant wallet, token, network, or price from query parameters.
- Store receipts in durable storage.
- Add rate limits in addition to x402 payment protection.
