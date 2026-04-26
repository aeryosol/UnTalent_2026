/*
  ENV VARS needed in Netlify:
  JSONBIN_API_KEY   — your JSONBin master key
  JSONBIN_BIN_ID    — bin ID (auto-created on first deploy if empty)

  Bin structure:
  {
    "_meta": {
      "sessionsServedTotal": 12,
      "creditsSpentUSD": 4.80,
      "lastUpdated": "2026-04-25T..."
    },
    "sessions": [ ... ]
  }

  _meta is read by status.js to calculate real remaining sessions.
  It increments automatically every time a session is saved.
*/

const BASE = "https://api.jsonbin.io/v3/b";
const COST_PER_SESSION = parseFloat(process.env.COST_PER_SESSION || "0.40");

async function getBin(apiKey, binId) {
  const res = await fetch(`${BASE}/${binId}/latest`, {
    headers: { "X-Master-Key": apiKey }
  });
  if (!res.ok) throw new Error(`JSONBin GET failed: ${res.status}`);
  const d = await res.json();
  return d.record;
}

async function updateBin(apiKey, binId, data) {
  const res = await fetch(`${BASE}/${binId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": apiKey },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`JSONBin PUT failed: ${res.status}`);
  return res.json();
}

async function createBin(apiKey) {
  const initial = {
    _meta: { sessionsServedTotal: 0, creditsSpentUSD: 0, lastUpdated: new Date().toISOString() },
    sessions: []
  };
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": apiKey,
      "X-Bin-Name": "djp-quiz-sessions",
      "X-Bin-Private": "false"
    },
    body: JSON.stringify(initial)
  });
  if (!res.ok) throw new Error(`JSONBin CREATE failed: ${res.status}`);
  const d = await res.json();
  return d.metadata.id;
}

export default async (req, context) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    });
  }

  const apiKey = process.env.JSONBIN_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "Storage not configured" }), { status: 503, headers: cors });

  let binId = process.env.JSONBIN_BIN_ID;
  if (!binId) {
    try { binId = await createBin(apiKey); }
    catch(e) { return new Response(JSON.stringify({ error: "Could not create storage: " + e.message }), { status: 503, headers: cors }); }
  }

  // ── GET /api/sessions — list sessions ──
  if (req.method === "GET") {
    const url = new URL(req.url);
    const position = url.searchParams.get("position");
    const segment  = url.searchParams.get("segment");
    const id       = url.searchParams.get("id");

    try {
      const data = await getBin(apiKey, binId);

      // Fetch single session by ID
      if (id) {
        const session = (data.sessions || []).find(s => s.id === id);
        if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: cors });
        return new Response(JSON.stringify(session), { status: 200, headers: cors });
      }

      // List sessions with optional filter
      let sessions = (data.sessions || []).map(s => ({
        id: s.id,
        position: s.position,
        segment: s.segment,
        segmentLabel: s.segmentLabel,
        score: s.score,
        totalQ: s.totalQ,
        correct: s.correct,
        completedAt: s.completedAt,
        questionCount: s.questions?.length || 0
      }));
      if (position) sessions = sessions.filter(s => s.position === position);
      if (segment)  sessions = sessions.filter(s => s.segment === segment);
      sessions.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

      // Include _meta so status.js can read it without a separate call
      const meta = data._meta || { sessionsServedTotal: 0, creditsSpentUSD: 0 };
      return new Response(JSON.stringify({ sessions, total: sessions.length, _meta: meta }), { status: 200, headers: cors });

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  // ── POST /api/sessions ──
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

    // action: "get" — fetch one full session
    if (body.action === "get" && body.id) {
      try {
        const data = await getBin(apiKey, binId);
        const session = (data.sessions || []).find(s => s.id === body.id);
        if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: cors });
        return new Response(JSON.stringify(session), { status: 200, headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // action: "save" — save completed session + increment _meta counters
    if (body.action === "save") {
      const { session } = body;
      if (!session?.id || !session?.questions?.length) {
        return new Response(JSON.stringify({ error: "Invalid session data" }), { status: 400, headers: cors });
      }

      // Slim the session to stay under JSONBin 100KB limit
      const slim = {
        id:           session.id,
        position:     session.position,
        segment:      session.segment,
        segmentLabel: session.segmentLabel,
        score:        session.score,
        totalQ:       session.totalQ,
        correct:      session.correct,
        completedAt:  session.completedAt,
        questions: (session.questions || []).map(q => ({
          type:        q.type,
          caseIdx:     q.caseIdx,
          subIdx:      q.subIdx,
          comp:        (q.comp || "").slice(0, 50),
          compLevel:   q.compLevel,
          question:    (q.question    || "").slice(0, 250),
          options:     Object.fromEntries(
                         Object.entries(q.options || {}).map(([k,v]) => [k, (v||"").slice(0, 150)])
                       ),
          correct:     q.correct,
          explanation: (q.explanation || "").slice(0, 180),
          source:      (q.source      || "").slice(0, 60),
          vigTitle:    q.vigTitle ? (q.vigTitle || "").slice(0, 80) : null,
          vigBody:     (q.subIdx === 0 && q.vigBody) ? (q.vigBody || "").slice(0, 300) : null,
          userAnswer:  q.userAnswer || null,
          wasCorrect:  q.wasCorrect || false
        }))
      };

      let sizeKB = Math.round(JSON.stringify(slim).length / 1024);

      // If still too large, apply emergency truncation
      if (sizeKB > 88) {
        slim.questions = slim.questions.map(q => ({
          ...q,
          question:    (q.question    || "").slice(0, 160),
          options:     Object.fromEntries(Object.entries(q.options||{}).map(([k,v])=>[k,(v||"").slice(0,100)])),
          explanation: (q.explanation || "").slice(0, 100),
          vigBody:     q.vigBody ? (q.vigBody||"").slice(0, 150) : null,
        }));
        sizeKB = Math.round(JSON.stringify(slim).length / 1024);
      }

      if (sizeKB > 95) {
        return new Response(JSON.stringify({ error: `Session too large: ${sizeKB}KB even after truncation. Max 95KB.` }), { status: 413, headers: cors });
      }

      try {
        const data = await getBin(apiKey, binId);

        // Update sessions array
        const sessions = data.sessions || [];
        const isNew = sessions.findIndex(s => s.id === slim.id) < 0;
        const idx = sessions.findIndex(s => s.id === slim.id);
        if (idx >= 0) sessions[idx] = slim;
        else sessions.push(slim);
        if (sessions.length > 100) sessions.splice(0, sessions.length - 100);

        // Update _meta — only increment for genuinely new sessions, not re-saves
        const meta = data._meta || { sessionsServedTotal: 0, creditsSpentUSD: 0 };
        if (isNew) {
          meta.sessionsServedTotal = (meta.sessionsServedTotal || 0) + 1;
          meta.creditsSpentUSD = parseFloat(((meta.creditsSpentUSD || 0) + COST_PER_SESSION).toFixed(4));
        }
        meta.lastUpdated = new Date().toISOString();

        await updateBin(apiKey, binId, { _meta: meta, sessions });

        return new Response(JSON.stringify({
          ok: true,
          id: slim.id,
          sizeKB,
          meta: {
            sessionsServedTotal: meta.sessionsServedTotal,
            creditsSpentUSD: meta.creditsSpentUSD
          }
        }), { status: 200, headers: cors });

      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }
  }

  return new Response(JSON.stringify({ error: "Unknown request" }), { status: 400, headers: cors });
};

export const config = { path: "/api/sessions" };
