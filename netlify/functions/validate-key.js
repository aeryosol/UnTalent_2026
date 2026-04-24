/*
  ENV VARS required in Netlify dashboard:
  - TEAM_CODES      : comma-separated list e.g. "DJPTEAM2026,INTERNAL99"
  - SESSION_KEYS    : comma-separated list of valid unused keys e.g. "UJIAN-A3X9-2026,UJIAN-B7K2-2026"

  When a paid session key is "used", this function removes it from SESSION_KEYS.
  Because Netlify env vars can't be mutated at runtime, we use a lightweight
  approach: a separate USED_KEYS env var acts as a denylist.
  You manually add used keys to USED_KEYS in the Netlify dashboard after verifying receipts.

  Workflow for paid users:
  1. User submits request form (request.html)
  2. You verify bank transfer receipt
  3. You generate a key (e.g. UJIAN-XXXX-2026) and add it to SESSION_KEYS env var
  4. You send the key to the user via WhatsApp/email
  5. User enters key → validated here → gets 1 session
  6. After session ends, app calls type:"use" → you see it in function logs
     (optionally move the key from SESSION_KEYS to USED_KEYS to prevent reuse)
*/

export default async (req, context) => {
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });
  }

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ valid: false, message: "Invalid request." }), { status: 400, headers: cors }); }

  const { type, code } = body;
  if (!type || !code) return new Response(JSON.stringify({ valid: false, message: "Missing fields." }), { status: 400, headers: cors });

  const normalized = String(code).trim().toUpperCase();

  // ── TEAM CODE ──
  if (type === "team") {
    const raw = process.env.TEAM_CODES || "";
    const codes = raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (codes.includes(normalized)) {
      return new Response(JSON.stringify({ valid: true }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ valid: false, message: "Kode tim tidak dikenali. Hubungi admin." }), { status: 200, headers: cors });
  }

  // ── SESSION KEY (validate before quiz) ──
  if (type === "session") {
    const rawKeys = process.env.SESSION_KEYS || "";
    const rawUsed = process.env.USED_KEYS || "";
    const validKeys = rawKeys.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const usedKeys  = rawUsed.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

    if (!validKeys.includes(normalized)) {
      return new Response(JSON.stringify({ valid: false, message: "Kode sesi tidak dikenali. Pastikan kode sudah benar." }), { status: 200, headers: cors });
    }
    if (usedKeys.includes(normalized)) {
      return new Response(JSON.stringify({ valid: false, message: "Kode sesi ini sudah pernah digunakan." }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ valid: true }), { status: 200, headers: cors });
  }

  // ── MARK AS USED (called when quiz session ends) ──
  if (type === "use") {
    // Log it — you can see this in Netlify's function logs
    console.log(`SESSION_USED: ${normalized} at ${new Date().toISOString()}`);
    // Note: to prevent reuse, manually add this key to USED_KEYS env var in Netlify dashboard
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
  }

  return new Response(JSON.stringify({ valid: false, message: "Unknown request type." }), { status: 400, headers: cors });
};

export const config = { path: "/api/validate-key" };
