/* ─── EPC Accounting Portal — chat assistant API (Hostinger VPS) ────────────
   A small Node HTTP server: POST /api/chat → Claude (Anthropic API).

   Why a server: the Anthropic API key must never be in the website's code.
   It lives on the VPS in /etc/epc-chat.env (readable by root only) and is
   handed to this process by systemd as an environment variable.

   Who can use it: only people signed in to the portal. The browser sends its
   Firebase ID token; we verify it with Google's public keys (no Firebase
   paid plan or service-account key needed). Only the portal's own web
   addresses may call it (CORS), and each user has a request limit.

   Environment (see setup-vps.sh):
     ANTHROPIC_API_KEY   required
     PORT                default 8787 (Caddy proxies HTTPS to it)
     FIREBASE_PROJECT_ID default inventory-system-1fb4d
   ──────────────────────────────────────────────────────────────────────────── */
const http = require('node:http');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = Number(process.env.PORT || 8787);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'inventory-system-1fb4d';
const MODEL = 'claude-haiku-5-5';   // fast and low-cost; fine for help-desk answers

// Web addresses allowed to call this API: the live site and its preview links.
const ALLOWED_ORIGINS = [
  /^https:\/\/epc-inventory-system\.web\.app$/,
  /^https:\/\/epc-inventory-system\.firebaseapp\.com$/,
  /^https:\/\/epc-inventory-system--[a-z0-9-]+\.web\.app$/,
  /^http:\/\/localhost:\d+$/,
];

// Abuse limits: keep each request (and its cost) bounded.
const MAX_BODY_BYTES = 100 * 1024;
const MAX_TURNS = 24;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 40000;
const MAX_PAGE_CHARS = 60;
const RATE_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 };   // per signed-in user

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });

// Stable system prompt (kept byte-identical between requests so it caches).
const SYSTEM_PROMPT = `You are the help assistant inside the EPC Commercial Corporation Accounting Portal, an internal web app used by the company's accounting staff in the Philippines. Amounts are in Philippine pesos (₱).

What you help with:
- How to use the portal's pages and buttons.
- Accounting and bookkeeping concepts (income statement, cash flow, COGS, gross profit, inventory movement, input/output VAT, expanded withholding tax).
- Philippine tax basics the portal tracks: 12% VAT, EWT, and common BIR forms such as 2550Q, 1601-EQ, 0619-E and 2307. For final tax or legal decisions, say to confirm with the company's accountant or the BIR.

The portal's pages (sidebar menu):
- Dashboard: daily operations summary for one day (sales, gross profit, net income, net cash, a 7-day sales chart, and product performance). Pick a date, then click Generate Report.
- Sales: import POS sales files (XLS/XLSX/CSV), choose the cost method for COGS (Latest Price or Average Price), and review uploads.
- Purchases: purchase and supplier records with check voucher, delivery receipt and sales invoice numbers, input VAT and EWT; import a supplier/purchase ledger.
- Expenses: business and personal expense records.
- Inventory Tracking: incoming/outgoing stock movements; import from MIS; match sales costs.
- Potential Revenue: projected revenue from stock on hand.
- Supplies Tracking: supplies bought and used.
- Tax Monitoring: VAT, EWT and income tax computations for a period.
- E-Sales Records: e-sales records used for VAT output.
- Product Master: the product list (item codes, names, categories, prices).
- Suppliers: supplier details.
- Chart of Accounts: the account list.
- Reports: Income Statement, Sales, Purchases, Tax Summary, Inventory and Cash Flow reports. Choose a tab and dates, then click Generate Report. Export to Excel or PDF.
- Settings: user profile and login. Audit Log: who changed what.
Reports and the dashboard load data only when Generate Report is clicked.

Rules:
- You cannot see the company's records or the user's screen, and you cannot change anything in the portal. If a question needs their figures, ask them to paste the numbers or tell them which page and report shows it.
- Never invent figures, records or features. If you are not sure the portal does something, say so.
- Answer in plain, friendly language that a non-accountant can follow. Keep answers short: a few sentences or a short list. Use simple markdown (bold, lists) only when it helps.
- Each user message may start with a line like "[Page: Purchases]" telling you which page they are on; use it for context and never repeat it back.`;

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const msgs = raw.slice(-MAX_TURNS).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.content) || '').slice(0, MAX_MESSAGE_CHARS).trim(),
  })).filter((m) => m.content);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // must start with the user
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {                // keep the newest within budget
    total += msgs[i].content.length;
    if (total > MAX_TOTAL_CHARS) { msgs.splice(0, i + 1); break; }
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs.length ? msgs : null;
}

// Per-user sliding-window rate limit (in memory; resets if the service restarts).
const hits = new Map();
function rateLimited(uid) {
  const now = Date.now();
  const list = (hits.get(uid) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (list.length >= RATE_LIMIT.max) { hits.set(uid, list); return true; }
  list.push(now); hits.set(uid, list);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [uid, list] of hits) if (!list.some((t) => now - t < RATE_LIMIT.windowMs)) hits.delete(uid);
}, RATE_LIMIT.windowMs).unref();

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

let anthropic = null;
function client() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

async function handleChat(req, res, origin) {
  // Signed-in portal users only.
  const match = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!match) return send(res, 401, { error: 'Please sign in to use the assistant.' }, origin);
  let user;
  try {
    user = await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    return send(res, 401, { error: 'Your session expired. Please sign in again.' }, origin);
  }
  if (rateLimited(user.uid)) {
    return send(res, 429, { error: "You've asked a lot of questions in a short time. Please wait a few minutes." }, origin);
  }

  let body;
  try { body = await readJson(req); } catch (err) {
    return send(res, err.status || 400, { error: 'Your message could not be read. Please try again.' }, origin);
  }
  const messages = cleanMessages(body.messages);
  if (!messages) return send(res, 400, { error: 'Please type a question.' }, origin);
  const page = String(body.page || '').replace(/[\r\n[\]]/g, ' ').trim().slice(0, MAX_PAGE_CHARS);
  if (page) {
    const last = messages[messages.length - 1];
    last.content = `[Page: ${page}]\n${last.content}`;
  }

  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 8000,
      // Short help-desk answers: low effort keeps replies quick and cheap.
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    if (response.stop_reason === 'refusal') {
      return send(res, 200, { reply: "Sorry, I can't help with that one. Try asking about the portal or an accounting topic." }, origin);
    }
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    console.log(JSON.stringify({
      at: new Date().toISOString(), uid: user.uid, model: response.model, stop: response.stop_reason,
      input: response.usage && response.usage.input_tokens,
      cached: response.usage && response.usage.cache_read_input_tokens,
      output: response.usage && response.usage.output_tokens,
    }));
    return send(res, 200, { reply: reply || "Sorry, I couldn't come up with an answer. Please try rephrasing." }, origin);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return send(res, 429, { error: 'The assistant is busy right now. Please try again in a minute.' }, origin);
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('Anthropic key rejected - check ANTHROPIC_API_KEY in /etc/epc-chat.env', err.status);
      return send(res, 500, { error: 'The assistant is not set up correctly. Please tell the administrator.' }, origin);
    }
    if (err instanceof Anthropic.APIError) {
      console.error('Anthropic API error', err.status, err.message);
      return send(res, 502, { error: 'The assistant could not answer right now. Please try again.' }, origin);
    }
    console.error('chat failed', err && err.message);
    return send(res, 500, { error: 'Something went wrong. Please try again.' }, origin);
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin || '';
    const origin = ALLOWED_ORIGINS.some((re) => re.test(reqOrigin)) ? reqOrigin : '';
    const path = (req.url || '').split('?')[0];

    if (path === '/health') return send(res, 200, { ok: true }, origin);
    if (path !== '/api/chat') return send(res, 404, { error: 'Not found.' }, origin);

    if (req.method === 'OPTIONS') {   // CORS preflight
      if (!origin) { res.writeHead(403); return res.end(); }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
      return res.end();
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' }, origin);
    if (!origin) return send(res, 403, { error: 'Not allowed from this website.' });
    return handleChat(req, res, origin);
  });
}

if (require.main === module) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (expected in /etc/epc-chat.env). Exiting.');
    process.exit(1);
  }
  createServer().listen(PORT, '127.0.0.1', () => console.log(`EPC chat API listening on 127.0.0.1:${PORT}`));
}

module.exports = { createServer, cleanMessages };
