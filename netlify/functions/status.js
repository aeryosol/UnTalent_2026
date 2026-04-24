/*
  ENV VARS (set in Netlify dashboard):
  - CREDIT_BALANCE_USD   : your current balance e.g. "5.00"  (update manually after top-up)
  - SESSIONS_SERVED      : running total of sessions completed (you can reset to 0 anytime)

  Cost model (claude-sonnet-4-5, as of 2025):
  - Input:  $3.00 / 1M tokens
  - Output: $15.00 / 1M tokens
  Per 60-question session estimate:
  - ~90k input tokens (65 prompts × ~1400 tokens each)
  - ~25k output tokens (65 responses × ~385 tokens each)
  → ~$0.27 + $0.375 ≈ $0.64 per session (conservative)
  We store this as COST_PER_SESSION env var so you can tune it.
*/

// Simple in-memory concurrent user tracking (resets on cold start — intentional,
// Netlify functions are ephemeral. Good enough for a live indicator.)
let activeSessions = new Set();
const HEARTBEAT_TTL = 30000; // 30s — clients ping every 20s
const sessionTimestamps = new Map();

function pruneStale() {
  const now = Date.now();
  for (const [id, ts] of sessionTimestamps) {
    if (now - ts > HEARTBEAT_TTL) {
      activeSessions.delete(id);
      sessionTimestamps.delete(id);
    }
  }
}

export default async (req, context) => {
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    });
  }

  pruneStale();

  // POST — heartbeat from active user
  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch(_) {}
    const id = body.sessionId;
    if (id) {
      activeSessions.add(id);
      sessionTimestamps.set(id, Date.now());
    }
    return new Response(JSON.stringify({ ok: true, concurrent: activeSessions.size }), { status: 200, headers: cors });
  }

  // GET — return full status
  const balanceRaw   = parseFloat(process.env.CREDIT_BALANCE_USD || "0");
  const costPerSess  = parseFloat(process.env.COST_PER_SESSION   || "0.64");
  const served       = parseInt(process.env.SESSIONS_SERVED      || "0", 10);

  const sessionsLeft = balanceRaw > 0 ? Math.floor(balanceRaw / costPerSess) : 0;
  const pctRemaining = balanceRaw > 0
    ? Math.min(100, Math.round((sessionsLeft / Math.max(sessionsLeft + served, 1)) * 100))
    : 0;

  // Health level: green ≥40%, amber 15–39%, red <15%
  const health = pctRemaining >= 40 ? "good" : pctRemaining >= 15 ? "low" : "critical";

  return new Response(JSON.stringify({
    balance: balanceRaw.toFixed(2),
    costPerSession: costPerSess.toFixed(2),
    sessionsLeft,
    sessionsServed: served,
    pctRemaining,
    health,
    concurrent: activeSessions.size
  }), { status: 200, headers: cors });
};

export const config = { path: "/api/status" };
