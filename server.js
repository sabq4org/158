const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const mountAdmin = require("./admin");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's external URLs need SSL; internal ones work either way.
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  national_id     TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  class           TEXT,
  test1           NUMERIC,
  test2           NUMERIC,
  test_avg        NUMERIC,
  participation   NUMERIC,
  projects        NUMERIC,
  lateness        NUMERIC,
  learning_style  TEXT,
  email           TEXT
);`;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1kb" }));

// Simple per-IP limit so nobody can walk through ID numbers.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_LOOKUPS = 30;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_LOOKUPS;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (list.every(t => now - t >= WINDOW_MS)) hits.delete(ip);
}, WINDOW_MS).unref();

const num = v => (v === null ? null : Number(v));

app.post("/api/lookup", async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  const id = String(req.body?.id || "").replace(/\D/g, "");
  if (id.length < 9 || id.length > 10) return res.status(400).json({ error: "invalid_id" });
  try {
    const { rows } = await pool.query("SELECT * FROM students WHERE national_id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const s = rows[0];
    res.json({
      id: s.national_id,
      name: s.name,
      class: s.class,
      test1: num(s.test1),
      test2: num(s.test2),
      testAvg: num(s.test_avg),
      participation: num(s.participation),
      projects: num(s.projects),
      lateness: num(s.lateness),
      learningStyle: s.learning_style || "",
      email: s.email || "",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));
app.get("/vendor/html2canvas.min.js", (req, res) => res.sendFile(require.resolve("html2canvas/dist/html2canvas.min.js")));
app.get("/vendor/jspdf.umd.min.js", (req, res) => res.sendFile(require.resolve("jspdf/dist/jspdf.umd.min.js")));
app.use(express.static(path.join(__dirname, "public")));

const adminReady = pool.query(SCHEMA).then(() => mountAdmin(app, pool));

const port = process.env.PORT || 3000;
adminReady
  .then(() => app.listen(port, () => console.log(`Listening on ${port}`)))
  .catch(err => { console.error("Database setup failed", err); process.exit(1); });
