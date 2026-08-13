# Seal Cloudflare

A Seal-compatible key server implemented as an on-demand Cloudflare Worker. It ports the request-serving behavior of the [MystenLabs Seal key server](https://github.com/MystenLabs/seal/tree/main/crates/key-server) without requiring a persistent VM, container, database, Durable Object, or KV namespace.

The implementation tracks upstream Seal key server `0.6.13` at commit [`baff7c5`](https://github.com/MystenLabs/seal/commit/baff7c5aa9012741cb25321b1beeab58ec8a7ee3). It supports open, permissioned, and committee partial-key-server modes.

> [!IMPORTANT]
> Use a **paid Cloudflare Workers plan**. BLS12-381 hash-to-curve and pairing work can exceed the free plan's 10 ms CPU allowance. The supplied configuration requests 30 seconds of CPU time. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Live Testnet deployment

The repository's `main` branch deploys automatically to
[`https://seal-key-server.miraicloud.workers.dev`](https://seal-key-server.miraicloud.workers.dev/health).
The live service was last verified on August 13, 2026 with `@mysten/seal` 1.4.0.

| Resource | Value |
| --- | --- |
| Worker | `seal-key-server` |
| Network | Sui Testnet |
| Key-server object | [`0x501b8b579470ef879b6c9e581e7b7d9c1ffe7fc749e7e2366bfaa7b655b7b3c3`](https://testnet.suivision.xyz/object/0x501b8b579470ef879b6c9e581e7b7d9c1ffe7fc749e7e2366bfaa7b655b7b3c3) |
| Registration transaction | [`HdDqjdfSAUqj2evqSM1WP41cTinD9VuDB57S7yojiVCJ`](https://testnet.suivision.xyz/txblock/HdDqjdfSAUqj2evqSM1WP41cTinD9VuDB57S7yojiVCJ) |
| E2E policy package | `0xc5ce2742cac46421b62028557f1d7aea8a4c50f651379a79afdf12cd88628807` |
| E2E allowlist object | [`0xe7411c57566894283716ccbed77d36027bb98ec2c696292089c93f983b745ad9`](https://testnet.suivision.xyz/object/0xe7411c57566894283716ccbed77d36027bb98ec2c696292089c93f983b745ad9) |
| Deployment workflow | [Latest `main` runs](https://github.com/miraicloud/seal-key-server-cloudflare/actions/workflows/ci.yml?query=branch%3Amain) |

The live E2E test encrypts locally, verifies the Worker's proof of possession, authorizes access by
simulating a real `allowlist::seal_approve` PTB, fetches the derived key from `/v1/fetch_key`, and
decrypts back to the exact plaintext. The fixture is for Testnet verification, not a production
access-control policy. The deployed Worker currently uses open mode, so applications must enforce
their intended authorization in their own `seal_approve*` policy.

## What is implemented

- `POST /v1/fetch_key`, including the upstream 180 KiB streaming body limit
- `GET /v1/service?service_id=...` and proof-of-possession generation
- `GET /v1/debug/committee_partial_pk`
- upstream SDK version headers, validation, CORS, error codes, and status codes
- restricted `seal_approve*` PTB validation
- original package-ID lookup over Sui's generally available gRPC API
- strict mainnet and testnet MVR resolution against on-chain records
- personal-message verification, including zkLogin and zkLogin-containing multisig through Sui
- session Ed25519 verification
- address-alias rejection
- on-chain policy simulation with the Seal clock-staleness guard
- Boneh–Franklin BLS12-381 key extraction and ElGamal response encryption
- derived, imported, exported, and versioned committee key handling
- optional shared-header authentication for backend or committee deployments

The upstream Prometheus server and background event monitors are not copied into the Worker. Request correctness does not depend on them: gas price, package identity, MVR records, and committee versions are read on demand and cached only within an isolate. Use Cloudflare Logs/Analytics and alerts for operations. The upstream committee **aggregator** remains a separate service; this Worker replaces each partial key server behind it.

## Architecture

```text
Seal SDK / committee aggregator
              |
              | Seal HTTP protocol
              v
      Cloudflare Worker isolate
      - config + encrypted secrets
      - PTB/signature validation
      - BLS key extraction
              |
              | gRPC-web over fetch()
              v
          Sui full node
```

No correctness state is stored at the edge. Module-scope caches reduce repeated RPC reads while an isolate is warm; a cold isolate produces the same result by reading Sui again.

## Quick start: open mode

Requirements: Node.js 22 or newer, npm, a paid Workers account, and a registered Seal key-server object whose public key matches your master key.

1. Install and verify:

   ```sh
   npm ci
   npm run check
   npm test
   npm run build
   ```

2. Edit `wrangler.jsonc`. Set `NETWORK` and replace `KEY_SERVER_CONFIG` with a minified JSON string:

   ```json
   {
     "mode": "open",
     "keyServerObjectId": "0xYOUR_KEY_SERVER_OBJECT_ID"
   }
   ```

3. Store the 32-byte, non-zero BLS scalar as an encrypted Worker secret. Hex is recommended; base64 is accepted in open mode for upstream backward compatibility.

   ```sh
   npx wrangler secret put MASTER_KEY
   ```

4. Authenticate and deploy:

   ```sh
   npx wrangler login
   npx wrangler deploy
   ```

   Pushes to `main` also deploy automatically after CI passes when the repository has
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` Actions secrets. The configured Worker name
   is `seal-key-server`, producing `https://seal-key-server.miraicloud.workers.dev` for the
   `miraicloud` Workers account subdomain.

   The deployed Testnet key-server object is
   `0x501b8b579470ef879b6c9e581e7b7d9c1ffe7fc749e7e2366bfaa7b655b7b3c3`.

5. Confirm the service proof through your deployed URL:

   ```sh
   curl -H 'Client-Sdk-Type: typescript' \
     -H 'Client-Sdk-Version: 1.4.0' \
     'https://seal-key-server.miraicloud.workers.dev/v1/service?service_id=0x501b8b579470ef879b6c9e581e7b7d9c1ffe7fc749e7e2366bfaa7b655b7b3c3'
   ```

The deployment workflow contains no key material. `.dev.vars` and `.env` are ignored, and Worker
secrets remain stored in Cloudflare across code deployments.

For a brand-new Worker, run the **Initialize Cloudflare master key** workflow once. It generates
the BLS scalar inside the Actions runner, writes it directly to the Worker's `MASTER_KEY` secret,
and reports only the public key needed for on-chain registration. It refuses to replace an existing
`MASTER_KEY`.

## Server modes

### Open

One master key serves every package. `MASTER_KEY` is a 32-byte BLS scalar.

```json
{
  "mode": "open",
  "keyServerObjectId": "0x..."
}
```

### Permissioned

Only configured original package IDs are served. `MASTER_KEY` is a 32-byte HKDF seed in hex, matching upstream derivation exactly.

```json
{
  "mode": "permissioned",
  "clients": [
    {
      "name": "derived-client",
      "keyServerObjectId": "0x...",
      "packageIds": ["0x..."],
      "key": { "type": "derived", "derivationIndex": 0 }
    },
    {
      "name": "imported-client",
      "keyServerObjectId": "0x...",
      "packageIds": ["0x..."],
      "key": { "type": "imported", "secretBinding": "CLIENT_B_MASTER_KEY" }
    },
    {
      "name": "retired-client",
      "keyServerObjectId": "0x...",
      "packageIds": ["0x..."],
      "key": { "type": "exported", "deprecatedDerivationIndex": 1 }
    }
  ]
}
```

Add every imported key as a Worker secret:

```sh
npx wrangler secret put CLIENT_B_MASTER_KEY
```

Derived and exported indices together must be unique and contiguous from zero. Exported entries reserve derivation history but are intentionally not served.

### Committee partial key server

The Worker reads the V2 key-server object, committee wrapper, member list, current version, and expected partial public key from Sui. It refuses to serve when the configured share does not match the member's on-chain partial key.

```json
{
  "mode": "committee",
  "keyServerObjectId": "0x...",
  "memberAddress": "0x...",
  "state": { "type": "active" }
}
```

If the current on-chain version is 4:

```sh
npx wrangler secret put MASTER_SHARE_V4
```

For a planned rotation to version 5, change the state and configure both shares before deployment:

```json
{ "type": "rotation", "targetVersion": 5 }
```

```sh
npx wrangler secret put MASTER_SHARE_V4
npx wrangler secret put MASTER_SHARE_V5
```

The Worker selects the share from the live on-chain version on each cache refresh. During rotation it uses V4 until Sui advances, then validates and uses V5. If the old share is deliberately omitted, requests fail closed until rotation completes.

## Configuration reference

All values other than secret bindings are strings in the Worker environment.

| Binding | Default | Purpose |
| --- | --- | --- |
| `NETWORK` | `testnet` | `mainnet`, `testnet`, or `devnet` |
| `KEY_SERVER_CONFIG` | required | Mode configuration as JSON |
| `NODE_URL` | Mysten public gRPC | Primary Sui gRPC endpoint |
| `MAINNET_NODE_URL` | Mysten public mainnet gRPC | Mainnet endpoint used for testnet MVR records |
| `SEAL_PACKAGE` | built in | Required only for a custom devnet Seal staleness package |
| `SESSION_KEY_TTL_MAX_MINUTES` | `30` | Maximum certificate lifetime |
| `ALLOWED_STALENESS_MS` | `120000` | Clock drift accepted by the on-chain guard |
| `RPC_TIMEOUT_MS` | `60000` | Per-attempt fetch timeout |
| `RPC_MAX_ATTEMPTS` | `3` | Retry count for transient gRPC failures |
| `*_SDK_VERSION_REQUIREMENT` | upstream defaults | Semver gates for aggregator, TypeScript, Rust, and Python clients |
| `FULL_NODE_RPC_API_NAME` | unset | Header name for the primary RPC provider |
| `FULL_NODE_RPC_API_KEY` | unset | Secret header value for the primary RPC provider |
| `MAINNET_FULL_NODE_RPC_API_NAME` | unset | Header name for the MVR mainnet RPC provider |
| `MAINNET_FULL_NODE_RPC_API_KEY` | unset | Secret header value for the MVR mainnet RPC provider |
| `API_KEY_NAME` | unset | Optional inbound client/aggregator header name |
| `API_KEY` | unset | Optional inbound header value, stored as a secret |

Header-name and key bindings must be configured in pairs. Separate primary and MVR-mainnet credentials prevent a provider key from being sent to the wrong endpoint.

For authenticated RPC:

```sh
npx wrangler secret put FULL_NODE_RPC_API_KEY
```

Add the non-secret header name, for example `x-api-key`, to `vars` in `wrangler.jsonc`. For optional inbound authentication, add `API_KEY_NAME` to `vars` and store `API_KEY` with `wrangler secret put`. Browser applications generally cannot keep a shared API key secret; use this feature for server-side clients or committee aggregators.

## Development and verification

```sh
npm run check       # strict TypeScript
npm test            # deterministic unit and SDK compatibility tests
npm run test:live   # read-only testnet/mainnet gRPC and MVR checks
npm run test:e2e    # live Seal SDK round trip through the deployed Worker
npm run build       # Cloudflare dry-run bundle
npm audit           # dependency advisory scan
```

The deterministic suite includes Rust regression vectors for HKDF derivation, signed personal messages, and signed request BCS; BLS extraction/ElGamal/PoP equations; current `@mysten/seal` `SessionKey` output; all server modes; API headers; and request-size enforcement.

Run the live Seal TypeScript SDK encrypt/decrypt flow against the deployed Worker:

```sh
SUI_ADDRESS=0x1f86f02d2a7187c33e790c667333220069c46e00141a9c18661a1340aef89ca2 npm run test:e2e
```

The address must be present in the Sui CLI Ed25519 keystore and in the Testnet fixture allowlist.
Alternatively, pass its Bech32 private key through `SUI_PRIVATE_KEY`. The script encrypts locally,
builds an `allowlist::seal_approve` PTB, creates a signed Seal session, obtains the derived key from
`/v1/fetch_key`, decrypts locally, and asserts byte-for-byte equality. Setup transactions use Sui
address-balance gas by calling `tx.setGasPayment([])`.

## Security notes

A Worker secret is encrypted at rest and exposed to Worker code only through its binding, but using this design places the master key inside Cloudflare's execution trust boundary. That is materially different from an enclave or a self-operated host. Read [SECURITY.md](SECURITY.md) before production use and apply Cloudflare rate limiting—the public fetch endpoint performs intentionally expensive cryptography.

This project is Apache-2.0 licensed and includes attribution for the upstream Seal implementation in [NOTICE](NOTICE).
