// POST /api/visit — adds 1 to today's visit count. Nothing about the visitor is sent or kept:
// the page calls this at most once a day per browser, and the database only holds one number per day
// (Supabase, schema ellenial_maps, same pattern as ellenial.app, Luncheon and Weather).
// The key is Supabase's publishable key: it can only run the counting function.

const SUPABASE = "https://knvrvmqdxvcatsrvkrgx.supabase.co";
const KEY = "sb_publishable_5e3mg1E-r-P_to34ONwRfw_FQYUwy3z";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end();
  }
  try {
    const r = await fetch(`${SUPABASE}/rest/v1/rpc/maps_count_visit`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000)
    });
    res.statusCode = r.ok ? 204 : 502;
  } catch (e) {
    res.statusCode = 502; // a missed count is fine; the page never waits for this
  }
  res.end();
};
