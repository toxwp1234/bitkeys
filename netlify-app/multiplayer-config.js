// Supabase Realtime — the multiplayer cursors. Both values are PUBLIC by design: they ship to
// every browser that opens the page, like any Supabase front-end. The publishable (or legacy
// anon) key can only do what the project's settings allow; never put the secret / service_role
// key here.
//
// Supabase dashboard -> Project Settings -> API:
//   SUPABASE_URL  "Project URL"            e.g. "https://abcdefghijklmnop.supabase.co"
//   SUPABASE_KEY  "Publishable key"        e.g. "sb_publishable_…"  (or the legacy "anon" key)
//
// Left empty, multiplayer is off in production. On localhost it then falls back to a same-browser
// channel, so two tabs can see each other without a Supabase project (or a single message spent).
export const SUPABASE_URL = "";
export const SUPABASE_KEY = "";
