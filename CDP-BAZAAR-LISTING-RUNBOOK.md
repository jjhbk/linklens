# CDP Bazaar Listing Runbook

This document records the fixes required to list LinkLens in the Coinbase CDP x402 Bazaar. Use it when changing the payment route, upgrading x402 dependencies, or deploying a new version.

## Final working configuration

LinkLens exposes this paid endpoint:

```text
GET https://linklens-sand.vercel.app/api/inspect?url=https://example.com
```

The Bazaar catalog stores the stable route:

```text
https://linklens-sand.vercel.app/api/inspect
```

The `url` value is advertised separately in the Bazaar query-parameter metadata.

The route charges `0.01 USDC` on Base mainnet and advertises EIP-3009 and ERC-7710. EIP-3009 settlement uses the authenticated CDP facilitator.

## Fixes that made listing work

### 1. Use an authenticated CDP facilitator client

Setting the facilitator URL alone does not authenticate verify and settle requests. Build the facilitator client with `createCdpFacilitatorClient()` and server-only credentials:

```env
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
```

Never expose these credentials to the browser or use the raw secret as a bearer token. The CDP SDK generates short-lived request-bound JWTs.

### 2. Include complete Bazaar route metadata

The route must advertise:

- a service name and description;
- a top-level `resource.serviceName` and `resource.tags` value for Agentic Market;
- HTTP method;
- an example `url` query parameter;
- a JSON Schema marking `url` as required;
- output metadata.

The Seedhape adapter generated the input schema but initially emitted an empty `info.input.queryParams` object. LinkLens enriches both the JSON challenge and encoded `PAYMENT-REQUIRED` header with:

```json
{
  "queryParams": {
    "url": "https://example.com"
  }
}
```

Keep the example value and schema consistent.

Agentic Market may ingest a valid CDP Bazaar resource but hide it from the UI when its normalized record has `enriched: false` and an empty top-level `serviceName`. To avoid that, LinkLens also writes the service name and tags to the challenge resource and writes category/tags to `extensions.bazaar`. Keeping the name only under `extensions.bazaar.info` was not sufficient for Agentic Market's UI filter.

### 3. Encode `PAYMENT-REQUIRED` as standard Base64

CDP expects the header to be standard Base64-encoded JSON. Base64URL caused validation to fail with:

```text
Payment-Required header could not be decoded
```

Use:

```ts
Buffer.from(JSON.stringify(challenge)).toString("base64")
```

Do not use `base64url` when writing this header.

### 4. Preserve the full request URL in the payment challenge

The payment challenge must use the original request URL, including its query string:

```ts
resource: request.url
```

Do not replace it with only `/api/inspect`. The browser payment client retries the URL declared in `resource.url`. When the query string was removed, the paid retry became:

```text
GET /api/inspect
```

and LinkLens returned `400` because the required `url` input was missing.

CDP normalizes a valid query-based resource into the stable catalog route after settlement. A working catalog entry can therefore store `/api/inspect` while paid requests still use `/api/inspect?url=...`.

### 5. Validate with a complete callable URL

The endpoint requires a `url` query parameter to perform an inspection, so validate this complete example when testing request execution:

```text
https://linklens-sand.vercel.app/api/inspect?url=https://example.com
```

The paywall must run before query-parameter validation. Discovery platforms probe the stable bare route, so an unauthenticated request to `/api/inspect` must return `402`, not `400`. After payment succeeds, a request with a missing or unsafe `url` may return `400` with a clear input error.

Run:

```bash
npm run bazaar:check -- --validate
```

The required result is:

```json
{
  "valid": true,
  "simulation": {
    "outcome": "accepted"
  }
}
```

### 6. Make a fresh payment after every discovery-metadata change

CDP indexes metadata observed during a successful verify and settle cycle. Old payments do not republish changed metadata.

After deploying a payment-resource or Bazaar metadata change:

1. Hard-refresh the browser or use an Incognito window.
2. Request a new `402` challenge.
3. Confirm the challenge contains the expected resource URL and metadata.
4. Create a fresh payment signature.
5. Confirm the paid retry returns `200` and a `PAYMENT-RESPONSE` header.

Never reuse a payment signature created from an older challenge.

### 7. Confirm settlement separately from catalog indexing

A successful response header decodes to a payload similar to:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:8453",
  "payer": "0x..."
}
```

Decode it locally with:

```js
JSON.parse(atob("<PAYMENT-RESPONSE>"))
```

Successful onchain settlement does not by itself prove that the discovery index was updated. Validate and search the catalog separately.

### 8. Search Bazaar with `urlSubstring`

The catalog contains thousands of entries. Fetching `limit=100` checks only the first page, and semantic `query` search is not an exact URL lookup.

Use CDP's `urlSubstring` filter. The repository script does this with:

```bash
npm run bazaar:check -- --search
```

The successful result contains:

```text
LinkLens is listed in the CDP Bazaar.
```

and a resource matching:

```text
https://linklens-sand.vercel.app/api/inspect
```

## Release checklist

Before considering a Bazaar-related release complete:

- [ ] CDP credentials exist in the deployed server environment.
- [ ] EIP-3009 uses `createCdpFacilitatorClient()`.
- [ ] The unpaid request returns `402`, not `400` or `200`.
- [ ] `PAYMENT-REQUIRED` is standard Base64 and decodes as JSON.
- [ ] `resource.url` preserves the actual request query string.
- [ ] `extensions.bazaar.info.input.queryParams.url` has an example value.
- [ ] `resource.serviceName`, `resource.tags`, `extensions.bazaar.category`, and `extensions.bazaar.tags` are populated.
- [ ] The schema marks `url` as a required URI string.
- [ ] `npm run bazaar:check -- --validate` reports `valid: true`.
- [ ] A fresh post-deployment payment returns `200`.
- [ ] `PAYMENT-RESPONSE` reports `success: true`.
- [ ] `npm run bazaar:check -- --search` finds the stable catalog resource.

## Security notes

- Never commit or share `CDP_API_KEY_SECRET`, wallet secrets, private keys, or seed phrases.
- Do not share `payment-signature`; it is a temporary signed payment authorization.
- A public transaction hash and decoded `PAYMENT-RESPONSE` are generally safe for debugging.
- Keep SSRF protections, redirect validation, response-size limits, and timeouts enabled on the URL inspector.
- Rotate any credential that is accidentally exposed.

## Relevant files

- `app/api/inspect/route.ts` — paywall, Bazaar metadata, payment handling, and URL inspection.
- `scripts/check-bazaar.mjs` — CDP JWT generation, validation, merchant lookup, and exact URL-filter search.
- `.env.example` — deployment configuration template without real secrets.
