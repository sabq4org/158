const path = require("path");
const express = require("express");
const compression = require("compression");
const { Pool } = require("pg");
const mountAdmin = require("./admin");
const { loadSettings, getSettings } = require("./settings");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's external URLs need SSL; internal ones work either way.
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  // Reuse connections for a while; opening a new TLS connection to the database costs more than the query.
  idleTimeoutMillis: 120000,
});
pool.on("error", err => console.error("Idle database connection dropped", err.message));

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
app.use(compression());
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
  if (!getSettings().lookup_open) return res.status(403).json({ error: "closed" });
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

// Public texts and limits the lookup page renders with.
app.get("/api/site", (req, res) => {
  const s = getSettings();
  res.set("Cache-Control", "no-store");
  res.json({
    gradeLabel: s.grade_label, termTitle: s.term_title, teacherName: s.teacher_name, principalName: s.principal_name,
    max: { test: s.max_test, participation: s.max_participation, projects: s.max_projects },
    open: s.lookup_open, closedMessage: s.closed_message,
  });
});

app.get("/healthz", (req, res) => res.send("ok"));
// Libraries and logos rarely change: let browsers keep them for a week. Pages always revalidate.
const WEEK = 7 * 24 * 3600 * 1000;
app.get("/vendor/html2canvas.min.js", (req, res) => res.sendFile(require.resolve("html2canvas/dist/html2canvas.min.js"), { maxAge: WEEK }));
app.get("/vendor/jspdf.umd.min.js", (req, res) => res.sendFile(require.resolve("jspdf/dist/jspdf.umd.min.js"), { maxAge: WEEK }));
app.use("/img", express.static(path.join(__dirname, "public", "img"), { maxAge: WEEK }));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: res => res.setHeader("Cache-Control", "no-cache") }));

const adminReady = pool.query(SCHEMA).then(() => loadSettings(pool)).then(() => mountAdmin(app, pool));

const port = process.env.PORT || 3000;
adminReady
  .then(() => app.listen(port, () => console.log(`Listening on ${port}`)))
  .catch(err => { console.error("Database setup failed", err); process.exit(1); });
