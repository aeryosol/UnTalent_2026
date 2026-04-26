/*
  ENV VARS:
  CREDIT_BALANCE_USD  — your current Anthropic credit balance (update manually after top-up)
  COST_PER_SESSION    — cost per 60-question session in USD (default: 0.40)
  GITHUB_TOKEN        — Personal Access Token with repo scope
  GITHUB_REPO         — e.g. "YourUsername/djp-quiz"
*/

const DATA_PATH = "data/sessions.json";

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

async function fetchMeta(token, repo) {
  if (!token || !repo) return null;
  try {
    const url = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!res.ok) return null;
    const file = await res.json();
    const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    return data._meta || null;
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
  const token       = process.env.GITHUB_TOKEN;
  const repo        = process.env.GITHUB_REPO;

  const meta           = await fetchMeta(token, repo);
  const creditsSpent   = meta ? parseFloat(meta.creditsSpentUSD  || 0) : 0;
  const sessionsServed = meta ? parseInt(meta.sessionsServedTotal || 0) : 0;

  const remainingBalance = Math.max(0, balanceRaw - creditsSpent);
  const sessionsLeft     = remainingBalance > 0 ? Math.floor(remainingBalance / costPerSess) : 0;
  const pctRemaining     = balanceRaw > 0
    ? Math.min(100, Math.round((remainingBalance / balanceRaw) * 100))
    : 0;

  const health = pctRemaining >= 40 ? "good" : pctRemaining >= 15 ? "low" : "critical";

  return new Response(JSON.stringify({
    balance:          balanceRaw.toFixed(2),
    creditsSpent:     creditsSpent.toFixed(4),
    remainingBalance: remainingBalance.toFixed(4),
    costPerSession:   costPerSess.toFixed(2),
    sessionsLeft,
    sessionsServed,
    pctRemaining,
    health,
    concurrent:  activeSessions.size,
    metaSource:  meta ? "github" : "fallback"
  }), { status: 200, headers: cors });
};

export const config = { path: "/api/status" };
