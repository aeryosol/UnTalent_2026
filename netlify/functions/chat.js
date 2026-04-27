export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key"
      }
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const serverKey = process.env.ANTHROPIC_API_KEY;
  const clientKey = req.headers.get("x-api-key");
  const apiKey = serverKey || clientKey;

  if (!apiKey || !apiKey.startsWith("sk-ant")) {
    return new Response(JSON.stringify({ error: { message: "NO_SERVER_KEY" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Abort the Anthropic request after 24s — gives us 2s buffer before
  // Netlify's 26s hard limit kills the function with a 504
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    clearTimeout(timeoutId);
    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // Return 408 (Request Timeout) so the client knows to retry
    const isTimeout = err.name === "AbortError";
    return new Response(
      JSON.stringify({ error: { message: isTimeout
        ? "Anthropic API timeout — server took too long. Retry."
        : "Proxy error: " + err.message
      }}),
      {
        status: isTimeout ? 408 : 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      }
    );
  }
};

export const config = { path: "/api/chat" };
