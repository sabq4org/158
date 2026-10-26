const express = require("express");
const QRCode = require("qrcode");

// Attendees' ratings of a workshop the teacher gave. The questions live in the page; the server only knows
// their keys, so an answer it does not expect is dropped instead of stored.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workshop_feedback (
  id          SERIAL PRIMARY KEY,
  workshop    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  role        TEXT,
  name        TEXT,
  overall     SMALLINT NOT NULL,
  ratings     JSONB NOT NULL DEFAULT '{}',
  moments     JSONB NOT NULL DEFAULT '[]',
  apply       JSONB NOT NULL DEFAULT '[]',
  strengths   TEXT,
  suggestions TEXT
);
CREATE INDEX IF NOT EXISTS workshop_feedback_workshop ON workshop_feedback (workshop, created_at DESC);
CREATE TABLE IF NOT EXISTS workshop_attendance (
  id         SERIAL PRIMARY KEY,
  workshop   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name       TEXT NOT NULL,
  job        TEXT NOT NULL,
  workplace  TEXT NOT NULL,
  phone      TEXT,
  signature  TEXT NOT NULL
);
ALTER TABLE workshop_attendance ADD COLUMN IF NOT EXISTS national_id TEXT;
ALTER TABLE workshop_attendance ALTER COLUMN job DROP NOT NULL;
CREATE INDEX IF NOT EXISTS workshop_attendance_workshop ON workshop_attendance (workshop, created_at);`;

const WORKSHOPS = {
  polynomials: {
    items: ["goals", "warmup", "time", "accuracy", "sequence", "errors", "task", "knowledge", "minute", "interactive", "platforms", "engagement", "assessment", "closure", "values", "climate"],
    moments: ["task", "interactive", "knowledge", "game", "examples", "whatif", "closure", "values"],
    apply: ["task", "knowledge", "minute", "interactive", "game", "closure", "errors"],
    roles: ["leader", "supervisor", "deputy", "math", "teacher", "other"],
    jobs: ["leader", "supervisor", "deputy", "math", "teacher", "admin", "other"],
  },
};

const text = (v, max) => {
  const s = String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim();
  return s ? s.slice(0, max) : null;
};
const pick = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).filter(x => allowed.includes(x)))];

// One school's attendees often share one network, so the limit is per address but generous.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_POSTS = 80;
const hits = new Map();
const limited = ip => {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_POSTS;
};
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (list.every(t => now - t >= WINDOW_MS)) hits.delete(ip);
}, WINDOW_MS).unref();

function mount(app, pool) {
  app.post("/api/feedback/:workshop", express.json({ limit: "8kb" }), async (req, res) => {
    const w = WORKSHOPS[req.params.workshop];
    if (!w) return res.status(404).json({ error: "not_found" });
    if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
    const b = req.body || {};
    const overall = Number(b.overall);
    if (!Number.isInteger(overall) || overall < 1 || overall > 5) return res.status(400).json({ error: "overall_required" });
    const ratings = {};
    for (const k of w.items) {
      const n = Number(b.ratings?.[k]);
      if (Number.isInteger(n) && n >= 1 && n <= 4) ratings[k] = n;
    }
    const role = w.roles.includes(b.role) ? b.role : null;
    try {
      await pool.query(
        `INSERT INTO workshop_feedback (workshop, role, name, overall, ratings, moments, apply, strengths, suggestions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [req.params.workshop, role, text(b.name, 80), overall, ratings, JSON.stringify(pick(b.moments, w.moments)),
          JSON.stringify(pick(b.apply, w.apply)), text(b.strengths, 1500), text(b.suggestions, 1500)]);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server_error" });
    }
  });

  // The attendance sheet: who came, where from, and a drawn signature (a small PNG kept as a data URL).
  app.post("/api/attendance/:workshop", express.json({ limit: "200kb" }), async (req, res) => {
    const w = WORKSHOPS[req.params.workshop];
    if (!w) return res.status(404).json({ error: "not_found" });
    if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
    const b = req.body || {};
    const digits = v => String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
    const name = text(b.name, 80), workplace = text(b.workplace, 120);
    const job = w.jobs.includes(b.job) ? b.job : null;
    const nationalId = digits(b.nationalId);
    // Kept in the local form 05XXXXXXXX whether typed with +966, 966 or without the leading zero.
    const phone = digits(b.phone).replace(/^(00)?966/, "0").replace(/^5/, "05");
    const sig = String(b.signature ?? "");
    const errors = [];
    if (!name || name.split(/\s+/).length < 2) errors.push("name");
    if (!workplace) errors.push("workplace");
    // Saudi national ID or iqama: ten digits starting with 1 or 2.
    if (!/^[12]\d{9}$/.test(nationalId)) errors.push("nationalId");
    if (!/^05\d{8}$/.test(phone)) errors.push("phone");
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 150000) errors.push("signature");
    if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
    try {
      const { rows } = await pool.query(
        `INSERT INTO workshop_attendance (workshop, name, job, workplace, national_id, phone, signature) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, (SELECT count(*) FROM workshop_attendance WHERE workshop = $1)::int + 1 AS n`,
        [req.params.workshop, name, job, workplace, nationalId, phone, sig]);
      res.json({ ok: true, n: rows[0].n });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server_error" });
    }
  });

  // The QR code attendees scan, pointing at the form on whatever host served this request.
  app.get("/lessons/:workshop/:page(feedback|attendance)/qr.svg", async (req, res) => {
    if (!WORKSHOPS[req.params.workshop]) return res.status(404).end();
    const url = `${req.protocol}://${req.get("host")}/lessons/${req.params.workshop}/${req.params.page}`;
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#0d3f3d", light: "#ffffff" } });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(svg);
  });
}

// Everything the dashboard draws, in one read. Names, national IDs, phones, signatures and comments only ever reach the teacher's panel.
async function results(pool, workshop) {
  if (!WORKSHOPS[workshop]) return null;
  const { rows } = await pool.query(
    `SELECT id, created_at, role, name, overall, ratings, moments, apply, strengths, suggestions
     FROM workshop_feedback WHERE workshop = $1 ORDER BY created_at DESC`, [workshop]);
  const att = await pool.query(
    `SELECT id, created_at, name, job, workplace, national_id, phone, signature FROM workshop_attendance WHERE workshop = $1 ORDER BY created_at`, [workshop]);
  return { workshop, responses: rows, attendance: att.rows };
}

module.exports = { SCHEMA, WORKSHOPS, mount, results };
