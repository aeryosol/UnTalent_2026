/*
  GitHub-backed session storage.

  ENV VARS needed in Netlify:
  GITHUB_TOKEN  — Personal Access Token with repo scope
  GITHUB_REPO   — e.g. "YourUsername/djp-quiz"

  Sessions are stored in data/sessions.json in the repo root.
  The file is read/written via the GitHub Contents API.
  No key rotation, no size limits beyond GitHub's 100MB file cap,
  no request limits that matter at this scale.

  File structure:
  {
    "_meta": { "sessionsServedTotal": N, "creditsSpentUSD": X, "lastUpdated": "..." },
    "sessions": [ ...slim session objects... ]
  }
*/

const COST_PER_SESSION = parseFloat(process.env.COST_PER_SESSION || "0.40");
const DATA_PATH = "data/sessions.json";

function githubHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

async function getFile(token, repo) {
  const url = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (res.status === 404) {
    // File doesn't exist yet — return empty structure
    return { content: { _meta: { sessionsServedTotal: 0, creditsSpentUSD: 0, lastUpdated: "" }, sessions: [] }, sha: null };
  }
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
  const file = await res.json();
  const decoded = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  return { content: decoded, sha: file.sha };
}

async function putFile(token, repo, data, sha) {
  const url = `https://api.github.com/repos/${repo}/contents/${DATA_PATH}`;
  const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
  const body = {
    message: `Update sessions [${new Date().toISOString()}]`,
    content: encoded,
    ...(sha ? { sha } : {})
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: githubHeaders(token),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function slimSession(session) {
  return {
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
      comp:        (q.comp         || "").slice(0, 50),
      compLevel:   q.compLevel,
      question:    (q.question     || "").slice(0, 250),
      options:     Object.fromEntries(
                     Object.entries(q.options || {}).map(([k, v]) => [k, (v || "").slice(0, 150)])
                   ),
      correct:     q.correct,
      explanation: (q.explanation  || "").slice(0, 180),
      source:      (q.source       || "").slice(0, 60),
      vigTitle:    q.vigTitle ? (q.vigTitle || "").slice(0, 80) : null,
      vigBody:     (q.subIdx === 0 && q.vigBody) ? (q.vigBody || "").slice(0, 300) : null,
      userAnswer:  q.userAnswer  || null,
      wasCorrect:  q.wasCorrect  || false
    }))
  };
}

export default async (req, context) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    });
  }

  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;

  if (!token || !repo) {
    return new Response(JSON.stringify({ error: "GitHub storage not configured. Set GITHUB_TOKEN and GITHUB_REPO env vars." }), { status: 503, headers: cors });
  }

  // ── GET — list sessions ──
  if (req.method === "GET") {
    const url      = new URL(req.url);
    const position = url.searchParams.get("position");
    const segment  = url.searchParams.get("segment");
    const id       = url.searchParams.get("id");

    try {
      const { content } = await getFile(token, repo);

      // Fetch single full session by ID
      if (id) {
        const session = (content.sessions || []).find(s => s.id === id);
        if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: cors });
        return new Response(JSON.stringify(session), { status: 200, headers: cors });
      }

      // List sessions — strip questions array for list view
      let sessions = (content.sessions || []).map(s => ({
        id:            s.id,
        position:      s.position,
        segment:       s.segment,
        segmentLabel:  s.segmentLabel,
        score:         s.score,
        totalQ:        s.totalQ,
        correct:       s.correct,
        completedAt:   s.completedAt,
        questionCount: s.questions?.length || 0
      }));

      if (position) sessions = sessions.filter(s => s.position === position);
      if (segment)  sessions = sessions.filter(s => s.segment  === segment);
      sessions.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

      const meta = content._meta || { sessionsServedTotal: 0, creditsSpentUSD: 0 };
      return new Response(JSON.stringify({ sessions, total: sessions.length, _meta: meta }), { status: 200, headers: cors });

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  // ── POST ──
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: cors }); }

    // action: "get" — fetch one full session by ID
    if (body.action === "get" && body.id) {
      try {
        const { content } = await getFile(token, repo);
        const session = (content.sessions || []).find(s => s.id === body.id);
        if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: cors });
        return new Response(JSON.stringify(session), { status: 200, headers: cors });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // action: "save" — save completed session
    if (body.action === "save") {
      const { session } = body;
      if (!session?.id || !session?.questions?.length) {
        return new Response(JSON.stringify({ error: "Invalid session data" }), { status: 400, headers: cors });
      }

      const slim = slimSession(session);

      try {
        // Read current file (with sha for update)
        const { content, sha } = await getFile(token, repo);

        const sessions = content.sessions || [];
        const existingIdx = sessions.findIndex(s => s.id === slim.id);
        const isNew = existingIdx < 0;

        if (isNew) sessions.push(slim);
        else sessions[existingIdx] = slim;

        // Keep latest 150 sessions
        if (sessions.length > 150) sessions.splice(0, sessions.length - 150);

        // Update _meta only for new sessions
        const meta = content._meta || { sessionsServedTotal: 0, creditsSpentUSD: 0 };
        if (isNew) {
          meta.sessionsServedTotal = (meta.sessionsServedTotal || 0) + 1;
          meta.creditsSpentUSD    = parseFloat(((meta.creditsSpentUSD || 0) + COST_PER_SESSION).toFixed(4));
        }
        meta.lastUpdated = new Date().toISOString();

        await putFile(token, repo, { _meta: meta, sessions }, sha);

        const sizeKB = Math.round(JSON.stringify(slim).length / 1024);
        return new Response(JSON.stringify({
          ok: true,
          id: slim.id,
          sizeKB,
          storage: "github",
          meta: { sessionsServedTotal: meta.sessionsServedTotal, creditsSpentUSD: meta.creditsSpentUSD }
        }), { status: 200, headers: cors });

      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }
  }

  return new Response(JSON.stringify({ error: "Unknown request" }), { status: 400, headers: cors });
};

export const config = { path: "/api/sessions" };
