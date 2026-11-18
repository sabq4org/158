// The school's operational plan (الخطة التشغيلية): a portal of tabs at /plan, each a list the planning team adds to,
// edits and deletes from, plus a few one-off fields (the school card, a committee's tasks, the recommendations).
// Signed-in principal, the platform admin and the head of the planning committee edit it; no other teacher sees it.
const express = require("express");
const QRCode = require("qrcode");
// The first draft (staff names and the school's entries) is private and kept out of the public repo: it is loaded once
// from plan-seed.js when that file is present; otherwise the plan starts as it is in the database.
let SEED = null;
try { SEED = require("./plan-seed"); } catch { SEED = null; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plan_items (
  id          SERIAL PRIMARY KEY,
  section     TEXT NOT NULL,
  data        JSONB NOT NULL,
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_items_section ON plan_items (section, sort, id);
-- One row per tab for its single fields; the row '_seeded' marks that the first draft was loaded once.
CREATE TABLE IF NOT EXISTS plan_meta (
  section     TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Evidence photos of a program or a report, already shrunk in the browser.
CREATE TABLE IF NOT EXISTS plan_files (
  id          SERIAL PRIMARY KEY,
  item_id     INT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_files_item ON plan_files (item_id, id);`;

const SECTION = /^[a-z_]{2,40}$/;
const MAX_FILES = 6;
const MAX_FILE = 1.5 * 1024 * 1024;
const MIMES = ["image/jpeg", "image/png", "image/webp"];
// A row id from the URL, or 0 (no such row) for anything that is not a plain positive integer.
const idOf = v => (/^\d{1,9}$/.test(String(v)) ? Number(v) : 0);

// A record is a flat object of short texts and numbers; anything else is dropped.
function clean(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.trim().slice(0, 5000);
    else if (typeof v === "boolean") out[k] = v;
  }
  return JSON.stringify(out).length > 40000 ? null : out;
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function seed(pool) {
  if (!SEED) return;
  const { rowCount } = await pool.query("SELECT 1 FROM plan_meta WHERE section = '_seeded'");
  if (rowCount) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [section, data] of Object.entries(SEED.meta))
      await client.query("INSERT INTO plan_meta (section, data) VALUES ($1, $2) ON CONFLICT (section) DO NOTHING", [section, JSON.stringify(data)]);
    for (const [section, rows] of Object.entries(SEED.items)) {
      let sort = 0;
      for (const data of rows) await client.query("INSERT INTO plan_items (section, data, sort) VALUES ($1, $2, $3)", [section, JSON.stringify(data), sort++]);
    }
    // Follow-up rows start one per program and semester it runs in, with nothing marked yet.
    const { rows: programs } = await client.query("SELECT id, data FROM plan_items WHERE section = 'programs' ORDER BY sort, id");
    let sort = 0;
    for (const p of programs) {
      const sems = p.data.semester === "الفصلان" ? ["الأول", "الثاني"] : [p.data.semester || "الأول"];
      for (const s of sems)
        await client.query("INSERT INTO plan_items (section, data, sort) VALUES ('followup', $1, $2)", [JSON.stringify({ program: String(p.id), semester: s, status: "" }), sort++]);
    }
    await client.query("INSERT INTO plan_meta (section, data) VALUES ('_seeded', $1)", [JSON.stringify({ at: new Date().toISOString() })]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// `canSee(req)` says whether this signed-in account may open the plan.
function mount(router, pool, { canSee }) {
  const only = (req, res, next) => (canSee(req) ? next() : res.status(403).json({ error: "forbidden", errors: ["الخطة التشغيلية لإدارة المدرسة ولجنة التخطيط"] }));
  const ready = seed(pool).catch(err => console.error("plan seed failed", err));

  router.get("/plan", only, async (req, res) => {
    await ready;
    const [meta, items, files] = await Promise.all([
      pool.query("SELECT section, data FROM plan_meta WHERE section NOT LIKE '\\_%'"),
      pool.query("SELECT id, section, data, sort FROM plan_items ORDER BY section, sort, id"),
      pool.query("SELECT id, item_id FROM plan_files ORDER BY item_id, id"),
    ]);
    res.set("Cache-Control", "no-store").json({
      role: req.role,
      meta: Object.fromEntries(meta.rows.map(r => [r.section, r.data])),
      items: items.rows,
      files: files.rows,
    });
  });

  router.put("/plan/meta/:section", only, async (req, res) => {
    const section = req.params.section, data = clean(req.body?.data);
    if (!SECTION.test(section) || !data) return res.status(400).json({ error: "invalid" });
    await pool.query(`INSERT INTO plan_meta (section, data) VALUES ($1, $2)
      ON CONFLICT (section) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [section, JSON.stringify(data)]);
    res.json({ ok: true, data });
  });

  router.post("/plan/items", only, async (req, res) => {
    const section = String(req.body?.section || ""), data = clean(req.body?.data);
    if (!SECTION.test(section) || !data) return res.status(400).json({ error: "invalid" });
    const { rows } = await pool.query(`INSERT INTO plan_items (section, data, sort)
      VALUES ($1, $2, (SELECT coalesce(max(sort), -1) + 1 FROM plan_items WHERE section = $1)) RETURNING id, section, data, sort`, [section, JSON.stringify(data)]);
    res.json(rows[0]);
  });

  router.put("/plan/items/:id", only, async (req, res) => {
    const data = clean(req.body?.data);
    if (!data) return res.status(400).json({ error: "invalid" });
    const { rows } = await pool.query("UPDATE plan_items SET data = $2, updated_at = now() WHERE id = $1 RETURNING id, section, data, sort", [idOf(req.params.id), JSON.stringify(data)]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  });

  // Deleting a program also deletes the follow-up, accountability and report rows that point at it.
  router.delete("/plan/items/:id", only, async (req, res) => {
    const id = idOf(req.params.id);
    const out = await tx(pool, async q => {
      const { rows } = await q.query("DELETE FROM plan_items WHERE id = $1 RETURNING section", [id]);
      if (!rows.length) return null;
      if (rows[0].section !== "programs") return [];
      return (await q.query("DELETE FROM plan_items WHERE data->>'program' = $1 RETURNING id", [String(id)])).rows.map(r => r.id);
    });
    if (!out) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, linked: out });
  });

  // Moves an item one place up or down within its tab.
  router.post("/plan/items/:id/move", only, async (req, res) => {
    const id = idOf(req.params.id), dir = req.body?.dir === "up" ? -1 : 1;
    const order = await tx(pool, async q => {
      const me = (await q.query("SELECT section FROM plan_items WHERE id = $1", [id])).rows[0];
      if (!me) return null;
      const { rows } = await q.query("SELECT id FROM plan_items WHERE section = $1 ORDER BY sort, id FOR UPDATE", [me.section]);
      const ids = rows.map(r => r.id), i = ids.indexOf(id), j = i + dir;
      if (j < 0 || j >= ids.length) return [];
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await q.query("UPDATE plan_items p SET sort = o.k FROM unnest($1::int[]) WITH ORDINALITY AS o(id, k) WHERE p.id = o.id", [ids]);
      return ids;
    });
    if (!order) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, order });
  });

  router.post("/plan/items/:id/files", only, express.raw({ type: MIMES, limit: MAX_FILE }), async (req, res) => {
    const id = idOf(req.params.id), mime = req.get("content-type");
    if (!MIMES.includes(mime) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "invalid" });
    const { rows } = await pool.query("SELECT count(f.id)::int AS n, i.id FROM plan_items i LEFT JOIN plan_files f ON f.item_id = i.id WHERE i.id = $1 GROUP BY i.id", [id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    if (rows[0].n >= MAX_FILES) return res.status(400).json({ error: "too_many", errors: [`الحد ${MAX_FILES} صور لكل عنصر`] });
    const r = await pool.query("INSERT INTO plan_files (item_id, mime, data) VALUES ($1, $2, $3) RETURNING id, item_id", [id, mime, req.body]);
    res.json(r.rows[0]);
  });

  // A QR code (SVG) for an evidence link, so a printed page leads to the program's evidence folder or report.
  router.get("/plan/qr", only, async (req, res) => {
    const u = String(req.query.u || "");
    if (!/^https:\/\/[^\s<>"]{4,1000}$/.test(u)) return res.status(400).end();
    const svg = await QRCode.toString(u, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0d3f3d", light: "#ffffff" } });
    res.set({ "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=86400" }).send(svg);
  });

  router.get("/plan/files/:id", only, async (req, res) => {
    const { rows } = await pool.query("SELECT mime, data FROM plan_files WHERE id = $1", [idOf(req.params.id)]);
    if (!rows.length) return res.status(404).end();
    res.set({ "Content-Type": rows[0].mime, "Cache-Control": "private, max-age=600" }).send(rows[0].data);
  });

  router.delete("/plan/files/:id", only, async (req, res) => {
    const { rowCount } = await pool.query("DELETE FROM plan_files WHERE id = $1", [idOf(req.params.id)]);
    res.json({ ok: rowCount > 0 });
  });
}

module.exports = { SCHEMA, mount };
