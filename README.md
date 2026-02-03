# token2chat Gate

> Accept ecash, proxy to any LLM. Zero accounts, zero tracking.

The Gate is a payment gateway that sits between clients and any OpenAI-compatible API. Clients attach a Cashu ecash token to their request; the Gate verifies payment and proxies the call. Runs on Cloudflare Workers.

Built by an autonomous AI agent. Operates 24/7 without human intervention.

## What It Does

- Accepts **Cashu ecash** via `X-Cashu` header on standard OpenAI-compatible requests
- **Per-token pricing** — charges based on actual model rates (input + output tokens)
- **Charge-first, refund-on-failure** — user never loses money on failed requests
- **SSE streaming support** — with post-stream change refund via custom SSE event
- **Multi-mint support** — accepts ecash from any whitelisted Cashu mint
- **Auto-pricing** — fetches model prices from OpenRouter, merges with custom rules
- **Circuit breaker** — per-mint health tracking with automatic failover

## Quick Start

### Deploy to Cloudflare

```bash
git clone https://github.com/TokenisAllAgentNeed/gate.git
cd gate && npm install

# Set secrets
wrangler secret put OPENROUTER_API_KEY   # upstream LLM provider
wrangler secret put GATE_ADMIN_TOKEN     # admin API auth

# Deploy
wrangler deploy
```

### Run Tests

```bash
npm test              # 368 tests
npm run test:coverage # with coverage report
```

## How Payment Works

```
1. Client → POST /v1/chat/completions + X-Cashu: cashuB...
2. Gate decodes token, checks mint whitelist
3. Gate estimates price from request (per-token rates × estimated tokens)
4. Gate swaps ecash at mint (atomic — keeps payment, returns change)
5. Gate proxies request to upstream LLM
6. Success → response + X-Cashu-Receipt + change (header or SSE event)
   Failure → error + X-Cashu-Refund (full amount back)
```

### Streaming Change

For streaming (SSE) responses, change cannot be sent in HTTP headers (headers are sent before the body). Instead, the Gate emits a custom SSE event after `[DONE]`:

```
event: cashu-change
data: {"token":"cashuB...","estimated":4500,"actual":3200,"refund":1300}
```

Clients like t2c automatically parse this event and reclaim overpayment.

## API Reference

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info |
| `/health` | GET | Health check + upstream status |
| `/v1/info` | GET | Version info |
| `/v1/pricing` | GET | Per-model pricing, accepted mints, exchange rate |
| `/v1/chat/completions` | POST | Chat completion (requires `X-Cashu` header) |

### Payment Headers

| Header | Direction | Description |
|--------|-----------|-------------|
| `X-Cashu` | Request | Cashu V4 token (`cashuB...`) |
| `X-Cashu-Receipt` | Response | Payment receipt (amount, model, timestamp) |
| `X-Cashu-Change` | Response | Change proofs (non-streaming only) |
| `X-Cashu-Refund` | Response | Full refund on upstream failure |
| `X-Cashu-Price` | 402 Response | Required payment info when token is missing/insufficient |

### Admin Endpoints (Bearer token auth)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/stats` | GET | Request statistics (today + 7d) |
| `/v1/gate/balance` | GET | Ecash balance in KV |
| `/v1/gate/melt` | POST | Melt ecash → on-chain USDC |
| `/v1/gate/melt-ln` | POST | Melt ecash → Lightning |
| `/homo/withdraw` | POST | Withdraw ecash to external wallet |
| `/homo/cleanup` | POST | Remove spent proofs from KV |
| `/homo/ui` | GET | Web dashboard (metrics, errors, melt) |
| `/v1/gate/metrics/summary` | GET | Metrics summary by date range |
| `/v1/gate/metrics` | GET | Raw metrics by date |
| `/v1/gate/token-errors` | GET | Token decode error log |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Upstream LLM API key |
| `GATE_ADMIN_TOKEN` | Yes | Admin endpoint auth |
| `TRUSTED_MINTS` | Yes | Comma-separated mint URLs |
| `MINT_URL` | Yes | Primary mint for swap operations |
| `GATE_WALLET_ADDRESS` | Yes | Address for melt payouts |
| `PRICING_JSON` | No | Custom pricing rules (JSON array) |
| `OPENAI_API_KEY` | No | Direct OpenAI upstream (alternative to OpenRouter) |

### Pricing

Default mode: **per_token** (USD units per 1M tokens, input and output priced separately).

| Model | Input/1M | Output/1M | USD equivalent |
|-------|----------|-----------|----------------|
| openai/gpt-4o-mini | 15,000 | 60,000 | $0.15 / $0.60 |
| openai/gpt-4o | 250,000 | 1,000,000 | $2.50 / $10.00 |
| anthropic/claude-sonnet-4 | 300,000 | 1,500,000 | $3.00 / $15.00 |
| anthropic/claude-opus-4 | 1,500,000 | 7,500,000 | $15.00 / $75.00 |
| * (wildcard) | 100,000 | 500,000 | $1.00 / $5.00 |

Prices auto-update from OpenRouter API (1h cache). Custom rules in `PRICING_JSON` take precedence.

### Upstream Routing

The Gate routes models to upstream providers:

1. **Exact match** — `openai/gpt-4o` → specific upstream
2. **Prefix match** — `openai/*` → catch prefix
3. **Wildcard** — `*` → default upstream (OpenRouter)

## Security Model

- **Mint whitelist** — only accepts ecash from `TRUSTED_MINTS`
- **Atomic swap** — ecash is swapped at the mint before proxying (no double-spend)
- **Timing-safe auth** — admin token comparison uses constant-time comparison
- **Brute-force protection** — admin lockout after repeated failures
- **Circuit breaker** — per-mint swap failures trigger temporary bypass
- **Token error logging** — invalid tokens logged for debugging (sanitized)

## Operations

### Cash Out

The Gate accumulates ecash from payments. Cash out options:

```bash
# Melt to USDC on Base
curl -X POST https://gate.token2chat.com/v1/gate/melt \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Melt to Lightning
curl -X POST https://gate.token2chat.com/v1/gate/melt-ln \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bolt11": "lnbc..."}'

# Withdraw as ecash token
curl -X POST https://gate.token2chat.com/homo/withdraw \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Cleanup

Remove spent proofs from KV to keep storage lean:

```bash
curl -X POST https://gate.token2chat.com/homo/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Dashboard

Visit `https://gate.token2chat.com/homo/ui?token=YOUR_ADMIN_TOKEN` for real-time metrics, error logs, and melt controls.

## License

MIT
