# Project Guidance

This repository implements a Seal-compatible key server as a stateless Cloudflare Worker.

## Sui Development Skills

Install community-maintained skills for Sui development:

```sh
npx skills https://github.com/MystenLabs/skills
```

## Sui SDK Reference

Every `@mysten/*` package ships LLM documentation in its `docs/` directory. When working with
these packages, find the relevant docs by looking for `docs/llms-index.md` files inside
`node_modules/@mysten/*/`. Read the index first to find the page you need, then read that page
for details.

## Official Resources

When unsure about Move patterns or Sui APIs, query the Sui documentation MCP server at
`https://sui.mcp.kapa.ai` and consult these sources. Do not guess or extrapolate from other
blockchains.

- Move Book: https://move-book.com (use https://move-book.com/llms.txt)
- Sui Docs: https://docs.sui.io (use https://docs.sui.io/llms.txt)
- Sui Move examples: https://github.com/MystenLabs/sui/tree/main/examples/move

## Project Structure

- `src/` — Cloudflare Worker runtime and Seal protocol implementation
- `test/` — unit, compatibility, and Worker integration tests

## Project Rules

- Preserve wire compatibility with the upstream MystenLabs Seal key server.
- Use the generally available Sui gRPC or GraphQL APIs; do not add JSON-RPC dependencies.
- Never commit master keys, committee shares, RPC credentials, or `.dev.vars`.
