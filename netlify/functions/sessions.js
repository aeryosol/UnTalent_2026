/*
  ENV VARS needed in Netlify:
  JSONBIN_API_KEY   — your JSONBin master key (get free at jsonbin.io)
  JSONBIN_BIN_ID    — bin ID created once (leave empty first deploy, it auto-creates)

  Each "bin" is a JSON object:
  {
    "sessions": [
      {
        "id": "SES-XXXXXX",
        "position": "Kepala Seksi Pengawasan",
        "segment": "A",
        "segmentLabel": "Jabatan Pengawas",
        "score": 72,
        "totalQ": 60,
        "correct": 43,
        "completedAt": "2026-04-25T10:00:00Z",
        "questions": [ { question, options, correct, explanation, source, comp, type, caseIdx... } ]
      }
    ]
  }
*/

const BASE = "https://api.jsonbin.io/v3/b";

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
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Master-Key": apiKey, "X-Bin-Name": "djp-quiz-sessions", "X-Bin-Private": "false" },
    body: JSON.stringify({ sessions: [] })
  });
  if (!res.ok) throw new Error(`JSONBin CREATE failed: ${res.status}`);
  const d = await res.json();
  return d.metadata.id;
}

export default async (req, context) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });

  const apiKey = process.env.JSONBIN_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "Storage not configured" }), { status: 503, headers: cors });

  let binId = process.env.JSONBIN_BIN_ID;

  // Auto-create bin if not set
  if (!binId) {
    try { binId = await createBin(apiKey); }
    catch(e) { return new Response(JSON.stringify({ error: "Could not create storage: " + e.message }), { status: 503, headers: cors }); }
  }

  // GET — list sessions (optionally filter by position)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const position = url.searchParams.get("position");
    const segment  = url.searchParams.get("segment");
    try {
      const data = await getBin(apiKey, binId);
      let sessions = (data.sessions || []).map(s => ({
        id: s.id, position: s.position, segment: s.segment, segmentLabel: s.segmentLabel,
        score: s.score, totalQ: s.totalQ, correct: s.correct, completedAt: s.completedAt,
        questionCount: s.questions?.length || 0
      }));
      if (position) sessions = sessions.filter(s => s.position === position);
      if (segment)  sessions = sessions.filter(s => s.segment  === segment);
      sessions.sort((a,b) => new Date(b.completedAt) - new Date(a.completedAt));
      return new Response(JSON.stringify({ sessions, total: sessions.length }), { status: 200, headers: cors });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  // GET with ?id=SES-XXX — fetch one full session
  if (req.method === "GET") {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (id) {
      try {
        const data = await getBin(apiKey, binId);
        const session = (data.sessions || []).find(s => s.id === id);
        if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: cors });
        return new Response(JSON.stringify(session), { status: 200, headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }
  }

  // POST — save a completed session or fetch a single session by id
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

    // Fetch single session
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

    // Save session
    if (body.action === "save") {
      const { session } = body;
      if (!session?.id || !session?.questions?.length) return new Response(JSON.stringify({ error: "Invalid session data" }), { status: 400, headers: cors });
      try {
        const data = await getBin(apiKey, binId);
        const sessions = data.sessions || [];
        // Deduplicate
        const idx = sessions.findIndex(s => s.id === session.id);
        if (idx >= 0) sessions[idx] = session;
        else sessions.push(session);
        // Keep last 200 sessions per bin
        if (sessions.length > 200) sessions.splice(0, sessions.length - 200);
        await updateBin(apiKey, binId, { sessions });
        return new Response(JSON.stringify({ ok: true, id: session.id }), { status: 200, headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }
  }

  return new Response(JSON.stringify({ error: "Unknown request" }), { status: 400, headers: cors });
};

export const config = { path: "/api/sessions" };
