/* ─── EPC Accounting Portal — server-side functions ──────────────────────────
   chat: the portal's AI assistant (Claude, via the Anthropic API).

   The Anthropic API key NEVER reaches the browser. It is stored as a Firebase
   secret (Google Secret Manager) and read here, on the server:

     npx -y firebase-tools@latest functions:secrets:set ANTHROPIC_API_KEY

   Only signed-in portal users can call this: the browser sends its Firebase
   ID token, and we verify it before calling Claude. The site reaches this
   function at /api/chat through a Hosting rewrite (see firebase.json), so it is
   same-origin and needs no CORS.
   ──────────────────────────────────────────────────────────────────────────── */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-opus-5-5';

// Abuse limits: keep each request (and its cost) bounded.
const MAX_TURNS = 24;            // messages kept from the conversation
const MAX_MESSAGE_CHARS = 4000;  // per message
const MAX_TOTAL_CHARS = 40000;   // whole conversation
const MAX_PAGE_CHARS = 60;

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

exports.chat = onRequest(
  {
    region: 'asia-southeast1',
    secrets: [ANTHROPIC_API_KEY],
    timeoutSeconds: 120,
    memory: '256MiB',
    maxInstances: 5,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }

    // Signed-in portal users only.
    const match = String(req.get('Authorization') || '').match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Please sign in to use the assistant.' });
      return;
    }
    let user;
    try {
      user = await admin.auth().verifyIdToken(match[1]);
    } catch (err) {
      res.status(401).json({ error: 'Your session expired. Please sign in again.' });
      return;
    }

    const body = req.body || {};
    const messages = cleanMessages(body.messages);
    if (!messages) {
      res.status(400).json({ error: 'Please type a question.' });
      return;
    }
    const page = String(body.page || '').replace(/[\r\n[\]]/g, ' ').trim().slice(0, MAX_PAGE_CHARS);
    if (page) {
      const last = messages[messages.length - 1];
      last.content = `[Page: ${page}]\n${last.content}`;
    }

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 8000,
        // On a safety decline, the API retries the same request on a suitable
        // fallback model inside this call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // Short help-desk answers: low effort keeps replies quick and cheap.
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
      });

      if (response.stop_reason === 'refusal') {
        res.json({ reply: "Sorry, I can't help with that one. Try asking about the portal or an accounting topic." });
        return;
      }
      const reply = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      logger.info('chat', {
        uid: user.uid,
        model: response.model,
        input: response.usage && response.usage.input_tokens,
        cached: response.usage && response.usage.cache_read_input_tokens,
        output: response.usage && response.usage.output_tokens,
        stop: response.stop_reason,
      });
      res.json({ reply: reply || "Sorry, I couldn't come up with an answer. Please try rephrasing." });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        res.status(429).json({ error: 'The assistant is busy right now. Please try again in a minute.' });
      } else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        logger.error('Anthropic key rejected - check the ANTHROPIC_API_KEY secret', { status: err.status });
        res.status(500).json({ error: 'The assistant is not set up correctly. Please tell the administrator.' });
      } else if (err instanceof Anthropic.APIError) {
        logger.error('Anthropic API error', { status: err.status, message: err.message });
        res.status(502).json({ error: 'The assistant could not answer right now. Please try again.' });
      } else {
        logger.error('chat failed', { message: err && err.message });
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
      }
    }
  },
);
