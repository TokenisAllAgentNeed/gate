# token2chat Gate — Technical Specification

> Ecash payment gateway middleware.

## Protocol

### Pay-per-request LLM Call

```http
POST /v1/chat/completions HTTP/1.1
Host: gate.token2chat.com
Content-Type: application/json
X-Cashu: cashuBo2F0gaJhaUgA...

{
  "model": "gpt-4o-mini",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

### Responses

**Success — exact payment (200)**
```http
X-Cashu-Receipt: {"id":"...","amount":200,"unit":"sat","model":"gpt-4o-mini","token_hash":"a1b2c3d4e5f6g7h8"}
```

**Success — overpayment with change (200)**
```http
X-Cashu-Receipt: {"id":"...","amount":200,"unit":"sat","model":"gpt-4o-mini","token_hash":"..."}
X-Cashu-Change: cashuBo2F0gaJhaUgA...
```

**Upstream failure — full refund (502)**
```http
X-Cashu-Refund: cashuBo2F0gaJhaUgA...
```

**Insufficient payment (402)**
```json
{
  "error": {
    "code": "insufficient_payment",
    "message": "Token value 50 sat < required 200 sat for model gpt-4o-mini",
    "required": 200,
    "provided": 50,
    "unit": "sat",
    "pricing_mode": "per_token"
  }
}
```

### Pricing Endpoint

```http
GET /v1/pricing
```

```json
{
  "unit": "sat",
  "mints": ["https://mint.token2chat.com"],
  "pricing_mode": "per_token",
  "exchange_rate": {
    "usd_to_sats": 1000,
    "description": "1 USD = 1000 sats"
  },
  "models": {
    "gpt-4o-mini": {
      "mode": "per_token",
      "input_per_million": 150,
      "output_per_million": 600
    },
    "gpt-4o": {
      "mode": "per_token",
      "input_per_million": 2500,
      "output_per_million": 10000
    }
  }
}
```

## Pricing Modes

### per_token (recommended)
Price based on estimated input + output tokens. Gate estimates max cost upfront, charges that amount, and the client gets change for unused capacity.

**Estimation:**
1. Count input tokens from messages (text: chars/4, images: 85 tokens each)
2. Apply overhead factor (1.1x)
3. Use `max_tokens` from request (or default 4096)
4. Cost = (input × input_per_million + output × output_per_million) / 1,000,000

### per_request (legacy)
Flat rate per request regardless of token count. Simpler but less fair for short vs long requests.

## Processing Flow

**Principle: charge first, refund on failure.**

```
Client → Gate: POST + X-Cashu token
  1. decodeStampWithDiagnostics(token) → Stamp + diagnostics
  2. Check mint whitelist (normalized, trailing slash tolerant)
  3. Parse request body → extract model, estimate input tokens
  4. getPrice(model, rules) → PricingRule
  5. estimateMaxCost(rule, inputTokens, maxTokens) → estimated price
  6. validateAmount(stamp, rule, estimate) → ok?
  7. redeemFn(stamp, price) → swap at mint → keep + change  ← charge first
  8. resolveUpstream(model) → upstream config
  9. proxyToUpstream(upstream, body) → LLM response
  10a. Success → createReceipt() → 200 + response + Receipt + Change
  10b. Failure → encodeRefundToken() → 5xx + Refund + KV cleanup
```

## Error Codes

| Status | Code | Trigger |
|--------|------|---------|
| 400 | `invalid_token` | Token decode failed (V3/V4) |
| 400 | `untrusted_mint` | Mint not in whitelist |
| 400 | `invalid_request` | Missing model in body |
| 400 | `model_not_found` | No pricing rule for model |
| 400 | `token_spent` | Double-spend (mint rejected swap) |
| 402 | `payment_required` | No X-Cashu header |
| 402 | `insufficient_payment` | Token amount < estimated cost |
| 429 | (rate limited) | IP exceeded requests/minute |
| 500 | `redeem_failed` | Mint swap failed (non-timeout) |
| 502 | `no_upstream` | No upstream for model |
| 504 | `gateway_timeout` | Mint swap timed out |

## Data Types

```typescript
interface Stamp {
  mint: string;
  amount: number;
  proofs: Proof[];
}

interface PricingRule {
  model: string;  // exact name, prefix with *, or "*" wildcard
  mode: "per_request" | "per_token";
  // per_request mode
  per_request?: number;
  // per_token mode
  input_per_million?: number;
  output_per_million?: number;
}

interface Receipt {
  id: string;           // UUID
  timestamp: string;    // ISO 8601
  amount: number;       // sats charged
  unit: "sat";
  model: string;
  token_hash: string;   // truncated SHA-256 of proof secrets (16 hex chars)
}

interface RedeemResult {
  ok: boolean;
  keep?: Proof[];       // Gate's proofs (= price)
  change?: Proof[];     // User's change (= overpayment)
  kvKey?: string;       // KV storage key for cleanup
  error?: string;
}

interface MetricsRecord {
  ts: number;
  model: string;
  status: number;
  ecash_in: number;
  price: number;
  change: number;
  refunded: boolean;
  upstream_ms: number;
  error_code?: string;
  mint: string;
  stream: boolean;
}
```

## Cloudflare Bindings

| Binding/Secret | Type | Description |
|----------------|------|-------------|
| `ECASH_STORE` | KV | Proofs, metrics, rate limits, token errors |
| `UPSTREAM_API_KEY` / `OPENROUTER_API_KEY` | Secret | Upstream LLM API key |
| `TRUSTED_MINTS` | Env | Comma-separated mint URLs |
| `MINT_URL` | Env | Primary mint for swap/redeem |
| `GATE_WALLET_ADDRESS` | Env/Secret | On-chain wallet for melt |
| `ADMIN_TOKEN` | Secret | Bearer token for admin endpoints |
| `IP_HASH_SALT` | Secret | Salt for IP hashing (auto-generated if unset) |

## Security

- **Double-spend prevention:** Swap at mint before calling upstream; same token can only succeed once
- **User protection:** Upstream failure → refund via standard Cashu V4 token in `X-Cashu-Refund`; KV proofs cleaned up
- **Brute-force protection:** Admin auth tracks failures per IP, locks after 5 attempts (15min cooldown)
- **Rate limiting:** IP-based via KV counters, configurable per-minute threshold
- **Timing-safe auth:** Admin bearer token uses constant-time comparison
- **IP privacy:** Client IPs SHA-256 hashed with salt before any storage
- **Stateless:** Gate holds no user state, no sessions, no balances
- **Replay protection:** Cashu proofs are one-time; spent secrets rejected by mint
- **Token diagnostics:** Failed decode attempts logged with CBOR structure for debugging (no raw secrets)
