export default async (req, context) => {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY);
  return new Response(JSON.stringify({ hasServerKey: hasKey }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

export const config = { path: "/api/check-key" };
