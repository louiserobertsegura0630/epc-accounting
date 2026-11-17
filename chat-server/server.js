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
     PORT                default 8787 (the HTTPS proxy forwards to it)
     HOST                default 127.0.0.1 (0.0.0.0 inside Docker)
     FIREBASE_PROJECT_ID default inventory-system-1fb4d
   ──────────────────────────────────────────────────────────────────────────── */
const http = require('node:http');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, runTool } = require('./data-tools');

const PORT = Number(process.env.PORT || 8787);
// 127.0.0.1 when Caddy runs on the same machine; 0.0.0.0 inside a Docker
// container that only a reverse proxy on the same Docker network can reach.
const HOST = process.env.HOST || '127.0.0.1';
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
// Data questions (ones that look up figures) per Philippine calendar day.
const DATA_LIMIT_USER = Number(process.env.DATA_LIMIT_USER || 20);
const DATA_LIMIT_TOTAL = Number(process.env.DATA_LIMIT_TOTAL || 200);
const MAX_TOOL_ROUNDS = 5;

if (!getApps().length) initializeApp({ projectId: PROJECT_ID });

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

Looking up figures:
- You have read-only tools for the company's data: get_sales (daily sales summary, at most 31 days per call), get_purchases and get_expenses (at most 92 days per call), and find_product (one product by exact item code). Use them when the user asks for amounts, totals, best or slowest sellers, or product details. Do not use them for how-to questions.
- Each user message starts with a line like "[Today: 2026-11-17] [Page: Purchases]". Use today's date to work out "yesterday", "this month", "last week" and dates written without a year. Never repeat that line back.
- For a range longer than a tool allows, ask the user to pick a shorter range, or point them to the Reports page.
- If a tool returns an error, explain that exact reason plainly. An error starting with FIREBASE_QUOTA means the database's free daily read allowance is used up (reports won't load either until about 4:00 PM Philippine time); say that, don't call it the assistant's limit, and don't show the word FIREBASE_QUOTA. Otherwise suggest the Reports page.
- Show peso amounts like ₱12,345.67 and say which dates the figures cover. Only report figures the tools returned.
- You cannot see the user's screen and you cannot change anything in the portal.

Rules:
- Never invent figures, records or features. If you are not sure the portal does something, say so.
- Answer in plain, friendly language that a non-accountant can follow. Keep answers short: a few sentences or a short list. Use simple markdown (bold, lists) only when it helps.
- The "[Page: …]" part of the first line tells you which page the user is on; use it for context.`;

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

// Daily data-question limits, per person and for everyone, by Philippine date.
// In memory: a restart of the service resets today's counts.
const phDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const dataUse = { day: '', total: 0, byUser: new Map() };
function chargeDataQuestion(uid) {
  const day = phDate();
  if (dataUse.day !== day) { dataUse.day = day; dataUse.total = 0; dataUse.byUser.clear(); }
  const mine = dataUse.byUser.get(uid) || 0;
  if (mine >= DATA_LIMIT_USER) {
    return `Daily limit reached: you can ask ${DATA_LIMIT_USER} data questions per day. It resets at midnight (Philippine time). Use the Reports page for more figures today.`;
  }
  if (dataUse.total >= DATA_LIMIT_TOTAL) {
    return `Daily limit reached: the whole team can ask ${DATA_LIMIT_TOTAL} data questions per day. It resets at midnight (Philippine time). Use the Reports page for more figures today.`;
  }
  dataUse.byUser.set(uid, mine + 1);
  dataUse.total += 1;
  return null;
}
// Give a data question back when the database itself refused (Firebase quota).
function refundDataQuestion(uid) {
  const mine = dataUse.byUser.get(uid) || 0;
  if (mine > 0) dataUse.byUser.set(uid, mine - 1);
  if (dataUse.total > 0) dataUse.total -= 1;
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
    user = await getAuth().verifyIdToken(match[1]);
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
  const last = messages[messages.length - 1];
  last.content = `[Today: ${phDate()}]${page ? ` [Page: ${page}]` : ''}\n${last.content}`;
  const idToken = match[1];

  try {
    // Tool loop: Claude may look up figures (read-only) before answering.
    let convo = messages;
    let response = null;
    let charged = false;
    let limitMessage = null;
    const usage = { input: 0, cached: 0, output: 0, lookups: 0 };
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      response = await client().messages.create({
        model: MODEL,
        max_tokens: 8000,
        // Short help-desk answers: low effort keeps replies quick and cheap.
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: round < MAX_TOOL_ROUNDS ? TOOLS : [],
        messages: convo,
      });
      usage.input += (response.usage && response.usage.input_tokens) || 0;
      usage.cached += (response.usage && response.usage.cache_read_input_tokens) || 0;
      usage.output += (response.usage && response.usage.output_tokens) || 0;
      if (response.stop_reason !== 'tool_use') break;

      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (!charged && !limitMessage) {
        limitMessage = chargeDataQuestion(user.uid);   // one data question per user message
        charged = !limitMessage;
      }
      const results = await Promise.all(uses.map(async (u) => {
        if (limitMessage) return { type: 'tool_result', tool_use_id: u.id, content: limitMessage, is_error: true };
        usage.lookups += 1;
        const r = await runTool(u.name, u.input, idToken);
        return { type: 'tool_result', tool_use_id: u.id, content: r.content, is_error: r.isError };
      }));
      if (charged && results.length && results.every((r) => r.is_error && String(r.content).startsWith('FIREBASE_QUOTA'))) {
        refundDataQuestion(user.uid);
        charged = false;
      }
      convo = [...convo, { role: 'assistant', content: response.content }, { role: 'user', content: results }];
    }
    if (response.stop_reason === 'refusal') {
      return send(res, 200, { reply: "Sorry, I can't help with that one. Try asking about the portal or an accounting topic." }, origin);
    }
    const reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    console.log(JSON.stringify({
      at: new Date().toISOString(), uid: user.uid, model: response.model, stop: response.stop_reason,
      ...usage, dataQuestionsToday: dataUse.byUser.get(user.uid) || 0, teamToday: dataUse.total,
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
  createServer().listen(PORT, HOST, () => console.log(`EPC chat API listening on ${HOST}:${PORT}`));
}

module.exports = { createServer, cleanMessages };
