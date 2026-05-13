# Steadfast Courier API — Local Mock Sandbox

A local mock server that mimics the [Steadfast Courier Limited API v1](https://portal.packzy.com/api/v1). Since Steadfast does not provide an official sandbox, this lets you exercise your integration without hitting production or needing real API keys.

Implements all 12 documented REST endpoints, simulates status auto-progression (`in_review` → `pending` → `delivered`), credits the balance on delivery, and **fires `delivery_status` webhooks** at a URL of your choice so you can test the inbound side of your integration too.

---

## 1. Quick start

Requires Node.js 20.6+ (Node 24 recommended for native `--env-file` support).

```bash
git clone https://github.com/faysalewucse/steadfast-sandbox.git
cd steadfast-sandbox
npm install
npm start
```

Server is now running at **http://localhost:3000**.

Open the root URL in a browser for a live endpoint cheat sheet.

---

## 2. Point your integration at the mock

Wherever your real code uses Steadfast's base URL, swap it for the mock:

| | Real Steadfast | This mock |
|---|---|---|
| Base URL | `https://portal.packzy.com/api/v1` | `http://localhost:3000/api/v1` |
| Headers | `Api-Key`, `Secret-Key` required | accepted but **ignored** — use any value |
| Auth | real keys needed | none |

Example (PHP / Laravel — same shape as Steadfast's docs):

```php
$response = Http::withHeaders([
    'Api-Key'      => 'anything',           // ignored by mock
    'Secret-Key'   => 'anything',           // ignored by mock
    'Content-Type' => 'application/json',
])->post('http://localhost:3000/api/v1/create_order', [
    'invoice'           => 'INV-001',
    'recipient_name'    => 'John Smith',
    'recipient_phone'   => '01711111111',
    'recipient_address' => 'House 17, Road 3, Dhanmondi, Dhaka-1209',
    'cod_amount'        => 1060,
]);
```

Example (Node.js / fetch):

```js
const res = await fetch('http://localhost:3000/api/v1/create_order', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    invoice: 'INV-001',
    recipient_name: 'John Smith',
    recipient_phone: '01711111111',
    recipient_address: 'House 17, Road 3, Dhanmondi, Dhaka-1209',
    cod_amount: 1060,
  }),
});
const data = await res.json();
console.log(data.consignment.consignment_id, data.consignment.tracking_code);
```

---

## 3. Common flows

### Create an order

```bash
curl -X POST http://localhost:3000/api/v1/create_order \
  -H "Content-Type: application/json" \
  -d '{
    "invoice": "INV-001",
    "recipient_name": "John Smith",
    "recipient_phone": "01711111111",
    "recipient_address": "House 17, Road 3, Dhanmondi, Dhaka-1209",
    "cod_amount": 1060,
    "note": "Deliver within 3 PM"
  }'
```

Returns `consignment_id` and `tracking_code` matching the real API's response shape. New orders start at `status: "in_review"`.

### Check status

Three ways, matching the real API:

```bash
curl http://localhost:3000/api/v1/status_by_cid/1424107
curl http://localhost:3000/api/v1/status_by_invoice/INV-001
curl http://localhost:3000/api/v1/status_by_trackingcode/75BA1F73
```

### Status auto-progression

A new order moves through statuses on its own:

| Time since creation | Status |
|---|---|
| 0–30s | `in_review` |
| 30–60s | `pending` (fires webhook) |
| 60s+ | `delivered` (fires webhook + credits balance) |

To override timing edit `IN_REVIEW_MS` / `PENDING_MS` near the top of [server.js](server.js).

### Check balance

```bash
curl http://localhost:3000/api/v1/get_balance
```

`cod_amount` is added to the balance the first time a consignment hits `delivered`.

### Bulk create (up to 500)

```bash
curl -X POST http://localhost:3000/api/v1/create_order/bulk-order \
  -H "Content-Type: application/json" \
  -d '{"data":[
    {"invoice":"bulk-1","recipient_name":"A","recipient_phone":"01711111111","recipient_address":"Addr","cod_amount":100},
    {"invoice":"bulk-2","recipient_name":"B","recipient_phone":"01722222222","recipient_address":"Addr","cod_amount":200}
  ]}'
```

### Return requests

```bash
# Create
curl -X POST http://localhost:3000/api/v1/create_return_request \
  -H "Content-Type: application/json" \
  -d '{"invoice":"INV-001","reason":"Damaged"}'

# List
curl http://localhost:3000/api/v1/get_return_requests

# Single
curl http://localhost:3000/api/v1/get_return_request/1
```

---

## 4. Receiving webhooks

The mock can POST `delivery_status` events to your app whenever a consignment transitions to `pending`, `delivered`, `partial_delivered`, `cancelled`, or `unknown` — matching Steadfast's documented webhook contract.

**Step 1.** In your `.env`, point at your app's webhook receiver:

```dotenv
WEBHOOK_URL=http://localhost:4000/steadfast-webhook
WEBHOOK_SECRET=any-shared-secret      # optional — sent as Authorization: Bearer <secret>
WEBHOOK_DELIVERY_CHARGE=60            # value placed in payload's delivery_charge field
```

**Step 2.** Restart the mock (`npm start`). Startup log confirms the target:

```
Webhook target: http://localhost:4000/steadfast-webhook (Bearer auth)
```

**Step 3.** Create an order and wait 30s — your receiver gets:

```json
{
  "notification_type": "delivery_status",
  "consignment_id": 1424107,
  "invoice": "INV-001",
  "cod_amount": 1060,
  "status": "pending",
  "delivery_charge": 60,
  "tracking_message": "Consignment is in transit.",
  "updated_at": "2025-05-13 09:01:11"
}
```

Or skip the wait and force a transition immediately — see "Mock-only helpers" below.

---

## 5. Mock-only helpers

These endpoints are not part of the real Steadfast API. They exist so you can script test scenarios.

| Method | Path | Purpose |
|---|---|---|
| GET | `/_mock/state` | Dump all in-memory state (consignments, return requests, payments, balance) |
| POST | `/_mock/set_status/:id` | Force a consignment to any valid status. Body: `{"status":"delivered"}`. Fires the webhook if applicable. |
| POST | `/_mock/seed_payment` | Bundle up to 5 existing consignments into a fake payment record |
| POST | `/_mock/reset` | Wipe all in-memory data |

Example — drive a full lifecycle in seconds:

```bash
# Create
curl -X POST http://localhost:3000/api/v1/create_order \
  -H "Content-Type: application/json" \
  -d '{"invoice":"e2e-1","recipient_name":"X","recipient_phone":"01711111111","recipient_address":"A","cod_amount":500}'

# Jump straight to delivered (fires delivery_status webhook)
curl -X POST http://localhost:3000/_mock/set_status/1424107 \
  -H "Content-Type: application/json" \
  -d '{"status":"delivered"}'

# Confirm balance credited
curl http://localhost:3000/api/v1/get_balance

# Reset for the next test
curl -X POST http://localhost:3000/_mock/reset
```

Valid `status` values for `/_mock/set_status`: `pending`, `delivered`, `partial_delivered`, `cancelled`, `unknown`, `delivered_approval_pending`, `partial_delivered_approval_pending`, `cancelled_approval_pending`, `unknown_approval_pending`, `hold`, `in_review`. Only the first five fire webhooks (per Steadfast's spec).

---

## 6. All endpoints

Steadfast endpoints (all under `/api/v1`):

| Method | Path |
|---|---|
| POST | `/create_order` |
| POST | `/create_order/bulk-order` |
| GET  | `/status_by_cid/:id` |
| GET  | `/status_by_invoice/:invoice` |
| GET  | `/status_by_trackingcode/:trackingCode` |
| GET  | `/get_balance` |
| POST | `/create_return_request` |
| GET  | `/get_return_request/:id` |
| GET  | `/get_return_requests` |
| GET  | `/payments` |
| GET  | `/payments/:id` |
| GET  | `/police_stations` |

Full request/response shapes are in [steadfastapidoc.txt](steadfastapidoc.txt).

---

## 7. Configuration

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `WEBHOOK_URL` | _(empty)_ | Where to POST `delivery_status` webhooks. Empty = disabled. |
| `WEBHOOK_SECRET` | _(empty)_ | Bearer token sent in `Authorization` header on webhooks |
| `WEBHOOK_DELIVERY_CHARGE` | `60` | Value placed in webhook payload's `delivery_charge` field |

`.env` is git-ignored. Only `.env.example` is committed.

---

## 8. Limitations

- **State is in-memory** — restart wipes all orders, returns, payments, and balance.
- **No authentication** — anyone hitting the URL can read/write. Don't expose this to the public internet without adding your own auth.
- **`tracking_update` webhook events are not auto-fired.** Only `delivery_status` events fire (on real status transitions).
- **Police-stations data is hard-coded** to 10 sample entries — adjust [server.js](server.js) if your tests need a richer list.

---

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the server, loading `.env` if present |
| `npm run dev` | Same, with `--watch` to auto-restart on file changes |
