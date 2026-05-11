const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const BASE = '/api/v1';

// ---------- Webhook config ----------
// Configure on startup:
//   WEBHOOK_URL=http://localhost:4000/steadfast-webhook \
//   WEBHOOK_SECRET=optional-bearer-token \
//   WEBHOOK_DELIVERY_CHARGE=60 \
//   npm start
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEFAULT_DELIVERY_CHARGE = Number(process.env.WEBHOOK_DELIVERY_CHARGE) || 60;

// Steadfast's webhook docs list these 5 statuses for the delivery_status event
const WEBHOOK_STATUSES = new Set(['pending', 'delivered', 'partial_delivered', 'cancelled', 'unknown']);

const TRACKING_MESSAGES = {
  pending: 'Consignment is in transit.',
  delivered: 'Your package has been delivered successfully.',
  partial_delivered: 'Your package has been partially delivered.',
  cancelled: 'Consignment has been cancelled.',
  unknown: 'Status unknown. Please contact support.',
};

function formatWebhookTimestamp(d = new Date()) {
  // "YYYY-MM-DD HH:MM:SS" in UTC, per Steadfast webhook docs
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function fireDeliveryStatusWebhook(consignment) {
  if (!WEBHOOK_URL) return;
  if (!WEBHOOK_STATUSES.has(consignment.status)) return;

  const payload = {
    notification_type: 'delivery_status',
    consignment_id: consignment.consignment_id,
    invoice: consignment.invoice,
    cod_amount: Number(consignment.cod_amount),
    status: consignment.status,
    delivery_charge: DEFAULT_DELIVERY_CHARGE,
    tracking_message: TRACKING_MESSAGES[consignment.status] || '',
    updated_at: formatWebhookTimestamp(new Date()),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) headers['Authorization'] = `Bearer ${WEBHOOK_SECRET}`;

  fetch(WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(payload) })
    .then((res) => {
      console.log(`[webhook] ${payload.status} -> ${WEBHOOK_URL} : ${res.status}`);
    })
    .catch((err) => {
      console.warn(`[webhook] ${payload.status} -> ${WEBHOOK_URL} : FAILED ${err.message}`);
    });
}

// ---------- In-memory stores ----------
const consignments = new Map();          // consignment_id -> consignment
const byInvoice = new Map();             // invoice -> consignment_id
const byTracking = new Map();            // tracking_code -> consignment_id
const returnRequests = new Map();        // id -> return request
const payments = new Map();              // payment_id -> payment

let nextConsignmentId = 1424107;
let nextReturnRequestId = 1;
let nextPaymentId = 1;
let currentBalance = 0;

// ---------- Status auto-progression ----------
// Real Steadfast: in_review -> pending -> delivered (and balance credited)
// Mock timing: 30s in_review, then 30s pending, then delivered
const IN_REVIEW_MS = 30_000;
const PENDING_MS = 30_000;

function progressStatus(consignmentId) {
  const c = consignments.get(consignmentId);
  if (!c) return;
  const age = Date.now() - c._createdAtMs;
  let newStatus = c.status;
  if (age >= IN_REVIEW_MS + PENDING_MS) newStatus = 'delivered';
  else if (age >= IN_REVIEW_MS) newStatus = 'pending';
  else newStatus = 'in_review';

  if (newStatus !== c.status) {
    c.status = newStatus;
    c.updated_at = new Date().toISOString();
    if (newStatus === 'delivered' && !c._creditedBalance) {
      currentBalance += Number(c.cod_amount) || 0;
      c._creditedBalance = true;
    }
    fireDeliveryStatusWebhook(c);
  }
}

function touchAndGet(consignmentId) {
  progressStatus(consignmentId);
  return consignments.get(consignmentId);
}

// ---------- Helpers ----------
function randomTrackingCode() {
  return Math.random().toString(16).slice(2, 10).toUpperCase().padEnd(8, '0');
}

function validatePhone(phone) {
  return typeof phone === 'string' && /^\d{11}$/.test(phone);
}

function publicView(c) {
  const { _createdAtMs, _creditedBalance, ...rest } = c;
  return rest;
}

function buildOrder(input) {
  const errors = [];
  if (!input.invoice || typeof input.invoice !== 'string') errors.push('invoice is required');
  else if (byInvoice.has(input.invoice)) errors.push('invoice must be unique');
  if (!input.recipient_name) errors.push('recipient_name is required');
  else if (String(input.recipient_name).length > 100) errors.push('recipient_name must be within 100 characters');
  if (!input.recipient_phone) errors.push('recipient_phone is required');
  else if (!validatePhone(input.recipient_phone)) errors.push('recipient_phone must be 11 digits');
  if (input.alternative_phone && !validatePhone(input.alternative_phone)) errors.push('alternative_phone must be 11 digits');
  if (!input.recipient_address) errors.push('recipient_address is required');
  else if (String(input.recipient_address).length > 250) errors.push('recipient_address must be within 250 characters');
  if (input.cod_amount === undefined || input.cod_amount === null) errors.push('cod_amount is required');
  else if (isNaN(Number(input.cod_amount)) || Number(input.cod_amount) < 0) errors.push('cod_amount must be numeric and >= 0');

  if (errors.length) return { errors };

  const consignment_id = nextConsignmentId++;
  const tracking_code = randomTrackingCode();
  const now = new Date().toISOString();
  const consignment = {
    consignment_id,
    invoice: input.invoice,
    tracking_code,
    recipient_name: input.recipient_name,
    recipient_phone: input.recipient_phone,
    recipient_address: input.recipient_address,
    cod_amount: Number(input.cod_amount),
    status: 'in_review',
    note: input.note ?? null,
    created_at: now,
    updated_at: now,
    _createdAtMs: Date.now(),
    _creditedBalance: false,
  };
  consignments.set(consignment_id, consignment);
  byInvoice.set(consignment.invoice, consignment_id);
  byTracking.set(tracking_code, consignment_id);
  return { consignment };
}

// ---------- Routes ----------

app.post(`${BASE}/create_order`, (req, res) => {
  const { errors, consignment } = buildOrder(req.body || {});
  if (errors) {
    return res.status(422).json({
      status: 422,
      message: 'Validation failed',
      errors,
    });
  }
  return res.status(200).json({
    status: 200,
    message: 'Consignment has been created successfully.',
    consignment: publicView(consignment),
  });
});

app.post(`${BASE}/create_order/bulk-order`, (req, res) => {
  let { data } = req.body || {};
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return res.status(422).json({ status: 422, message: 'data is not valid JSON' }); }
  }
  if (!Array.isArray(data)) {
    return res.status(422).json({ status: 422, message: 'data must be a JSON array' });
  }
  if (data.length > 500) {
    return res.status(422).json({ status: 422, message: 'Maximum 500 items are allowed' });
  }

  const results = data.map((item) => {
    const { errors, consignment } = buildOrder(item || {});
    if (errors) {
      return {
        invoice: item?.invoice ?? null,
        recipient_name: item?.recipient_name ?? null,
        recipient_address: item?.recipient_address ?? null,
        recipient_phone: item?.recipient_phone ?? null,
        cod_amount: item?.cod_amount != null ? Number(item.cod_amount).toFixed(2) : '0.00',
        note: item?.note ?? null,
        consignment_id: null,
        tracking_code: null,
        status: 'error',
        errors,
      };
    }
    return {
      invoice: consignment.invoice,
      recipient_name: consignment.recipient_name,
      recipient_address: consignment.recipient_address,
      recipient_phone: consignment.recipient_phone,
      cod_amount: Number(consignment.cod_amount).toFixed(2),
      note: consignment.note,
      consignment_id: consignment.consignment_id,
      tracking_code: consignment.tracking_code,
      status: 'success',
    };
  });

  const hasError = results.some((r) => r.status === 'error');
  if (hasError) return res.status(200).json({ data: results });
  return res.status(200).json(results);
});

function statusResponse(res, consignmentId) {
  if (!consignmentId || !consignments.has(consignmentId)) {
    return res.status(404).json({ status: 404, message: 'Consignment not found' });
  }
  const c = touchAndGet(consignmentId);
  return res.status(200).json({ status: 200, delivery_status: c.status });
}

app.get(`${BASE}/status_by_cid/:id`, (req, res) => {
  const id = Number(req.params.id);
  return statusResponse(res, id);
});

app.get(`${BASE}/status_by_invoice/:invoice`, (req, res) => {
  const id = byInvoice.get(req.params.invoice);
  return statusResponse(res, id);
});

app.get(`${BASE}/status_by_trackingcode/:trackingCode`, (req, res) => {
  const id = byTracking.get(req.params.trackingCode);
  return statusResponse(res, id);
});

app.get(`${BASE}/get_balance`, (req, res) => {
  for (const id of consignments.keys()) progressStatus(id);
  return res.status(200).json({ status: 200, current_balance: currentBalance });
});

app.post(`${BASE}/create_return_request`, (req, res) => {
  const { consignment_id, invoice, tracking_code, reason } = req.body || {};
  let cid = null;
  if (consignment_id && consignments.has(Number(consignment_id))) cid = Number(consignment_id);
  else if (invoice && byInvoice.has(invoice)) cid = byInvoice.get(invoice);
  else if (tracking_code && byTracking.has(tracking_code)) cid = byTracking.get(tracking_code);

  if (!cid) {
    return res.status(422).json({ status: 422, message: 'consignment_id, invoice, or tracking_code is required and must reference an existing consignment' });
  }

  const id = nextReturnRequestId++;
  const now = new Date().toISOString();
  const rr = {
    id,
    user_id: 1,
    consignment_id: cid,
    reason: reason ?? null,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
  returnRequests.set(id, rr);
  return res.status(200).json(rr);
});

app.get(`${BASE}/get_return_request/:id`, (req, res) => {
  const rr = returnRequests.get(Number(req.params.id));
  if (!rr) return res.status(404).json({ status: 404, message: 'Return request not found' });
  return res.status(200).json(rr);
});

app.get(`${BASE}/get_return_requests`, (req, res) => {
  return res.status(200).json(Array.from(returnRequests.values()));
});

app.get(`${BASE}/payments`, (req, res) => {
  return res.status(200).json(Array.from(payments.values()));
});

app.get(`${BASE}/payments/:id`, (req, res) => {
  const p = payments.get(Number(req.params.id));
  if (!p) return res.status(404).json({ status: 404, message: 'Payment not found' });
  return res.status(200).json(p);
});

app.get(`${BASE}/police_stations`, (req, res) => {
  return res.status(200).json({
    status: 200,
    data: [
      { id: 1, name: 'Dhanmondi', district: 'Dhaka', division: 'Dhaka' },
      { id: 2, name: 'Gulshan', district: 'Dhaka', division: 'Dhaka' },
      { id: 3, name: 'Mirpur', district: 'Dhaka', division: 'Dhaka' },
      { id: 4, name: 'Uttara', district: 'Dhaka', division: 'Dhaka' },
      { id: 5, name: 'Motijheel', district: 'Dhaka', division: 'Dhaka' },
      { id: 6, name: 'Kotwali', district: 'Chittagong', division: 'Chittagong' },
      { id: 7, name: 'Panchlaish', district: 'Chittagong', division: 'Chittagong' },
      { id: 8, name: 'Boalia', district: 'Rajshahi', division: 'Rajshahi' },
      { id: 9, name: 'Kotwali', district: 'Khulna', division: 'Khulna' },
      { id: 10, name: 'Kotwali', district: 'Sylhet', division: 'Sylhet' },
    ],
  });
});

// ---------- Mock-only helper endpoints (prefixed with /_mock) ----------

app.get('/_mock/state', (req, res) => {
  for (const id of consignments.keys()) progressStatus(id);
  res.json({
    consignments: Array.from(consignments.values()).map(publicView),
    return_requests: Array.from(returnRequests.values()),
    payments: Array.from(payments.values()),
    current_balance: currentBalance,
  });
});

app.post('/_mock/set_status/:id', (req, res) => {
  const id = Number(req.params.id);
  const c = consignments.get(id);
  if (!c) return res.status(404).json({ message: 'Consignment not found' });
  const { status } = req.body || {};
  const allowed = [
    'pending', 'delivered_approval_pending', 'partial_delivered_approval_pending',
    'cancelled_approval_pending', 'unknown_approval_pending', 'delivered',
    'partial_delivered', 'cancelled', 'hold', 'in_review', 'unknown',
  ];
  if (!allowed.includes(status)) {
    return res.status(422).json({ message: 'Invalid status', allowed });
  }
  c.status = status;
  c.updated_at = new Date().toISOString();
  c._createdAtMs = status === 'in_review' ? Date.now() :
                   status === 'pending' ? Date.now() - IN_REVIEW_MS :
                   Date.now() - (IN_REVIEW_MS + PENDING_MS);
  if (status === 'delivered' && !c._creditedBalance) {
    currentBalance += Number(c.cod_amount) || 0;
    c._creditedBalance = true;
  }
  fireDeliveryStatusWebhook(c);
  res.json(publicView(c));
});

app.post('/_mock/reset', (req, res) => {
  consignments.clear();
  byInvoice.clear();
  byTracking.clear();
  returnRequests.clear();
  payments.clear();
  nextConsignmentId = 1424107;
  nextReturnRequestId = 1;
  nextPaymentId = 1;
  currentBalance = 0;
  res.json({ message: 'reset' });
});

app.post('/_mock/seed_payment', (req, res) => {
  const id = nextPaymentId++;
  const consignment_ids = Array.from(consignments.keys()).slice(0, 5);
  const total = consignment_ids.reduce((s, cid) => s + (consignments.get(cid)?.cod_amount || 0), 0);
  const payment = {
    id,
    amount: total,
    status: 'paid',
    created_at: new Date().toISOString(),
    consignments: consignment_ids.map((cid) => publicView(consignments.get(cid))),
  };
  payments.set(id, payment);
  res.json(payment);
});

app.get('/', (req, res) => {
  res.type('text/plain').send(
    [
      'Steadfast Courier API — Local Mock Sandbox',
      `Base URL: http://localhost:${PORT}${BASE}`,
      '',
      'Production endpoints (no auth required in this mock):',
      '  POST   /api/v1/create_order',
      '  POST   /api/v1/create_order/bulk-order',
      '  GET    /api/v1/status_by_cid/:id',
      '  GET    /api/v1/status_by_invoice/:invoice',
      '  GET    /api/v1/status_by_trackingcode/:trackingCode',
      '  GET    /api/v1/get_balance',
      '  POST   /api/v1/create_return_request',
      '  GET    /api/v1/get_return_request/:id',
      '  GET    /api/v1/get_return_requests',
      '  GET    /api/v1/payments',
      '  GET    /api/v1/payments/:id',
      '  GET    /api/v1/police_stations',
      '',
      'Mock-only helpers:',
      '  GET    /_mock/state               — dump in-memory state',
      '  POST   /_mock/set_status/:id      — body: { "status": "delivered" }',
      '  POST   /_mock/seed_payment        — create a fake payment record',
      '  POST   /_mock/reset               — wipe all data',
      '',
      `Status auto-progression: in_review (${IN_REVIEW_MS / 1000}s) → pending (${PENDING_MS / 1000}s) → delivered`,
      '',
      `Webhook (delivery_status) target: ${WEBHOOK_URL || '(not configured — set WEBHOOK_URL on startup)'}`,
    ].join('\n')
  );
});

app.use((req, res) => {
  res.status(404).json({ status: 404, message: `Not found: ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`Steadfast mock sandbox running at http://localhost:${PORT}`);
  console.log(`Base URL: http://localhost:${PORT}${BASE}`);
  if (WEBHOOK_URL) {
    console.log(`Webhook target: ${WEBHOOK_URL}${WEBHOOK_SECRET ? ' (Bearer auth)' : ''}`);
  } else {
    console.log(`Webhook target: none (set WEBHOOK_URL to enable delivery_status webhooks)`);
  }
});
