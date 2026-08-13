# Security

## Key custody

Store `MASTER_KEY`, `MASTER_SHARE_V*`, imported client keys, RPC keys, and inbound API keys only with `wrangler secret put`. Never place them in `wrangler.jsonc`, `.dev.vars.example`, a shell history, CI logs, or source control. Rotate a secret by publishing a new Worker version, then confirm old versions cannot receive traffic.

Cloudflare encrypts Worker secrets, but Worker code can read their plaintext at runtime. A deployment therefore trusts Cloudflare's control plane and execution fleet as well as this repository and its dependency graph. Use an enclave or self-operated key server instead if that trust model is unacceptable.

## Production controls

- Use a paid Worker plan and set an explicit CPU limit.
- Put Cloudflare rate limiting or a WAF rule in front of `/v1/fetch_key`; BLS operations make untrusted requests costly.
- Use a dedicated authenticated Sui gRPC endpoint with quotas and alerts.
- Restrict `wrangler` and repository access, require MFA, and review every dependency update.
- Keep `package-lock.json` committed and run `npm ci`, `npm audit`, the deterministic suite, and the live suite before deployment.
- Verify `/v1/service` proof of possession from an independent client after every key or deployment change.
- Monitor 401, 403, 426, 503, CPU-limit, and RPC failure rates in Cloudflare Logs.

The optional `API_KEY_NAME`/`API_KEY` gate uses a constant-work comparison and applies to protocol routes, but a shared header is not a substitute for rate limiting. It is unsuitable as a secret in a public browser bundle.

## Reporting a vulnerability

Do not open a public issue containing key material, exploit details, or a live vulnerable endpoint. Use GitHub's private vulnerability reporting for this repository. Revoke exposed secrets before sending the report.
