/* ─── Read-only data lookups for the chat assistant ─────────────────────────
   Claude can call these tools to answer questions about the company's figures.

   Safety:
   - Every lookup reads Firestore through its REST API **with the signed-in
     user's own Firebase ID token**, so Firestore security rules apply exactly
     as they do in the portal. No service-account / master key is used.
   - Read-only: there is no write, update or delete anywhere in this file.
   - Bounded cost: sales ranges ≤ 31 days (1 read per day), purchase/expense
     ranges ≤ 92 days and ≤ 500 records, product lookup = 1 small query.
   - Daily limits (per person and for everyone) are enforced in server.js.
   ──────────────────────────────────────────────────────────────────────────── */
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'inventory-system-1fb4d';
const FIRESTORE_BASE = process.env.FIRESTORE_BASE
  || `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const DOC_PREFIX = `projects/${PROJECT_ID}/databases/(default)/documents`;

const MAX_SALES_DAYS = 31;
const MAX_RANGE_DAYS = 92;
const MAX_RECORDS = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Firestore REST helpers ────────────────────────────────────────────────
function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('mapValue' in v) return decodeFields((v.mapValue && v.mapValue.fields) || {});
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeValue);
  return null;
}
function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}
function docId(name) { return String(name || '').split('/').pop(); }

class LookupError extends Error {}

async function runQuery(structuredQuery, idToken) {
  const resp = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  if (resp.status === 401 || resp.status === 403) throw new LookupError('Not allowed to read this data with your login.');
  if (resp.status === 429) {
    // Firebase's own quota, not this assistant's limit: on the free (Spark)
    // plan the whole project gets 50,000 reads per day, shared with the portal.
    throw new LookupError("FIREBASE_QUOTA: The company database's free daily allowance of reads (Firebase free plan, shared with the whole portal) is used up for today, so no figures can be looked up and reports will not load either. It resets at midnight US Pacific time, about 4:00 PM Philippine time. This is not the assistant's own question limit.");
  }
  if (!resp.ok) throw new LookupError(`The database lookup failed (HTTP ${resp.status}).`);
  const rows = await resp.json();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.document)
    .map((r) => ({ id: docId(r.document.name), ...decodeFields(r.document.fields) }));
}

// ── Small utilities ─────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round(num(n) * 100) / 100;
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}
function checkRange(input, maxDays) {
  const from = String((input && input.from) || '').trim();
  const to = String((input && input.to) || from).trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new LookupError('Dates must look like 2026-10-01.');
  if (to < from) throw new LookupError('"to" must be on or after "from".');
  const days = daysBetween(from, to);
  if (days > maxDays) throw new LookupError(`That range is ${days} days; the most allowed is ${maxDays} days. Ask for a shorter range.`);
  return { from, to, days };
}
function topBy(map, key, n, dir = -1) {
  return Object.values(map).sort((a, b) => dir * (num(a[key]) - num(b[key]))).slice(0, n);
}

// ── Tools ───────────────────────────────────────────────────────────────────
async function getSales(input, idToken) {
  const { from, to, days } = checkRange(input, MAX_SALES_DAYS);
  const docs = await runQuery({
    from: [{ collectionId: 'salesDaily' }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: `${DOC_PREFIX}/salesDaily/${from}` } } },
      { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN_OR_EQUAL', value: { referenceValue: `${DOC_PREFIX}/salesDaily/${to}` } } },
    ] } },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: MAX_SALES_DAYS,
  }, idToken);

  const products = {};
  const byDay = [];
  const total = { revenue: 0, cost: 0, profit: 0, units: 0 };
  for (const d of docs) {
    const day = { date: d.id, revenue: 0, cost: 0, profit: 0, units: 0 };
    for (const [code, p] of Object.entries(d.products || {})) {
      const units = num(p.units); const revenue = num(p.revenue);
      const cost = p.cost != null ? num(p.cost) : num(p.unit_cost) * units;
      const profit = p.profit != null ? num(p.profit) : revenue - cost;
      day.revenue += revenue; day.cost += cost; day.profit += profit; day.units += units;
      const agg = products[code] || (products[code] = { itemCode: code, name: p.name || code, units: 0, revenue: 0 });
      agg.units += units; agg.revenue += revenue;
    }
    if (d.totals && !Object.keys(d.products || {}).length) {        // totals-only day
      day.revenue = num(d.totals.revenue); day.cost = num(d.totals.cost);
      day.profit = d.totals.profit != null ? num(d.totals.profit) : day.revenue - day.cost; day.units = num(d.totals.units);
    }
    for (const k of Object.keys(total)) total[k] += day[k];
    byDay.push({ date: day.date, revenue: r2(day.revenue), cost: r2(day.cost), grossProfit: r2(day.profit), units: Math.round(day.units) });
  }
  const sold = Object.values(products).filter((p) => p.units > 0 || p.revenue > 0);
  return {
    from, to, daysRequested: days, daysWithSales: byDay.length,
    totals: { revenue: r2(total.revenue), costOfGoodsSold: r2(total.cost), grossProfit: r2(total.profit), unitsSold: Math.round(total.units) },
    byDay: byDay.length <= 31 ? byDay : undefined,
    productsSold: sold.length,
    topByRevenue: topBy(products, 'revenue', 5).map((p) => ({ itemCode: p.itemCode, name: p.name, revenue: r2(p.revenue), units: Math.round(p.units) })),
    topByUnits: topBy(products, 'units', 5).map((p) => ({ itemCode: p.itemCode, name: p.name, units: Math.round(p.units), revenue: r2(p.revenue) })),
    lowestByRevenue: sold.sort((a, b) => a.revenue - b.revenue).slice(0, 5).map((p) => ({ itemCode: p.itemCode, name: p.name, revenue: r2(p.revenue), units: Math.round(p.units) })),
    note: 'Revenue is net sales from the daily sales summary. Days with no uploaded sales are not listed.',
  };
}

function dateRangeQuery(collectionId, from, to) {
  return {
    from: [{ collectionId }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } },
    ] } },
    limit: MAX_RECORDS + 1,
  };
}

async function getPurchases(input, idToken) {
  const { from, to } = checkRange(input, MAX_RANGE_DAYS);
  const rows = await runQuery(dateRangeQuery('purchases', from, to), idToken);
  const truncated = rows.length > MAX_RECORDS;
  const list = rows.slice(0, MAX_RECORDS);
  const want = String((input && input.supplier) || '').trim().toLowerCase();
  const total = { netAmount: 0, inputVAT: 0, grossAmount: 0, ewtWithheld: 0 };
  const bySupplier = {};
  let count = 0;
  for (const p of list) {
    const supplier = String(p.supplierName || p.supplier || 'Unknown supplier');
    if (want && !supplier.toLowerCase().includes(want)) continue;
    const net = num(p.netAmount ?? p.total ?? p.amount);
    const vat = num(p.inputVAT);
    const gross = p.grossAmount != null ? num(p.grossAmount) : net + vat;
    const ewt = num(p.ewtAmount);
    total.netAmount += net; total.inputVAT += vat; total.grossAmount += gross; total.ewtWithheld += ewt; count += 1;
    const s = bySupplier[supplier] || (bySupplier[supplier] = { supplier, records: 0, netAmount: 0 });
    s.records += 1; s.netAmount += net;
  }
  return {
    from, to, supplierFilter: want || undefined, records: count,
    totals: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, r2(v)])),
    topSuppliers: topBy(bySupplier, 'netAmount', 10).map((s) => ({ ...s, netAmount: r2(s.netAmount) })),
    truncated: truncated || undefined,
    note: truncated ? `Only the first ${MAX_RECORDS} records were read; totals may be incomplete. Ask for a shorter range.` : undefined,
  };
}

async function getExpenses(input, idToken) {
  const { from, to } = checkRange(input, MAX_RANGE_DAYS);
  const rows = await runQuery(dateRangeQuery('expenses', from, to), idToken);
  const truncated = rows.length > MAX_RECORDS;
  const list = rows.slice(0, MAX_RECORDS);
  const total = { business: 0, personal: 0, other: 0 };
  const byCategory = {};
  for (const e of list) {
    const amount = num(e.amount);
    const cls = String(e.classification || '').toLowerCase();
    if (cls === 'business') total.business += amount;
    else if (cls === 'personal') total.personal += amount;
    else total.other += amount;
    const cat = String(e.category || e.account || 'Uncategorized');
    const c = byCategory[cat] || (byCategory[cat] = { category: cat, records: 0, amount: 0 });
    c.records += 1; c.amount += amount;
  }
  return {
    from, to, records: list.length,
    totals: { businessExpenses: r2(total.business), personalExpenses: r2(total.personal), unclassified: total.other ? r2(total.other) : undefined },
    topCategories: topBy(byCategory, 'amount', 10).map((c) => ({ ...c, amount: r2(c.amount) })),
    truncated: truncated || undefined,
    note: truncated ? `Only the first ${MAX_RECORDS} records were read; totals may be incomplete. Ask for a shorter range.` : undefined,
  };
}

async function findProduct(input, idToken) {
  const code = String((input && input.itemCode) || '').trim();
  if (!code || code.length > 40) throw new LookupError('Give the exact item code, e.g. 100820144.');
  const rows = await runQuery({
    from: [{ collectionId: 'productMaster' }],
    where: { fieldFilter: { field: { fieldPath: 'itemCode' }, op: 'EQUAL', value: { stringValue: code } } },
    limit: 1,
  }, idToken);
  if (!rows.length) return { itemCode: code, found: false, note: 'No product with that exact item code in Product Master.' };
  const p = rows[0];
  const pick = {};
  for (const k of ['itemCode', 'productName', 'name', 'category', 'supplier', 'unit', 'sellingPrice', 'price', 'srp', 'unitCost', 'cost', 'vatable', 'status']) {
    if (p[k] != null && p[k] !== '') pick[k] = p[k];
  }
  return { found: true, product: pick };
}

const TOOLS = [
  {
    name: 'get_sales',
    description: 'Sales summary from the daily sales records for one day or a date range (at most 31 days): total revenue, cost of goods sold, gross profit, units, per-day figures, and the top and lowest products. Use for any question about sales amounts, best/slowest sellers, or gross profit. For one day, set from and to to the same date.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD (same as from for one day)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_purchases',
    description: 'Purchases summary for a date range (at most 92 days): net amount, input VAT, gross amount, EWT withheld, record count and top suppliers. Optionally filter by supplier name.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD' },
        supplier: { type: 'string', description: 'Optional: part of a supplier name to filter by' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_expenses',
    description: 'Expenses summary for a date range (at most 92 days): business vs personal totals and the top categories.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'find_product',
    description: 'Look up one product in Product Master by its exact item code (name, category, price, cost, supplier).',
    input_schema: {
      type: 'object',
      properties: { itemCode: { type: 'string', description: 'The exact item code' } },
      required: ['itemCode'],
    },
  },
];

const HANDLERS = { get_sales: getSales, get_purchases: getPurchases, get_expenses: getExpenses, find_product: findProduct };

// Runs one tool call. Returns { content, isError } for a tool_result block.
async function runTool(name, input, idToken) {
  const fn = HANDLERS[name];
  if (!fn) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    const result = await fn(input || {}, idToken);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    if (err instanceof LookupError) return { content: err.message, isError: true };
    console.error('lookup failed', name, err && err.message);
    return { content: 'The lookup failed unexpectedly. Please try again later.', isError: true };
  }
}

module.exports = { TOOLS, runTool, decodeValue, checkRange };
