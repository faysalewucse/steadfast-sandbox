# Steadfast Courier API — Local Sandbox

A local mock server that mimics the [Steadfast Courier Limited API v1](https://portal.packzy.com/api/v1) for development and testing. Since Steadfast does not provide an official sandbox, this lets you exercise your integration without hitting production or needing API keys.

## Quick start

```bash
npm install
npm start
```

Server runs at `http://localhost:3000`.

Base URL to point your integration at: `http://localhost:3000/api/v1`

## What it does

- Implements all 10 documented endpoints with matching request/response shapes
- **Skips API key validation** — `Api-Key` / `Secret-Key` headers are accepted but ignored
- Validates inputs the same way Steadfast does (11-digit phone, unique invoice, required fields, 100/250 char limits, etc.)
- Stores data in memory; state resets when the server restarts
- **Auto-progresses status**: a new order starts at `in_review`, moves to `pending` after 30s, then `delivered` after another 30s. Balance is credited on delivery.

## Endpoints

### Steadfast endpoints (all under `/api/v1`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/create_order` | Place a single order |
| POST | `/create_order/bulk-order` | Place up to 500 orders |
| GET | `/status_by_cid/:id` | Status by consignment ID |
| GET | `/status_by_invoice/:invoice` | Status by invoice |
| GET | `/status_by_trackingcode/:trackingCode` | Status by tracking code |
| GET | `/get_balance` | Current balance |
| POST | `/create_return_request` | Create return request |
| GET | `/get_return_request/:id` | View one return request |
| GET | `/get_return_requests` | List return requests |
| GET | `/payments` | List payments |
| GET | `/payments/:id` | Payment with consignments |
| GET | `/police_stations` | Police stations list |

### Mock-only helpers (not in real Steadfast API)

| Method | Path | Purpose |
|---|---|---|
| GET | `/_mock/state` | Dump all in-memory state |
| POST | `/_mock/set_status/:id` | Force a consignment to any status. Body: `{"status":"delivered"}` |
| POST | `/_mock/seed_payment` | Create a fake payment record bundling existing consignments |
| POST | `/_mock/reset` | Wipe all data |

## Example

```bash
# Create an order
curl -X POST http://localhost:3000/api/v1/create_order \
  -H "Content-Type: application/json" \
  -d '{
    "invoice": "test-001",
    "recipient_name": "John Smith",
    "recipient_phone": "01711111111",
    "recipient_address": "House 17, Road 3, Dhanmondi, Dhaka-1209",
    "cod_amount": 1060
  }'

# Check status
curl http://localhost:3000/api/v1/status_by_invoice/test-001

# Force status to delivered (mock helper)
curl -X POST http://localhost:3000/_mock/set_status/1424107 \
  -H "Content-Type: application/json" \
  -d '{"status":"delivered"}'

# Check balance (credited after delivery)
curl http://localhost:3000/api/v1/get_balance
```

## Configuration

- `PORT` env var (default `3000`)
- Status timing is set in `server.js` (`IN_REVIEW_MS`, `PENDING_MS`)
