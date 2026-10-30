/**
 * Branded HTTP error routes for Vercel.
 *
 * Static hosting can serve /error.html for any path, but always with a 200
 * status. Search engines and uptime monitors need the real code, so this tiny
 * Edge Function returns the same page with the requested status.
 *
 * Routing lives in vercel.json:
 *   /403 -> /api/error?status=403   ... and so on for the other codes.
 *
 * The page itself derives its copy from the browser's path (/403), so it keeps
 * working even if the query string is stripped by a proxy.
 */

export const config = { runtime: "edge" };

/** Only the codes Droply actually documents; anything else becomes a 500. */
const ALLOWED = new Set([400, 403, 404, 410, 429, 500, 502, 503, 504]);

/** Keeps the route functional if the static page cannot be fetched. */
const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Request failed — Droply</title>
    <style>
      body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
        font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #f7f8fa; color: #101827; padding: 1.5rem; }
      main { width: min(100%, 520px); }
      h1 { font-size: 1.5rem; letter-spacing: -0.03em; margin: 0 0 0.5rem; }
      p { color: #697586; margin: 0 0 1.5rem; }
      a { color: #1267d5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Droply could not serve this request</h1>
      <p>Reload the page, or head back to the transfer screen.</p>
      <a href="/">Back to Droply</a>
    </main>
  </body>
</html>
`;

export default async function handler(request) {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("status"));
  const status = ALLOWED.has(requested) ? requested : 500;

  let html = FALLBACK_HTML;
  try {
    // Same deployment, public file — no secrets, no user input in the path.
    const response = await fetch(new URL("/error.html", url.origin), {
      headers: { accept: "text/html" },
    });
    if (response.ok) html = await response.text();
  } catch {
    /* fall back to the inline page above */
  }

  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}
