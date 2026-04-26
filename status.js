/*
  ENV VARS:
  CREDIT_BALANCE_USD  — your current Anthropic credit balance (update manually after top-up)
  COST_PER_SESSION    — cost per 60-question session in USD (default: 0.40)
  JSONBIN_API_KEY     — same key used by sessions.js
  JSONBIN_BIN_ID      — same bin ID used by sessions.js

  How sessionsLeft is calculated:
    creditsSpentUSD  → read from JSONBin _meta (auto-incremented on every session save)
    remainingBalance → CREDIT_BALANCE_USD - creditsSpentUSD
    sessionsLeft     → floor(remainingBalance / COST_PER_SESSION)

  This means sessionsLeft goes down automatically every time a user completes a session,
  without any manual update. You only need to update CREDIT_BALANCE_USD when you top up.
*/

const BASE = "https://api.jsonbin.io/v3/b";

let activeSessions = new Set();
const sessionTimestamps = new Map();
const HEARTBEAT_TTL = 30000;

function pruneStale() {
  const now = Date.now();
  for (const [id, ts] of sessionTimestamps) {
    if (now - ts > HEARTBEAT_TTL) {
      activeSessions.delete(id);
      sessionTimestamps.delete(id);
    }
  }
}

async function fetchMeta(apiKey, binId) {
  if (!apiKey || !binId) return null;
  try {
    const res = await fetch(`${BASE}/${binId}/latest`, {
      headers: { "X-Master-Key": apiKey }
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.record?._meta || null;
  } catch {
    return null;
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
  const balanceRaw  = parseFloat(process.env.CREDIT_BALANCE_USD || "0");
  const costPerSess = parseFloat(process.env.COST_PER_SESSION   || "0.40");
  const apiKey      = process.env.JSONBIN_API_KEY;
  const binId       = process.env.JSONBIN_BIN_ID;

  // Read live usage counters from JSONBin _meta
  const meta = await fetchMeta(apiKey, binId);
  const creditsSpent      = meta ? parseFloat(meta.creditsSpentUSD  || 0) : 0;
  const sessionsServed    = meta ? parseInt(meta.sessionsServedTotal || 0) : 0;

  // Calculate remaining balance and sessions left
  const remainingBalance  = Math.max(0, balanceRaw - creditsSpent);
  const sessionsLeft      = remainingBalance > 0 ? Math.floor(remainingBalance / costPerSess) : 0;

  // Percentage: how much of original balance is still left
  const pctRemaining = balanceRaw > 0
    ? Math.min(100, Math.round((remainingBalance / balanceRaw) * 100))
    : 0;

  // Health: green ≥40%, amber 15–39%, red <15%
  const health = pctRemaining >= 40 ? "good" : pctRemaining >= 15 ? "low" : "critical";

  return new Response(JSON.stringify({
    balance:         balanceRaw.toFixed(2),
    creditsSpent:    creditsSpent.toFixed(4),
    remainingBalance: remainingBalance.toFixed(4),
    costPerSession:  costPerSess.toFixed(2),
    sessionsLeft,
    sessionsServed,
    pctRemaining,
    health,
    concurrent:      activeSessions.size,
    metaSource:      meta ? "jsonbin" : "fallback"
  }), { status: 200, headers: cors });
};

export const config = { path: "/api/status" };
