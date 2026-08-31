# SeedHape x402 Marketplace Listing Template

Use this template when creating a paid HTTP service with `@seedhape/x402-merchant-sdk` that should be automatically discovered by Coinbase CDP Bazaar and then ingested by Agentic Market.

There is no separate Bazaar publish API. A service becomes eligible for automatic indexing when it:

1. is deployed at a public HTTPS URL;
2. returns a valid x402 v2 `402 Payment Required` challenge;
3. includes complete Bazaar discovery metadata;
4. successfully verifies and settles a fresh payment through the authenticated CDP facilitator.

Agentic Market maintains a separate downstream index. It can appear before or after a CDP discovery query refreshes, so verify both indexes independently.

## 1. Define the service

Replace these values throughout the template:

| Placeholder | Example | Purpose |
| --- | --- | --- |
| `<SERVICE_NAME>` | `Weather Snapshot` | Human-readable marketplace name |
| `<DESCRIPTION>` | `Return current weather for a city.` | Searchable, agent-oriented description |
| `<CATEGORY>` | `weather` | Marketplace category |
| `<TAGS>` | `weather, forecast, data` | Search and Agentic enrichment tags |
| `<RESOURCE_PATH>` | `/api/weather` | Stable catalog path |
| `<CALLABLE_URL>` | `https://api.example.com/api/weather?city=Miami` | Complete request used for validation and payment |
| `<STABLE_URL>` | `https://api.example.com/api/weather` | URL stored in the catalog and used for exact lookup |
| `<PRICE_BASE_UNITS>` | `10000` | USDC base units; `10000` is `0.01 USDC` |
| `<MERCHANT_WALLET>` | `0x...` | Address receiving USDC |
| `<DOCS_URL>` | `https://api.example.com/docs` | Public, free usage documentation |

Use a stable resource path in the catalog. Advertise user input separately through the Bazaar input metadata.

## 2. Install the SDKs

```bash
npm install @seedhape/x402-merchant-sdk @coinbase/cdp-sdk
```

For a browser payment page, also install:

```bash
npm install @x402/paywall
```

## 3. Configure server-only environment variables

```env
CDP_API_KEY_ID=organizations/.../apiKeys/...
CDP_API_KEY_SECRET=...
CDP_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
MERCHANT_WALLET=0xYourMerchantWallet

# Used by repository verification scripts; rename for a shared template if desired.
LINKLENS_BAZAAR_HOST=api.example.com
LINKLENS_BAZAAR_URL=https://api.example.com/api/weather
LINKLENS_VALIDATE_URL=https://api.example.com/api/weather?city=Miami
```

Never expose CDP credentials, wallet secrets, private keys, or seed phrases to browser code. Do not use `CDP_API_KEY_SECRET` directly as a bearer token.

## 4. Use the authenticated CDP facilitator

Passing only the CDP URL does not authenticate verification and settlement. Create the facilitator client with the CDP SDK:

```ts
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";

const cdpFacilitator = {
  url:
    process.env.CDP_FACILITATOR_URL ||
    "https://api.cdp.coinbase.com/platform/v2/x402",
  client: createCdpFacilitatorClient({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  }),
};
```

The injected client creates the short-lived, request-bound JWTs required by CDP.

## 5. Create complete marketplace metadata

Start with explicit input and output schemas. Agents use these fields to decide whether and how to call the service.

```ts
import { base, merchantConfig, Paywall } from "@seedhape/x402-merchant-sdk";

const config = merchantConfig(base, {
  payTo: process.env.MERCHANT_WALLET!,
  facilitator: cdpFacilitator,
  facilitators: {
    eip3009: cdpFacilitator,
    // Add an ERC-7710 facilitator only when it is actually supported.
    // erc7710: erc7710Facilitator,
  },
  paymentMethods: ["eip3009"],
  price: { amount: 10_000n, ...base },
  description: "<DESCRIPTION>",
  route: {
    name: "<SERVICE_NAME>",
    description: "<DESCRIPTION>",
    category: "<CATEGORY>",
    docsUrl: "<DOCS_URL>",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City to look up",
          examples: ["Miami"],
        },
      },
      required: ["city"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        temperatureC: { type: "number" },
        conditions: { type: "string" },
      },
      required: ["city", "temperatureC", "conditions"],
      additionalProperties: false,
      examples: [
        {
          city: "Miami",
          temperatureC: 28,
          conditions: "clear",
        },
      ],
    },
  },
  receipts: {
    record: async (receipt) => {
      // Persist receipt.id, resource, payer, amount, network, and transaction.
    },
  },
});

const paywall = new Paywall(config);
```

Use accurate output metadata instead of only `{ type: "object" }`. The installed SeedHape SDK publishes the schema but currently initializes the Bazaar output example as `{}`. Section 6 explicitly enriches that example until the SDK supports an output-example configuration directly.

USDC uses six decimal places:

```text
1,000 base units = 0.001 USDC (CDP minimum)
10,000 base units = 0.01 USDC
50,000 base units = 0.05 USDC
```

## 6. Make the challenge compatible with CDP and Agentic

The final unpaid challenge should contain all of these values:

```text
resource.url
resource.description
resource.serviceName
resource.tags
extensions.bazaar.category
extensions.bazaar.tags
extensions.bazaar.info.name
extensions.bazaar.info.serviceName
extensions.bazaar.info.description
extensions.bazaar.info.input.type
extensions.bazaar.info.input.method
extensions.bazaar.info.input.queryParams
extensions.bazaar.info.output
extensions.bazaar.schema
```

Agentic Market can ingest a valid CDP resource but hide it when the normalized record has an empty top-level `serviceName`. Until the installed SeedHape SDK emits all top-level fields natively, enrich both the JSON challenge and encoded `PAYMENT-REQUIRED` header:

```ts
const serviceName = "<SERVICE_NAME>";
const tags = ["<TAG_1>", "<TAG_2>", "<TAG_3>"];
const outputExample = {
  city: "Miami",
  temperatureC: 28,
  conditions: "clear",
};

function enrichMarketplaceChallenge(challenge: any) {
  if (!challenge || typeof challenge !== "object") return challenge;

  if (challenge.resource) {
    challenge.resource.serviceName = serviceName;
    challenge.resource.tags = tags;
  }

  const bazaar = challenge.extensions?.bazaar;
  if (bazaar) {
    bazaar.category = "<CATEGORY>";
    bazaar.tags = tags;

    if (bazaar.info) {
      bazaar.info.name = serviceName;
      bazaar.info.serviceName = serviceName;
      bazaar.info.input.queryParams = {
        city: "Miami",
      };
      bazaar.info.output = {
        ...(bazaar.info.output || {}),
        type: "json",
        example: outputExample,
      };
    }
  }

  return challenge;
}

function enrichPaymentRequiredHeader(header?: string) {
  if (!header) return header;

  try {
    const challenge = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    );
    enrichMarketplaceChallenge(challenge);
    return Buffer.from(JSON.stringify(challenge)).toString("base64");
  } catch {
    return header;
  }
}
```

Remove this compatibility layer only after an SDK upgrade is proven to emit equivalent JSON and header metadata.

## 7. Enforce the correct request order

Run the x402 paywall before authentication, query validation, body validation, or business logic.

Required behavior:

```text
Unauthenticated GET <STABLE_URL>                    -> 402
Unauthenticated GET <CALLABLE_URL>                  -> 402
Paid request with missing or invalid input          -> 400
Paid request with valid input                       -> 200
Successful paid response                            -> PAYMENT-RESPONSE header
```

Do not return `400` for a missing query parameter before invoking the paywall. CDP and other discovery crawlers probe the stable route without user input and require a `402` response.

Framework middleware must therefore be ordered like this:

```text
request
  -> x402 paywall
  -> input validation
  -> business logic
  -> paid response
```

## 8. Preserve the complete callable URL

When calling `Paywall.handle()`, use the original request URL as the payment resource:

```ts
const outcome = await paywall.handle({
  path: "<RESOURCE_PATH>",
  method: request.method,
  query: request.nextUrl.searchParams,
  resource: request.url,
  paymentHeader:
    request.headers.get("payment-signature") ??
    request.headers.get("x-payment"),
});
```

Do not replace `request.url` with only the stable path. Browser payment clients retry the URL declared in the challenge. Removing the query string causes the paid retry to lose required input.

CDP can still normalize the successfully called URL into the stable catalog route after crawling or settlement.

## 9. Encode x402 v2 headers correctly

The `PAYMENT-REQUIRED` header must contain standard Base64-encoded JSON:

```ts
Buffer.from(JSON.stringify(challenge)).toString("base64");
```

Do not write the header with Base64URL. A malformed encoding can fail CDP validation with:

```text
Payment-Required header could not be decoded
```

Use the x402 v2 header names:

```text
PAYMENT-REQUIRED   server -> buyer
PAYMENT-SIGNATURE  buyer  -> server
PAYMENT-RESPONSE   server -> buyer
```

## 10. Deploy and run preflight checks

Deploy the service to a public HTTPS origin. Then check the stable route without payment:

```bash
curl -i "<STABLE_URL>"
```

It must return:

```text
HTTP/2 402
PAYMENT-REQUIRED: <base64-json>
```

Decode and inspect the challenge locally. Confirm:

- `x402Version` is `2`;
- `resource.url` is HTTPS;
- at least one `accepts` entry is present;
- network is `eip155:8453` for Base mainnet;
- amount is at least `1000` base units;
- Base USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`;
- `payTo` is the intended merchant wallet;
- `maxTimeoutSeconds` is set;
- Bazaar input, output, schema, service name, category, and tags are populated.

## 11. Validate a complete callable URL

Validate the endpoint using a real example input, not only the bare stable route:

```bash
npm run bazaar:check -- --validate
```

Set `LINKLENS_VALIDATE_URL` to `<CALLABLE_URL>` before running the repository script. The required result is:

```json
{
  "valid": true,
  "simulation": {
    "outcome": "accepted"
  }
}
```

If preflight reports `400 instead of 402`, input or auth validation is still running before the paywall.

## 12. Trigger automatic Bazaar indexing

After every deployment that changes the resource URL, price, payment methods, or discovery metadata:

1. Hard-refresh the browser or use a private window.
2. Request a new `402` challenge from `<CALLABLE_URL>`.
3. Confirm the new challenge contains the deployed metadata.
4. Create a fresh payment signature.
5. Retry the same complete callable URL.
6. Confirm the paid response returns `200`.
7. Decode `PAYMENT-RESPONSE` and confirm `success: true`.

Never reuse a payment signature from an older challenge. Do not share payment signatures in logs, tickets, or chat.

A successful response resembles:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:8453",
  "payer": "0x..."
}
```

Settlement proves payment succeeded, but discovery indexing is asynchronous and must be checked separately.

## 13. Verify CDP Bazaar and Agentic Market

Search CDP with the complete stable resource URL, not only the hostname. Hostname-only `urlSubstring` searches have produced intermittent false negatives.

```text
Correct:   https://api.example.com/api/weather
Avoid:     api.example.com
```

In this repository:

```bash
npm run bazaar:check -- --search
npm run listings:check
```

For detailed output:

```bash
npm run listings:check -- --json
```

`listings:check` exits with status `0` only when both CDP Bazaar and Agentic Market contain the service. It exits with status `1` when either index is missing the service, making it suitable for CI or monitoring.

Expected final result:

```text
PASS  CDP Bazaar listing
      1 matching resource(s)
PASS  Agentic Market listing
      1 matching service(s)
```

The CDP setup wizard may show `Found on Bazaar` before all discovery queries refresh. Agentic can also ingest the service on a different schedule. Wait for propagation and retry before changing a challenge that already passes validation.

## 14. Release checklist

- [ ] Service is deployed at a public HTTPS URL.
- [ ] CDP credentials exist only in the server environment.
- [ ] EIP-3009 uses `createCdpFacilitatorClient()`.
- [ ] Only genuinely supported payment methods are advertised.
- [ ] The bare stable route returns `402` before input validation.
- [ ] A complete callable URL also returns `402` when unpaid.
- [ ] `PAYMENT-REQUIRED` is standard Base64 and decodes as JSON.
- [ ] `resource.url` preserves the complete request URL and input.
- [ ] `resource.serviceName` and `resource.tags` are populated.
- [ ] Bazaar name, description, category, and tags are populated.
- [ ] Input metadata includes method, parameter examples, and required fields.
- [ ] Output metadata contains an accurate schema and realistic example.
- [ ] Price, asset, network, merchant wallet, and timeout are correct.
- [ ] CDP validation reports `valid: true` and simulation `accepted`.
- [ ] A fresh post-deployment payment returns `200`.
- [ ] `PAYMENT-RESPONSE` reports `success: true`.
- [ ] Exact stable-URL search finds the CDP Bazaar resource.
- [ ] Agentic Market contains a non-empty service name and tags.
- [ ] `npm run listings:check` passes for both indexes.

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Stable endpoint returns `400` | Input validation runs before x402 | Move the paywall ahead of validation |
| Stable endpoint returns `200` | Route is not payment-gated | Apply the SeedHape paywall to the route |
| CDP cannot decode the challenge | Header was written as Base64URL or malformed JSON | Write standard Base64 JSON |
| Paid browser retry returns `400` | Challenge resource dropped the query string | Use the original request URL |
| Settlement fails at CDP | Facilitator is missing authenticated SDK client | Use `createCdpFacilitatorClient()` |
| Settlement succeeds but listing is missing | Indexing is asynchronous or metadata was stale | Make one fresh payment and wait for propagation |
| URL search returns no CDP match | Search used only the hostname | Search using the complete stable resource URL |
| Agentic API has a record but UI hides it | Top-level service name or tags are empty | Populate `resource.serviceName` and `resource.tags` |
| Listing output is `{}` | Output schema/example is incomplete | Publish the actual response schema and example |

## 16. Security and production requirements

- Never commit CDP secrets, wallet secrets, private keys, or seed phrases.
- Never share `PAYMENT-SIGNATURE`; it is a signed payment authorization.
- Public transaction hashes and decoded settlement responses are generally safe for debugging.
- Keep `payTo`, asset, network, amount, and resource server-controlled.
- Validate redirects and block private, loopback, local, and internal network targets.
- Apply request timeouts, response-size limits, rate limits, and receipt logging.
- Keep health and public documentation routes free when operational monitoring requires them.
- Rotate any credential that is accidentally exposed.

## 17. Reference implementation files

- `app/api/inspect/route.ts` — Next.js payment route and LinkLens reference implementation.
- `scripts/check-bazaar.mjs` — CDP JWT generation, validation, merchant lookup, and exact stable-URL search.
- `scripts/check-listings.mjs` — combined CDP Bazaar and Agentic Market verification.
- `.env.example` — deployment configuration template without real credentials.

The LinkLens reference values are intentionally service-specific. When copying the scripts into another project, replace the default host, stable URL, callable validation URL, service labels, and environment-variable names.
