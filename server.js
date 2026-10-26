const path = require("path");
const express = require("express");
const compression = require("compression");
const { Pool } = require("pg");
const mountAdmin = require("./admin");
const { loadSettings, getSettings, maxOf, termTitleOf } = require("./settings");
const grades = require("./grades");
const school = require("./school");
const feedback = require("./feedback");

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
);
-- Set by the teacher; such a student stays in her class but out of its average.
ALTER TABLE students ADD COLUMN IF NOT EXISTS learning_difficulty BOOLEAN NOT NULL DEFAULT false;
-- Homework and the final exam count once the teacher sets their maximum. Notes are hers alone and never leave the panel.
-- Lateness is no longer shown or read; its column stays so nothing saved in it is lost.
ALTER TABLE students ADD COLUMN IF NOT EXISTS homework NUMERIC;
ALTER TABLE students ADD COLUMN IF NOT EXISTS final_exam NUMERIC;
ALTER TABLE students ADD COLUMN IF NOT EXISTS notes TEXT;
CREATE TABLE IF NOT EXISTS lookups (
  id          SERIAL PRIMARY KEY,
  national_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  device      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookups_national_id ON lookups (national_id, created_at DESC);`;

const app = express();
app.set("trust proxy", 1);
app.use(compression());
// The lookup takes no more than an ID. The panel reads its own, bigger bodies (a student's notes), in admin.js.
app.use("/api/lookup", express.json({ limit: "1kb" }));

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

// The teacher sees who looked up their result and when; a failed log must never block the student.
const deviceOf = req => (/iphone|ipad|android|mobile/i.test(req.get("user-agent") || "") ? "جوال" : "كمبيوتر");
const logLookup = (id, kind, req) =>
  pool.query("INSERT INTO lookups (national_id, kind, device) VALUES ($1, $2, $3)", [id, kind, deviceOf(req)])
    .catch(err => console.error("lookup log failed", err.message));

app.post("/api/lookup", async (req, res) => {
  if (!getSettings().lookup_open) return res.status(403).json({ error: "closed" });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  const id = String(req.body?.id || "").replace(/\D/g, "");
  if (id.length < 9 || id.length > 10) return res.status(400).json({ error: "invalid_id" });
  try {
    const { rows } = await pool.query("SELECT s.*, c.track FROM students s LEFT JOIN classes c ON c.name = s.class WHERE s.national_id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const s = rows[0];
    logLookup(s.national_id, "view", req);
    // A student with learning difficulties is not compared with her class.
    const [history, classStats] = await Promise.all([grades.history(pool, s.national_id), s.learning_difficulty ? null : grades.classStats(pool, s.class)]);
    res.json({
      id: s.national_id,
      name: s.name,
      class: s.class,
      classLabel: grades.Report.classLabel(s.class),
      track: s.track || "",
      test1: num(s.test1),
      test2: num(s.test2),
      testAvg: num(s.test_avg),
      participation: num(s.participation),
      projects: num(s.projects),
      homework: num(s.homework),
      finalExam: num(s.final_exam),
      learningStyle: s.learning_style || "",
      email: s.email || "",
      // Only the class average leaves the server, never a classmate's score or name.
      classStats,
      history,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// Public texts and limits the lookup page renders with.
app.get("/api/site", async (req, res) => {
  const s = getSettings();
  const cal = await school.now(pool).catch(() => null);
  res.set("Cache-Control", "no-store");
  res.json({
    gradeLabel: s.grade_label, termTitle: termTitleOf(s, cal), teacherName: s.teacher_name, principalName: s.principal_name,
    max: maxOf(s), compareChart: s.compare_chart,
    open: s.lookup_open, closedMessage: s.closed_message,
  });
});

app.post("/api/lookup/pdf", async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  const id = String(req.body?.id || "").replace(/\D/g, "");
  const { rowCount } = await pool.query("SELECT 1 FROM students WHERE national_id = $1", [id]).catch(() => ({ rowCount: 0 }));
  if (rowCount) logLookup(id, "pdf", req);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));
// Libraries and logos rarely change: let browsers keep them for a week. Pages always revalidate.
const WEEK = 7 * 24 * 3600 * 1000;
app.get("/vendor/html2canvas.min.js", (req, res) => res.sendFile(require.resolve("html2canvas/dist/html2canvas.min.js"), { maxAge: WEEK }));
app.get("/vendor/jspdf.umd.min.js", (req, res) => res.sendFile(require.resolve("jspdf/dist/jspdf.umd.min.js"), { maxAge: WEEK }));
// Interactive lessons: separate pages, not linked from the lookup.
const page = file => (req, res) => res.sendFile(path.join(__dirname, "public", "lessons", file), { headers: { "Cache-Control": "no-cache" } });
for (const name of ["polynomials", "polynomial-functions"]) app.get([`/lessons/${name}`, `/lessons/${name}/`], page(`${name}.html`));
// The model lesson's attendees sign in and rate it here; the teacher reads both on the dashboard after signing in to the panel.
app.get(["/lessons/polynomials/attendance", "/lessons/polynomials/attendance/"], page("polynomials-attendance.html"));
app.get(["/lessons/polynomials/feedback", "/lessons/polynomials/feedback/"], page("polynomials-feedback.html"));
app.get(["/lessons/polynomials/dashboard", "/lessons/polynomials/feedback/results"], page("polynomials-dashboard.html"));
feedback.mount(app, pool);
app.use("/img", express.static(path.join(__dirname, "public", "img"), { maxAge: WEEK }));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: res => res.setHeader("Cache-Control", "no-cache") }));

const adminReady = pool.query(SCHEMA).then(() => pool.query(grades.SCHEMA)).then(() => pool.query(feedback.SCHEMA)).then(() => school.load(pool)).then(() => loadSettings(pool)).then(() => mountAdmin(app, pool));

const port = process.env.PORT || 3000;
adminReady
  .then(() => app.listen(port, () => console.log(`Listening on ${port}`)))
  .catch(err => { console.error("Database setup failed", err); process.exit(1); });
