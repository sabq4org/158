const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const util = require("util");
const ExcelJS = require("exceljs");
const { DEFAULTS, getSettings, saveSettings, maxOf } = require("./settings");
const grades = require("./grades");

const scrypt = util.promisify(crypto.scrypt);

const SESSION_HOURS = 8;
const COOKIE = "admin_session";

const ADMIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT,
  data        JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  action      TEXT NOT NULL,
  national_id TEXT,
  details     JSONB
);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS classes (
  name        TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// Field order shared by the API, Excel export and the import diff.
const FIELDS = [
  ["national_id", "رقم الهوية"],
  ["name", "اسم الطالبة"],
  ["class", "الفصل"],
  ["test1", "الاختبار الأول"],
  ["test2", "الاختبار الثاني"],
  ["test_avg", "المتوسط"],
  ["participation", "المشاركة"],
  ["projects", "المشاريع والمهام"],
  ["lateness", "التأخير"],
  ["learning_style", "نمط التعلم"],
  ["email", "الإيميل الوزاري"],
];
const LABEL = Object.fromEntries(FIELDS);
const NUMERIC = new Set(["test1", "test2", "test_avg", "participation", "projects", "lateness"]);
const GRADE_COLS = ["test1", "test2", "test_avg", "participation", "projects", "lateness"];
const TERM_COLS = ["national_id", "name", "class", ...GRADE_COLS, "learning_style"];
const limitsFor = max => ({ test1: max.test, test2: max.test, test_avg: max.test, participation: max.participation, projects: max.projects, lateness: 365 });
const STYLES = ["بصري", "سمعي", "حركي", "كتابي"];

// Header text in the teacher's sheet (and in our own export) → field.
const HEADER_MAP = {
  "الهوية": "national_id", "رقم الهوية": "national_id",
  "اسم الطالبة": "name", "الاسم": "name",
  "الصف": "class", "الفصل": "class",
  "درجة خ 1": "test1", "الاختبار الأول": "test1",
  "درجة خ 2": "test2", "الاختبار الثاني": "test2",
  "المتوسط": "test_avg", "معدل الاختبار": "test_avg",
  "المشاركة": "participation",
  "المهام الأدائية والمشاريع": "projects", "المشاريع والمهام": "projects",
  "التأخر": "lateness", "التأخير": "lateness",
  "نمط التعلم": "learning_style",
  "الايميل الوزاري": "email", "الإيميل الوزاري": "email",
};

const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();

function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map(t => t.text).join("");
    if ("result" in v) return cellText(v.result);
    if (v.text != null) return String(v.text);
    if (v instanceof Date) return v.toISOString();
    return "";
  }
  return String(v);
}

// Turns raw input into a clean student record, collecting problems instead of throwing.
function cleanStudent(raw, max = maxOf(getSettings())) {
  const LIMITS = limitsFor(max);
  const errors = [];
  const s = {};
  s.national_id = String(raw.national_id ?? "").replace(/\D/g, "");
  if (s.national_id.length < 9 || s.national_id.length > 10) errors.push("رقم الهوية يجب أن يكون 10 أرقام");
  s.name = norm(raw.name);
  if (!s.name) errors.push("الاسم مطلوب");
  s.class = norm(raw.class) || null;
  for (const f of NUMERIC) {
    const t = norm(raw[f]);
    if (t === "") { s[f] = null; continue; }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > LIMITS[f]) { errors.push(`${LABEL[f]}: القيمة ${t} خارج المدى 0 إلى ${LIMITS[f]}`); s[f] = null; }
    else s[f] = Math.round(n * 100) / 100;
  }
  if (s.test1 != null && s.test2 != null) s.test_avg = Math.round(((s.test1 + s.test2) / 2) * 100) / 100;
  s.learning_style = norm(raw.learning_style) || null;
  if (s.learning_style && !STYLES.includes(s.learning_style)) errors.push(`نمط التعلم "${s.learning_style}" غير معروف`);
  s.email = norm(raw.email) || null;
  return { student: s, errors };
}

// Compare values the way the teacher sees them: 15 and "15" are the same, empty is null.
const canon = v => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return String(v);
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t;
};
const same = (a, b) => canon(a) === canon(b);

function fromRow(r) {
  const o = {};
  for (const [f] of FIELDS) o[f] = NUMERIC.has(f) ? (r[f] == null ? null : Number(r[f])) : r[f];
  return o;
}

async function readStudentsFromExcel(file) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: "cache", styles: "ignore", hyperlinks: "ignore", worksheets: "emit" });
  for await (const sheet of reader) {
    let cols = null, emptyRun = 0;
    const rows = [];
    for await (const row of sheet) {
      const values = row.values || [];
      if (!cols) {
        const found = {};
        values.forEach((v, i) => { const f = HEADER_MAP[norm(cellText(v))]; if (f && !(f in found)) found[f] = i; });
        if ("national_id" in found && "name" in found && Object.keys(found).length >= 4) cols = found;
        if (row.number > 500 && !cols) break;
        continue;
      }
      const raw = {};
      for (const [f, i] of Object.entries(cols)) raw[f] = cellText(values[i]);
      if (!norm(raw.national_id) && !norm(raw.name)) {
        // The teacher's sheet keeps a second copy far below the main table; stop at the first gap.
        if (rows.length && ++emptyRun >= 5) break;
        continue;
      }
      emptyRun = 0;
      rows.push({ line: row.number, raw });
    }
    if (cols) return rows;
  }
  return null;
}

module.exports = function mountAdmin(app, pool) {
  const PASSWORD = process.env.ADMIN_PASSWORD || "";
  const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  if (!PASSWORD) console.warn("ADMIN_PASSWORD is not set; the admin panel is disabled");

  const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
  const hash = v => crypto.createHash("sha256").update(String(v)).digest();

  // The principal's read-only password, set by the teacher. Kept apart from the site settings so it is never sent out.
  let viewer = { ver: 0 };
  const loadViewer = async () => {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'viewer'");
    viewer = { ver: 0, ...(rows[0]?.value || {}) };
  };
  const saveViewer = async next => {
    await pool.query("INSERT INTO settings (key, value) VALUES ('viewer', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(next)]);
    viewer = next;
  };
  const isViewerPassword = async pw => {
    if (!viewer.hash || !pw) return false;
    return crypto.timingSafeEqual(await scrypt(pw, viewer.salt, 32), Buffer.from(viewer.hash, "hex"));
  };

  // Cookie: role.expiry.version.signature. A new principal password bumps the version and ends her old sessions.
  function readSession(req) {
    const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return null;
    const parts = m[1].split(".");
    if (parts.length !== 4) return null;
    const [role, exp, ver, sig] = parts;
    const expected = sign(`${role}.${exp}.${ver}`);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (!(Number(exp) > Date.now())) return null;
    if (role === "admin") return "admin";
    if (role === "viewer" && viewer.hash && Number(ver) === viewer.ver) return "viewer";
    return null;
  }

  function setSession(res, ms, role = "admin") {
    const payload = `${role}.${Date.now() + ms}.${role === "viewer" ? viewer.ver : 0}`;
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ms / 1000)}${secure}`);
  }

  // 5 wrong passwords lock that device out for 15 minutes.
  const failures = new Map();
  const LOCK_MS = 15 * 60 * 1000;

  const router = express.Router();
  router.use(express.json({ limit: "100kb" }));
  // Express 4 does not catch rejected promises; send them to the error handler.
  for (const m of ["get", "post", "put", "delete"]) {
    const orig = router[m].bind(router);
    router[m] = (route, ...fns) => orig(route, ...fns.map(fn => (req, res, next) => {
      try { const r = fn(req, res, next); if (r && typeof r.catch === "function") r.catch(next); } catch (err) { next(err); }
    }));
  }

  router.post("/login", async (req, res) => {
    if (!PASSWORD) return res.status(503).json({ error: "disabled" });
    const now = Date.now();
    const list = (failures.get(req.ip) || []).filter(t => now - t < LOCK_MS);
    if (list.length >= 5) return res.status(429).json({ error: "locked" });
    const pw = String(req.body?.password ?? "");
    const role = crypto.timingSafeEqual(hash(pw), hash(PASSWORD)) ? "admin" : (await isViewerPassword(pw)) ? "viewer" : null;
    if (!role) { list.push(now); failures.set(req.ip, list); return res.status(401).json({ error: "wrong_password", left: 5 - list.length }); }
    failures.delete(req.ip);
    setSession(res, SESSION_HOURS * 3600 * 1000, role);
    res.json({ ok: true, role });
  });

  router.post("/logout", (req, res) => { setSession(res, 0); res.json({ ok: true }); });

  router.use((req, res, next) => {
    req.role = readSession(req);
    if (!req.role) return res.status(401).json({ error: "unauthorized" });
    // The principal's account sees everything and changes nothing.
    if (req.role !== "admin" && req.method !== "GET") return res.status(403).json({ error: "read_only", errors: ["هذا الحساب للعرض فقط"] });
    next();
  });

  router.get("/me", (req, res) => res.json({ ok: true, role: req.role, max: maxOf(getSettings()), styles: STYLES, settings: getSettings() }));

  router.get("/viewer", (req, res) => res.json({ enabled: !!viewer.hash }));

  router.put("/viewer", async (req, res) => {
    const pw = String(req.body?.password ?? "");
    if (pw.length < 6) return res.status(400).json({ error: "invalid", errors: ["كلمة المرور لازم تكون 6 أحرف أو أكثر"] });
    if (pw === PASSWORD) return res.status(400).json({ error: "invalid", errors: ["اختاري كلمة مرور غير كلمة مرور المعلمة"] });
    const salt = crypto.randomBytes(16).toString("hex");
    await saveViewer({ salt, hash: (await scrypt(pw, salt, 32)).toString("hex"), ver: viewer.ver + 1 });
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('viewer_set', '{}')");
    res.json({ enabled: true });
  });

  router.delete("/viewer", async (req, res) => {
    await saveViewer({ ver: viewer.ver + 1 });
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('viewer_off', '{}')");
    res.json({ enabled: false });
  });

  router.get("/settings", (req, res) => res.json(getSettings()));

  router.put("/settings", async (req, res) => {
    const b = req.body || {}, errors = [];
    const next = {};
    for (const k of ["grade_label", "term_title", "teacher_name", "principal_name", "closed_message"]) {
      next[k] = norm(b[k] ?? DEFAULTS[k]).slice(0, 200);
    }
    if (!next.teacher_name) errors.push("اسم المعلمة مطلوب");
    if (!next.closed_message) next.closed_message = DEFAULTS.closed_message;
    for (const k of ["max_test", "max_participation", "max_projects"]) {
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n <= 0 || n > 1000) errors.push(`الدرجة العظمى غير صحيحة: ${b[k]}`);
      next[k] = n;
    }
    next.lookup_open = b.lookup_open !== false;
    if (errors.length) return res.status(400).json({ error: "invalid", errors });

    // A lower maximum must not leave saved scores above it.
    const checks = [["test1", next.max_test], ["test2", next.max_test], ["participation", next.max_participation], ["projects", next.max_projects]];
    for (const [f, m] of checks) {
      const { rows } = await pool.query(`SELECT name FROM students WHERE ${f} > $1 ORDER BY name LIMIT 3`, [m]);
      if (rows.length) errors.push(`${LABEL[f]}: فيه طالبات درجاتهن أعلى من ${m} (${rows.map(r => r.name).join("، ")})`);
    }
    if (errors.length) return res.status(409).json({ error: "scores_above_max", errors });

    const before = getSettings();
    const changes = Object.keys(next).filter(k => before[k] !== next[k]).map(k => ({ field: k, from: before[k], to: next[k] }));
    await saveSettings(pool, next);
    if (changes.length) await pool.query("INSERT INTO audit_log (action, details) VALUES ('settings', $1)", [JSON.stringify(changes)]);
    res.json(getSettings());
  });

  router.get("/audit", async (req, res) => {
    const { rows } = await pool.query(`SELECT a.id, a.created_at, a.action, a.national_id, a.details, a.undone_at, s.name AS current_name
      FROM audit_log a LEFT JOIN students s ON s.national_id = a.national_id ORDER BY a.id DESC LIMIT 300`);
    res.json(rows);
  });

  // Undo one student change. Fields edited again since then are left alone and reported back.
  router.post("/audit/:id/undo", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM audit_log WHERE id = $1 FOR UPDATE", [req.params.id]);
      const e = rows[0];
      if (!e) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (e.undone_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_undone", errors: ["تم التراجع عن هذا التعديل من قبل"] }); }
      const cols = FIELDS.map(f => f[0]);
      const cur = (await client.query("SELECT * FROM students WHERE national_id = $1", [e.national_id])).rows[0];
      let skipped = [], title = null;
      if (e.action === "edit") {
        if (!cur) { await client.query("ROLLBACK"); return res.status(409).json({ error: "gone", errors: ["الطالبة محذوفة، ما يمكن التراجع عن تعديلها"] }); }
        const now = fromRow(cur);
        const revert = [];
        for (const c of e.details || []) {
          if (c.field === "national_id" || c.field === "test_avg") continue;
          if (same(now[c.field], c.to)) revert.push(c); else skipped.push(LABEL[c.field]);
        }
        const next = { ...now };
        for (const c of revert) next[c.field] = c.from;
        next.test_avg = next.test1 != null && next.test2 != null ? Math.round(((Number(next.test1) + Number(next.test2)) / 2) * 100) / 100 : next.test_avg;
        await client.query(`UPDATE students SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE national_id = $${cols.length + 1}`, [...cols.map(c => next[c]), e.national_id]);
      } else if (e.action === "add") {
        if (cur) await client.query("DELETE FROM students WHERE national_id = $1", [e.national_id]);
      } else if (e.action === "delete") {
        if (cur) { await client.query("ROLLBACK"); return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية حالياً"] }); }
        await client.query(`INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, cols.map(c => e.details?.[c] ?? null));
        if (e.details?.class) await client.query("INSERT INTO classes (name) VALUES ($1) ON CONFLICT DO NOTHING", [e.details.class]);
      } else if (e.action === "term_delete") {
        const d = e.details || {};
        if ((await client.query("SELECT 1 FROM terms WHERE title = $1", [d.title])).rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "exists", errors: ["توجد فترة بنفس العنوان حالياً"] });
        }
        const t = await client.query("INSERT INTO terms (title, max, created_at) VALUES ($1, $2, $3) RETURNING id", [d.title, JSON.stringify(d.max), d.created_at]);
        await insertTermResults(client, t.rows[0].id, d.results || []);
      } else if (e.action === "term_archive" && e.details?.term_id) {
        const d = e.details;
        await client.query("DELETE FROM terms WHERE id = $1", [d.term_id]);
        if (d.grades?.length) {
          const graded = `coalesce(${GRADE_COLS.map(c => "s." + c).join(", ")}) IS NOT NULL`;
          const g = `jsonb_to_recordset($1) AS g(national_id TEXT, ${GRADE_COLS.map(c => c + " NUMERIC").join(", ")})`;
          const list = JSON.stringify(d.grades);
          skipped = (await client.query(`SELECT s.name FROM students s JOIN ${g} ON g.national_id = s.national_id WHERE ${graded} ORDER BY s.name`, [list])).rows.map(r => r.name);
          await client.query(`UPDATE students s SET ${GRADE_COLS.map(c => `${c} = g.${c}`).join(", ")} FROM ${g} WHERE g.national_id = s.national_id AND NOT (${graded})`, [list]);
        }
        if (d.cleared && getSettings().term_title === (d.next_title || "")) title = d.prev_title ?? "";
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "not_undoable", errors: ["هذا النوع يُسترجع من النسخ الاحتياطية"] });
      }
      await client.query("UPDATE audit_log SET undone_at = now() WHERE id = $1", [e.id]);
      await client.query("INSERT INTO audit_log (action, national_id, details) VALUES ('undo', $1, $2)", [e.national_id, JSON.stringify({ of: e.id, action: e.action, skipped })]);
      await client.query("COMMIT");
      if (title != null) await saveSettings(pool, { ...getSettings(), term_title: title });
      res.json({ ok: true, skipped, settings: getSettings() });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // Lookups count from the start of the current period: the last archive that cleared the grades.
  const SINCE = `created_at > coalesce((SELECT max(created_at) FROM audit_log
    WHERE action = 'term_archive' AND undone_at IS NULL AND (details->>'cleared')::boolean), '-infinity')`;

  router.get("/students", async (req, res) => {
    const { rows } = await pool.query(`SELECT s.*, l.last_lookup, l.lookup_count FROM students s
      LEFT JOIN (SELECT national_id, max(created_at) AS last_lookup, count(*)::int AS lookup_count FROM lookups WHERE ${SINCE} GROUP BY national_id) l
      ON l.national_id = s.national_id ORDER BY s.class NULLS LAST, s.name`);
    res.json(rows.map(r => ({ ...fromRow(r), last_lookup: r.last_lookup, lookup_count: r.lookup_count || 0 })));
  });

  router.get("/lookups", async (req, res) => {
    const { rows } = await pool.query(`SELECT l.id, l.national_id, l.kind, l.device, l.created_at, s.name, s.class
      FROM lookups l LEFT JOIN students s ON s.national_id = l.national_id WHERE l.${SINCE} ORDER BY l.id DESC LIMIT 100`);
    const totals = (await pool.query(`SELECT kind, count(*)::int AS n FROM lookups WHERE ${SINCE} GROUP BY kind`)).rows;
    res.json({ recent: rows, totals: Object.fromEntries(totals.map(t => [t.kind, t.n])) });
  });

  router.post("/students", async (req, res) => {
    const { student, errors } = cleanStudent(req.body || {});
    if (errors.length) return res.status(400).json({ error: "invalid", errors });
    const cols = FIELDS.map(f => f[0]);
    try {
      await pool.query(`INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, cols.map(c => student[c]));
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية"] });
      throw err;
    }
    await pool.query("INSERT INTO audit_log (action, national_id, details) VALUES ('add', $1, $2)", [student.national_id, student]);
    res.json(student);
  });

  router.put("/students/:id", async (req, res) => {
    const { student, errors } = cleanStudent({ ...req.body, national_id: req.body?.national_id ?? req.params.id });
    if (errors.length) return res.status(400).json({ error: "invalid", errors });
    const { rows } = await pool.query("SELECT * FROM students WHERE national_id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    const cols = FIELDS.map(f => f[0]);
    try {
      await pool.query(`UPDATE students SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE national_id = $${cols.length + 1}`, [...cols.map(c => student[c]), req.params.id]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية"] });
      throw err;
    }
    const before = fromRow(rows[0]);
    const changes = cols.filter(c => !same(before[c], student[c])).map(c => ({ field: c, from: before[c], to: student[c] }));
    await pool.query("INSERT INTO audit_log (action, national_id, details) VALUES ('edit', $1, $2)", [req.params.id, JSON.stringify(changes)]);
    res.json(student);
  });

  router.delete("/students/:id", async (req, res) => {
    const { rows } = await pool.query("DELETE FROM students WHERE national_id = $1 RETURNING *", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    await pool.query("INSERT INTO audit_log (action, national_id, details) VALUES ('delete', $1, $2)", [req.params.id, fromRow(rows[0])]);
    res.json({ ok: true });
  });

  async function sendExcel(res, rows, fields, fileName) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("الطالبات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = fields.map(([key, header]) => ({ key, header, width: key === "name" ? 30 : key === "email" ? 28 : key === "national_id" ? 14 : 13 }));
    rows.forEach(r => ws.addRow(fromRow(r)));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B2765" } };
    head.alignment = { horizontal: "center", vertical: "middle" };
    head.height = 24;
    ws.getColumn("national_id").numFmt = "@";
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="students-${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${fileName} ${stamp}.xlsx`)}`);
    await wb.xlsx.write(res);
    res.end();
  }

  router.get("/export", async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM students ORDER BY class NULLS LAST, name");
    await sendExcel(res, rows, FIELDS, "نتائج الطالبات");
  });

  // ---------- Terms: each archived period keeps its own copy of the results ----------
  const insertTermResults = (q, termId, list) => q.query(
    `INSERT INTO term_results (term_id, ${TERM_COLS.join(", ")})
     SELECT $1, ${TERM_COLS.join(", ")} FROM jsonb_to_recordset($2) AS x(national_id TEXT, name TEXT, class TEXT,
       test1 NUMERIC, test2 NUMERIC, test_avg NUMERIC, participation NUMERIC, projects NUMERIC, lateness NUMERIC, learning_style TEXT)`,
    [termId, JSON.stringify(list)]);
  const termId = req => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);
  const titleTaken = (title, except = 0) => pool.query("SELECT 1 FROM terms WHERE title = $1 AND id <> $2", [title, except]).then(r => r.rowCount > 0);

  router.get("/terms", async (req, res) => {
    const terms = (await pool.query("SELECT id, title, max, created_at FROM terms ORDER BY created_at, id")).rows;
    const results = (await pool.query("SELECT term_id, test1, test2, test_avg, participation, projects FROM term_results")).rows;
    res.json(terms.map(t => {
      const mine = results.filter(r => r.term_id === t.id);
      const pcts = mine.map(r => grades.Report.scores(r, t.max).pct).filter(p => p != null);
      return { ...t, count: mine.length, avg: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null };
    }));
  });

  // Archive the current grades under a title. Optionally empty them for the next period (a backup is kept first).
  router.post("/terms", async (req, res) => {
    const title = norm(req.body?.title).slice(0, 80);
    const clear = req.body?.clear === true;
    const nextTitle = norm(req.body?.next_title).slice(0, 80);
    if (!title) return res.status(400).json({ error: "invalid", errors: ["اكتبي عنوان الفترة"] });
    if (await titleTaken(title)) return res.status(409).json({ error: "exists", errors: ["توجد فترة مؤرشفة بنفس العنوان"] });
    const client = await pool.connect();
    const prevTitle = getSettings().term_title;
    let count;
    try {
      await client.query("BEGIN");
      const t = await client.query("INSERT INTO terms (title, max) VALUES ($1, $2) RETURNING id", [title, JSON.stringify(maxOf(getSettings()))]);
      count = (await client.query(
        `INSERT INTO term_results (term_id, ${TERM_COLS.join(", ")}) SELECT $1, ${TERM_COLS.join(", ")} FROM students
         WHERE coalesce(test1, test2, test_avg, participation, projects) IS NOT NULL`, [t.rows[0].id])).rowCount;
      if (!count) { await client.query("ROLLBACK"); return res.status(400).json({ error: "empty", errors: ["ما فيه درجات مرصودة للأرشفة"] }); }
      // The log keeps the term id and the cleared grades, so the archive can be undone from there.
      const details = { title, count, cleared: clear, next_title: clear ? nextTitle : null, term_id: t.rows[0].id, prev_title: prevTitle };
      if (clear) {
        const { rows } = await client.query("SELECT * FROM students ORDER BY national_id");
        await client.query("INSERT INTO backups (note, data) VALUES ($1, $2)", ["قبل أرشفة الفترة ومسح الدرجات", JSON.stringify(rows.map(fromRow))]);
        details.grades = rows.filter(r => GRADE_COLS.some(c => r[c] != null))
          .map(r => Object.fromEntries(["national_id", ...GRADE_COLS].map(c => [c, r[c]])));
        await client.query(`UPDATE students SET ${GRADE_COLS.map(c => `${c} = NULL`).join(", ")}`);
      }
      await client.query("INSERT INTO audit_log (action, details) VALUES ('term_archive', $1)", [JSON.stringify(details)]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // A fresh period starts with its own title on the lookup page (empty until the teacher names it).
    if (clear) await saveSettings(pool, { ...getSettings(), term_title: nextTitle });
    res.json({ ok: true, count, settings: getSettings() });
  });

  router.put("/terms/:id", async (req, res) => {
    const id = termId(req), title = norm(req.body?.title).slice(0, 80);
    if (!title) return res.status(400).json({ error: "invalid", errors: ["اكتبي عنوان الفترة"] });
    if (await titleTaken(title, id || 0)) return res.status(409).json({ error: "exists", errors: ["توجد فترة مؤرشفة بنفس العنوان"] });
    const old = (await pool.query("SELECT title FROM terms WHERE id = $1", [id])).rows[0];
    if (!old) return res.status(404).json({ error: "not_found" });
    await pool.query("UPDATE terms SET title = $1 WHERE id = $2", [title, id]);
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('term_rename', $1)", [JSON.stringify({ from: old.title, to: title })]);
    res.json({ ok: true });
  });

  // The deleted results stay in the log, so the deletion can be undone from there.
  router.delete("/terms/:id", async (req, res) => {
    const id = termId(req);
    const t = (await pool.query("SELECT title, max, created_at FROM terms WHERE id = $1", [id])).rows[0];
    if (!t) return res.status(404).json({ error: "not_found" });
    const results = (await pool.query(`SELECT ${TERM_COLS.join(", ")} FROM term_results WHERE term_id = $1 ORDER BY national_id`, [id])).rows;
    await pool.query("DELETE FROM terms WHERE id = $1", [id]);
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('term_delete', $1)", [JSON.stringify({ ...t, count: results.length, results })]);
    res.json({ ok: true });
  });

  router.get("/terms/:id/export", async (req, res) => {
    const id = termId(req);
    const t = (await pool.query("SELECT title FROM terms WHERE id = $1", [id])).rows[0];
    if (!t) return res.status(404).json({ error: "not_found" });
    const { rows } = await pool.query("SELECT * FROM term_results WHERE term_id = $1 ORDER BY class NULLS LAST, name", [id]);
    await sendExcel(res, rows, FIELDS.filter(([k]) => k !== "email"), `نتائج ${t.title}`);
  });

  router.get("/history", async (req, res) => res.json(await grades.history(pool)));

  // Uploads are previewed first; the parsed result waits here until the teacher approves it.
  const previews = new Map();
  const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });

  router.post("/import", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    let parsed;
    try {
      parsed = await readStudentsFromExcel(req.file.path);
    } catch (err) {
      console.error(err);
      return res.status(400).json({ error: "unreadable" });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
    if (!parsed) return res.status(400).json({ error: "no_table" });

    const { rows } = await pool.query("SELECT * FROM students");
    const current = new Map(rows.map(r => [r.national_id, fromRow(r)]));
    const seen = new Set();
    const added = [], changed = [], errors = [], unchanged = [];
    for (const { line, raw } of parsed) {
      const { student, errors: errs } = cleanStudent(raw);
      if (seen.has(student.national_id)) errs.push("رقم الهوية مكرر في الملف");
      if (errs.length) { errors.push({ line, name: student.name || norm(raw.name), id: student.national_id, problems: errs }); continue; }
      seen.add(student.national_id);
      const before = current.get(student.national_id);
      if (!before) { added.push(student); continue; }
      // An empty cell in the file never erases a value already saved (e.g. a style set from the panel).
      for (const [f] of FIELDS) if (student[f] == null && before[f] != null) student[f] = before[f];
      const changes = FIELDS.map(f => f[0]).filter(c => !same(before[c], student[c])).map(c => ({ field: c, label: LABEL[c], from: before[c], to: student[c] }));
      if (changes.length) changed.push({ student, changes }); else unchanged.push(student.national_id);
    }
    const missing = [...current.values()].filter(s => !seen.has(s.national_id)).map(s => ({ national_id: s.national_id, name: s.name }));

    const token = crypto.randomBytes(16).toString("hex");
    previews.set(token, { at: Date.now(), name: req.file.originalname, upserts: [...added, ...changed.map(c => c.student)] });
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60 * 1000) previews.delete(k);
    res.json({ token, fileName: Buffer.from(req.file.originalname, "latin1").toString("utf8"), totalRows: parsed.length, added, changed, unchanged: unchanged.length, errors, missing });
  });

  router.post("/import/:token/apply", async (req, res) => {
    const p = previews.get(req.params.token);
    if (!p) return res.status(410).json({ error: "expired" });
    previews.delete(req.params.token);
    const cols = FIELDS.map(f => f[0]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM students ORDER BY national_id");
      await client.query("INSERT INTO backups (note, data) VALUES ($1, $2)", ["قبل رفع ملف إكسل", JSON.stringify(rows.map(fromRow))]);
      for (const s of p.upserts) {
        await client.query(
          `INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})
           ON CONFLICT (national_id) DO UPDATE SET ${cols.slice(1).map(c => `${c} = EXCLUDED.${c}`).join(", ")}`,
          cols.map(c => s[c]));
      }
      await client.query("INSERT INTO audit_log (action, details) VALUES ('import', $1)", [JSON.stringify({ count: p.upserts.length })]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, count: p.upserts.length });
  });

  // Classes can exist before any student is put in them; any class a student already has is listed too.
  const syncClasses = q => q.query("INSERT INTO classes (name) SELECT DISTINCT class FROM students WHERE class IS NOT NULL ON CONFLICT DO NOTHING");

  router.get("/classes", async (req, res) => {
    await syncClasses(pool);
    const { rows } = await pool.query(`SELECT c.name, count(s.national_id)::int AS count FROM classes c
      LEFT JOIN students s ON s.class = c.name GROUP BY c.name ORDER BY c.name`);
    res.json(rows);
  });

  router.post("/classes", async (req, res) => {
    const name = norm(req.body?.name);
    if (!name || name.length > 40) return res.status(400).json({ error: "invalid", errors: ["اكتبي اسم الفصل"] });
    const { rowCount } = await pool.query("INSERT INTO classes (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
    if (!rowCount) return res.status(409).json({ error: "exists", errors: ["الفصل موجود"] });
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('class_add', $1)", [JSON.stringify({ name })]);
    res.json({ name, count: 0 });
  });

  // Renaming onto an existing class merges the two.
  router.put("/classes/:name", async (req, res) => {
    const to = norm(req.body?.name), from = req.params.name;
    if (!to || to.length > 40) return res.status(400).json({ error: "invalid", errors: ["اكتبي اسم الفصل"] });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await syncClasses(client);
      const { rowCount } = await client.query("DELETE FROM classes WHERE name = $1", [from]);
      if (!rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      await client.query("INSERT INTO classes (name) VALUES ($1) ON CONFLICT DO NOTHING", [to]);
      const moved = await client.query("UPDATE students SET class = $1 WHERE class = $2", [to, from]);
      await client.query("INSERT INTO audit_log (action, details) VALUES ('class_rename', $1)", [JSON.stringify({ from, to, students: moved.rowCount })]);
      await client.query("COMMIT");
      res.json({ ok: true, moved: moved.rowCount });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  router.delete("/classes/:name", async (req, res) => {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM students WHERE class = $1", [req.params.name]);
    if (rows[0].n) return res.status(409).json({ error: "not_empty", errors: ["انقلي طالبات الفصل أولاً"] });
    await pool.query("DELETE FROM classes WHERE name = $1", [req.params.name]);
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('class_delete', $1)", [JSON.stringify({ name: req.params.name })]);
    res.json({ ok: true });
  });

  router.get("/backups", async (req, res) => {
    const { rows } = await pool.query("SELECT id, created_at, note, jsonb_array_length(data) AS count FROM backups ORDER BY id DESC LIMIT 30");
    res.json(rows);
  });

  router.post("/backups/:id/restore", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const b = await client.query("SELECT data, created_at FROM backups WHERE id = $1", [req.params.id]);
      if (!b.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      const { rows } = await client.query("SELECT * FROM students ORDER BY national_id");
      await client.query("INSERT INTO backups (note, data) VALUES ($1, $2)", ["قبل استرجاع نسخة احتياطية", JSON.stringify(rows.map(fromRow))]);
      await client.query("DELETE FROM students");
      const cols = FIELDS.map(f => f[0]);
      for (const s of b.rows[0].data) {
        await client.query(`INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, cols.map(c => s[c] ?? null));
      }
      await client.query("INSERT INTO audit_log (action, details) VALUES ('restore', $1)", [JSON.stringify({ backup: Number(req.params.id) })]);
      await client.query("COMMIT");
      res.json({ ok: true, count: b.rows[0].data.length });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "too_large" : "upload_failed" });
    console.error(err);
    res.status(500).json({ error: "server_error" });
  });

  app.use("/api/admin", router);
  app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

  return pool.query(ADMIN_SCHEMA).then(loadViewer);
};
