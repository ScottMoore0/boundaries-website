/**
 * PRONI catalogue search — full-text search over the ~1.5M-record PRONI
 * eCatalogue snapshot, backed by a Cloudflare D1 (SQLite + FTS5) database.
 *
 * Usage: GET /_api/proni/search?q=antrim%20minute&limit=25
 *
 * Requires a D1 binding named PRONI_DB (see the deploy runbook). The database
 * has a single FTS5 table `proni` (searchable: ref, title, dates; unindexed
 * metadata for display + linking into the browse hierarchy).
 */

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

// Turn free text into an FTS5 MATCH expression. FTS5 ANDs bare terms, so every
// typed word must appear; the final word is a prefix match for search-as-you-type.
// Non-alphanumeric characters (including the '/' in references) are treated as
// token separators, so "BG/1" becomes the terms bg AND 1.
function buildMatch(query) {
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 12);
  if (!tokens.length) return null;
  return tokens
    .map((t, i) => (i === tokens.length - 1 && t.length >= 2 ? `${t}*` : t))
    .join(' ');
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT);

  const json = (body, status = 200, extraHeaders = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
        ...extraHeaders,
      },
    });

  if (query.length < 2) return json({ query, results: [] });

  const match = buildMatch(query);
  if (!match) return json({ query, results: [] });

  const db = context.env.PRONI_DB;
  if (!db) return json({ query, results: [], error: 'PRONI_DB binding not configured' }, 503);

  try {
    const stmt = db.prepare(
      `SELECT ref, slug, title, level, dates, parent, parent_slug AS parentSlug,
              has_children AS hasChildren, fond, bm25(proni) AS rank
         FROM proni
        WHERE proni MATCH ?1
        ORDER BY rank
        LIMIT ?2`
    ).bind(match, limit);
    const { results } = await stmt.all();
    return json({
      query,
      match,
      count: results.length,
      results: results.map((r) => ({
        ref: r.ref,
        slug: r.slug,
        title: r.title || r.ref,
        level: r.level || '',
        dates: r.dates || '',
        parent: r.parent || '',
        parentSlug: r.parentSlug || '',
        hasChildren: !!r.hasChildren,
        fond: r.fond || '',
        url: `/browse/#/proni/${encodeURIComponent(r.slug)}`,
      })),
    });
  } catch (error) {
    return json({ query, results: [], error: String(error && error.message || error) }, 500);
  }
}
