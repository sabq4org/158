const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");

const MAX = { test: 20, participation: 10, projects: 10 };
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
const LIMITS = { test1: MAX.test, test2: MAX.test, test_avg: MAX.test, participation: MAX.participation, projects: MAX.projects, lateness: 365 };
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
function cleanStudent(raw) {
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

  function readSession(req) {
    const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return false;
    const [exp, sig] = m[1].split(".");
    if (!exp || !sig) return false;
    const expected = sign(exp);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    return Number(exp) > Date.now();
  }

  function setSession(res, ms) {
    const exp = String(Date.now() + ms);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ms / 1000)}${secure}`);
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

  router.post("/login", (req, res) => {
    if (!PASSWORD) return res.status(503).json({ error: "disabled" });
    const now = Date.now();
    const list = (failures.get(req.ip) || []).filter(t => now - t < LOCK_MS);
    if (list.length >= 5) return res.status(429).json({ error: "locked" });
    const ok = crypto.timingSafeEqual(hash(req.body?.password ?? ""), hash(PASSWORD));
    if (!ok) { list.push(now); failures.set(req.ip, list); return res.status(401).json({ error: "wrong_password", left: 5 - list.length }); }
    failures.delete(req.ip);
    setSession(res, SESSION_HOURS * 3600 * 1000);
    res.json({ ok: true });
  });

  router.post("/logout", (req, res) => { setSession(res, 0); res.json({ ok: true }); });

  router.use((req, res, next) => (readSession(req) ? next() : res.status(401).json({ error: "unauthorized" })));

  router.get("/me", (req, res) => res.json({ ok: true, max: MAX, styles: STYLES }));

  router.get("/students", async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM students ORDER BY class NULLS LAST, name");
    res.json(rows.map(fromRow));
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

  router.get("/export", async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM students ORDER BY class NULLS LAST, name");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("الطالبات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = FIELDS.map(([key, header]) => ({ key, header, width: key === "name" ? 30 : key === "email" ? 28 : key === "national_id" ? 14 : 13 }));
    rows.forEach(r => ws.addRow(fromRow(r)));
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: "FFFFFFFF" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B2765" } };
    head.alignment = { horizontal: "center", vertical: "middle" };
    head.height = 24;
    ws.getColumn("national_id").numFmt = "@";
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="students-${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(`نتائج الطالبات ${stamp}.xlsx`)}`);
    await wb.xlsx.write(res);
    res.end();
  });

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

  return pool.query(ADMIN_SCHEMA);
};
