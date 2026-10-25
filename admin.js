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
const school = require("./school");

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
);
-- A class is a grade and a section in a school year, with a track from the second grade on. Names it had before
-- ("1" before it became "الثاني الثانوي / 1") stay as aliases, so old sheets and backups still land in it.
ALTER TABLE classes ADD COLUMN IF NOT EXISTS year INT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS grade INT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS section INT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS track TEXT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';`;

// Field order shared by the API, the students table, Excel export and the import diff.
const FIELDS = [
  ["name", "اسم الطالبة"],
  ["national_id", "رقم الهوية"],
  ["email", "الإيميل الوزاري"],
  ["class", "الصف والشعبة"],
  ["test1", "الاختبار الأول"],
  ["test2", "الاختبار الثاني"],
  ["test_avg", "المتوسط"],
  ["participation", "المشاركة"],
  ["projects", "المشاريع والمهام"],
  ["homework", "الواجبات"],
  ["final_exam", "الاختبار النهائي"],
  ["notes", "ملاحظات"],
  ["learning_style", "نمط التعلم"],
  ["learning_difficulty", "صعوبات التعلم"],
];
const LABEL = Object.fromEntries(FIELDS);
const GRADE_COLS = ["test1", "test2", "test_avg", "participation", "projects", "homework", "final_exam"];
const NUMERIC = new Set(GRADE_COLS);
const TERM_COLS = ["national_id", "name", "class", ...GRADE_COLS, "learning_style", "learning_difficulty"];
const TERM_TYPES = { national_id: "TEXT", name: "TEXT", class: "TEXT", learning_style: "TEXT", learning_difficulty: "BOOLEAN" };
// Homework and the final exam have no maximum until the teacher sets one; 100 keeps a typo out meanwhile.
const limitsFor = max => ({ test1: max.test, test2: max.test, test_avg: max.test, participation: max.participation, projects: max.projects,
  homework: max.homework || 100, final_exam: max.final || 100 });
const STYLES = ["بصري", "سمعي", "حركي", "كتابي"];
const NOTES_MAX = 1000;

// Header text in the teacher's sheet (and in our own export) → field. "grade" and "section" are joined into the class.
const HEADER_MAP = {
  "الهوية": "national_id", "رقم الهوية": "national_id", "رقم الهوية الوطنية": "national_id", "الهوية الوطنية": "national_id",
  "السجل المدني": "national_id", "رقم السجل المدني": "national_id", "رقم الهوية / الإقامة": "national_id", "رقم الهوية/الإقامة": "national_id",
  "اسم الطالبة": "name", "الاسم": "name", "اسم الطالب": "name",
  "الفصل": "class", "الصف والشعبة": "class",
  "الصف": "grade", "الشعبة": "section", "شعبة": "section", "رقم الشعبة": "section",
  "درجة خ 1": "test1", "الاختبار الأول": "test1", "الاختبار 1": "test1", "اختبار 1": "test1",
  "درجة خ 2": "test2", "الاختبار الثاني": "test2", "الاختبار 2": "test2", "اختبار 2": "test2",
  "المتوسط": "test_avg", "معدل الاختبار": "test_avg",
  "المشاركة": "participation",
  "المهام الأدائية والمشاريع": "projects", "المشاريع والمهام": "projects", "المشاريع": "projects", "المهام والمشاريع": "projects",
  "الواجبات": "homework", "الواجب": "homework", "واجبات": "homework",
  "الاختبار النهائي": "final_exam", "اختبار نهائي": "final_exam", "النهائي": "final_exam",
  "ملاحظات": "notes", "الملاحظات": "notes", "ملاحظة": "notes",
  "نمط التعلم": "learning_style",
  "صعوبات التعلم": "learning_difficulty", "صعوبات تعلم": "learning_difficulty",
  "الايميل الوزاري": "email", "الإيميل الوزاري": "email", "الإيميل": "email", "الايميل": "email", "البريد الإلكتروني": "email",
};
// Columns the panel's own tables show and the system works out by itself; a sheet may carry them, unread.
const COMPUTED_HEADERS = ["النسبة", "المجموع", "المستوى", "م", "#", "الاستعلام"];

const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();
// Headers match loosely: أ/ا، ى/ي، ة/ه, Arabic digits, and a maximum after the name ("المشاركة (10)", "الاختبار الأول / 20").
const headerKey = s => school.plain(school.toLatin(norm(s))).replace(/\(.*?\)/g, " ").replace(/(?:\s*\/|\s+من)\s*\d+(?:\.\d+)?\s*$/, "")
  .replace(/\s+/g, " ").trim();
const HEADERS = Object.fromEntries(Object.entries(HEADER_MAP).map(([k, f]) => [headerKey(k), f]));
const COMPUTED = new Set(COMPUTED_HEADERS.map(headerKey));
// Notes keep their line breaks; other spacing is tidied as in any text.
const notesOf = v => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// The learning difficulty flag: a checkbox from the panel, "نعم" or "لا" in a sheet. Empty means not given,
// which keeps what is saved; anything else is undefined (an error).
const YES = ["نعم", "✓", "✔", "1", "true"], NO = ["لا", "✗", "0", "false"];
function flagOf(v) {
  if (typeof v === "boolean") return v;
  const t = norm(v).toLowerCase();
  return !t ? null : YES.includes(t) ? true : NO.includes(t) ? false : undefined;
}
// Column values for a write. A flag never stored (an old backup or log entry) is false.
const valuesOf = s => FIELDS.map(([c]) => (c === "learning_difficulty" ? !!s[c] : s[c] ?? null));

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

// The preview counts the rows with this problem, to say why they can't be saved.
const ID_EMPTY = "رقم الهوية فاضي";

// Turns raw input into a clean student record, collecting problems instead of throwing.
function cleanStudent(raw, max = maxOf(getSettings())) {
  const LIMITS = limitsFor(max);
  const errors = [];
  const s = {};
  s.national_id = String(raw.national_id ?? "").replace(/\D/g, "");
  if (!s.national_id) errors.push(ID_EMPTY);
  else if (s.national_id.length < 9 || s.national_id.length > 10) errors.push("رقم الهوية لازم يكون 10 أرقام");
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
  s.learning_difficulty = flagOf(raw.learning_difficulty);
  if (s.learning_difficulty === undefined) { errors.push(`${LABEL.learning_difficulty}: اكتبي "نعم" أو "لا" أو اتركيها فاضية`); s.learning_difficulty = null; }
  s.email = norm(raw.email) || null;
  s.notes = notesOf(raw.notes) || null;
  if (s.notes && s.notes.length > NOTES_MAX) errors.push(`${LABEL.notes}: النص أطول من ${NOTES_MAX} حرف`);
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

// A sheet may split the class into الصف and الشعبة, as the panel's export does ("الأول الثانوي" or "1", and "2"), or
// write it in one column. A grade next to a bare number in the class column is joined the same way.
function classOfRow(raw) {
  const grade = school.toLatin(norm(raw.grade)), cls = norm(raw.class), section = school.toLatin(norm(raw.section) || cls);
  const isGrade = /^[1-3]$/.test(grade) || (grade && !/\d/.test(grade));
  return isGrade && /^\d{1,2}$/.test(section) ? `${grade} / ${section}` : cls || grade;
}

// The first sheet with a students table: its rows, and the headers it has that the system does not read.
async function readStudentsFromExcel(file) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: "cache", styles: "ignore", hyperlinks: "ignore", worksheets: "emit" });
  for await (const sheet of reader) {
    let cols = null, ignored = [], emptyRun = 0;
    const rows = [];
    for await (const row of sheet) {
      const values = row.values || [];
      if (!cols) {
        const found = {};
        values.forEach((v, i) => { const f = HEADERS[headerKey(cellText(v))]; if (f && !(f in found)) found[f] = i; });
        if ("national_id" in found && "name" in found && Object.keys(found).length >= 4) {
          cols = found;
          const used = new Set(Object.values(found));
          ignored = values.map((v, i) => [i, norm(cellText(v))]).filter(([i, t]) => t && !used.has(i) && !COMPUTED.has(headerKey(t))).map(([, t]) => t);
        }
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
      raw.class = classOfRow(raw);
      rows.push({ line: row.number, raw });
    }
    if (cols) return { rows, ignored };
  }
  return null;
}

// Students listed by grade and section; classes without a grade after them.
const CLASS_ORDER = "c.grade NULLS LAST, c.section, s.class NULLS LAST";

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

  const calendarInfo = async () => ({ years: school.getYears(), now: await school.now(pool) });

  router.get("/me", async (req, res) => res.json({ ok: true, role: req.role, max: maxOf(getSettings()), styles: STYLES, settings: getSettings(),
    calendar: await calendarInfo(), school: { stage: school.STAGE, tracks: school.TRACKS } }));

  // ---------- School calendar ----------
  router.get("/calendar", async (req, res) => res.json(await calendarInfo()));

  router.put("/calendar/:hijri", async (req, res) => {
    const hijri = Number(req.params.hijri);
    if (!school.getYears().some(y => y.hijri === hijri)) return res.status(404).json({ error: "not_found" });
    const y = school.cleanYear(req.body);
    if (y.errors.length) return res.status(400).json({ error: "invalid", errors: y.errors });
    await school.saveYear(pool, hijri, y);
    await pool.query("INSERT INTO audit_log (action, details) VALUES ('calendar', $1)", [JSON.stringify({ year: hijri })]);
    res.json(await calendarInfo());
  });

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
    for (const k of ["subject", "term_title", "teacher_name", "principal_name", "closed_message"]) {
      next[k] = norm(b[k] ?? DEFAULTS[k]).slice(0, 200);
    }
    if (!next.teacher_name) errors.push("اسم المعلمة مطلوب");
    if (!next.closed_message) next.closed_message = DEFAULTS.closed_message;
    for (const k of ["max_test", "max_participation", "max_projects"]) {
      const n = Number(school.toLatin(b[k]));
      if (!Number.isFinite(n) || n <= 0 || n > 1000) errors.push(`الدرجة العظمى غير صحيحة: ${b[k]}`);
      next[k] = n;
    }
    // Left empty, homework and the final exam stay out of the percentage and off the students' cards.
    for (const k of ["max_homework", "max_final"]) {
      const t = norm(school.toLatin(b[k])), n = Number(t);
      if (t && (!Number.isFinite(n) || n <= 0 || n > 1000)) errors.push(`الدرجة العظمى غير صحيحة: ${t}`);
      next[k] = t ? n : null;
    }
    next.compare_chart = grades.Report.isChart(b.compare_chart) ? b.compare_chart : getSettings().compare_chart;
    next.lookup_open = b.lookup_open !== false;
    if (errors.length) return res.status(400).json({ error: "invalid", errors });

    // A lower maximum must not leave saved scores above it.
    const checks = [["test1", next.max_test], ["test2", next.max_test], ["participation", next.max_participation], ["projects", next.max_projects],
      ["homework", next.max_homework], ["final_exam", next.max_final]].filter(([, m]) => m != null);
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
          // A field the panel no longer has (lateness, in older entries) has nothing to go back to.
          if (c.field === "national_id" || c.field === "test_avg" || !(c.field in LABEL)) continue;
          if (same(now[c.field], c.to)) revert.push(c); else skipped.push(LABEL[c.field]);
        }
        const next = { ...now };
        for (const c of revert) next[c.field] = c.from;
        next.test_avg = next.test1 != null && next.test2 != null ? Math.round(((Number(next.test1) + Number(next.test2)) / 2) * 100) / 100 : next.test_avg;
        await client.query(`UPDATE students SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE national_id = $${cols.length + 1}`, [...valuesOf(next), e.national_id]);
      } else if (e.action === "add") {
        if (cur) await client.query("DELETE FROM students WHERE national_id = $1", [e.national_id]);
      } else if (e.action === "delete") {
        if (cur) { await client.query("ROLLBACK"); return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية حالياً"] }); }
        await client.query(`INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, valuesOf(e.details || {}));
        await syncClasses(client);
      } else if (e.action === "term_delete") {
        const d = e.details || {};
        if ((await client.query("SELECT 1 FROM terms WHERE title = $1", [d.title])).rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "exists", errors: ["توجد فترة بنفس العنوان حالياً"] });
        }
        const t = await client.query("INSERT INTO terms (title, max, created_at, year, semester) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [d.title, JSON.stringify(d.max), d.created_at, d.year ?? null, d.semester ?? null]);
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
      ON l.national_id = s.national_id LEFT JOIN classes c ON c.name = s.class ORDER BY ${CLASS_ORDER}, s.name`);
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
    student.learning_difficulty ??= false;
    const cols = FIELDS.map(f => f[0]);
    try {
      await pool.query(`INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, valuesOf(student));
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
    student.learning_difficulty ??= rows[0].learning_difficulty;
    const cols = FIELDS.map(f => f[0]);
    try {
      await pool.query(`UPDATE students SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE national_id = $${cols.length + 1}`, [...valuesOf(student), req.params.id]);
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

  // Columns in the order of the students table. The class is split into الصف and الشعبة; the import joins them back.
  const EXPORT_COLS = FIELDS.flatMap(f => (f[0] === "class" ? [["grade", "الصف"], ["section", "الشعبة"]] : [f]));
  const WIDTHS = { name: 30, email: 28, national_id: 14, grade: 16, notes: 40 };
  function exportRow(r) {
    const o = fromRow(r), p = grades.Report.classParts(o.class);
    o.grade = p ? grades.Report.GRADES[p.grade - 1] : o.class;
    o.section = p ? p.section : null;
    o.learning_difficulty = o.learning_difficulty ? "نعم" : "";
    return o;
  }
  async function sendExcel(res, rows, cols, fileName) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("الطالبات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = cols.map(([key, header]) => ({ key, header, width: WIDTHS[key] || 13 }));
    rows.forEach(r => ws.addRow(exportRow(r)));
    if (cols.some(([k]) => k === "notes")) ws.getColumn("notes").alignment = { wrapText: true, vertical: "top" };
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

  // All students, or one class (?class=) from its page.
  router.get("/export", async (req, res) => {
    const cls = typeof req.query.class === "string" && req.query.class ? req.query.class : null;
    const { rows } = await pool.query(`SELECT s.* FROM students s LEFT JOIN classes c ON c.name = s.class
      ${cls ? "WHERE s.class = $1" : ""} ORDER BY ${CLASS_ORDER}, s.name`, cls ? [cls] : []);
    await sendExcel(res, rows, EXPORT_COLS, cls ? `نتائج ${grades.Report.classLabel(cls).replace(/\//g, "-")}` : "نتائج الطالبات");
  });

  // ---------- Terms: each archived period keeps its own copy of the results ----------
  const insertTermResults = (q, termId, list) => q.query(
    `INSERT INTO term_results (term_id, ${TERM_COLS.join(", ")})
     SELECT $1, ${TERM_COLS.join(", ")} FROM jsonb_to_recordset($2) AS x(${TERM_COLS.map(c => `${c} ${TERM_TYPES[c] || "NUMERIC"}`).join(", ")})`,
    [termId, JSON.stringify(list)]);
  const termId = req => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);
  const titleTaken = (title, except = 0) => pool.query("SELECT 1 FROM terms WHERE title = $1 AND id <> $2", [title, except]).then(r => r.rowCount > 0);

  router.get("/terms", async (req, res) => {
    const terms = (await pool.query("SELECT id, title, max, created_at, year, semester FROM terms ORDER BY created_at, id")).rows;
    const results = (await pool.query(`SELECT term_id, ${GRADE_COLS.join(", ")}, learning_difficulty FROM term_results`)).rows;
    res.json(terms.map(t => {
      const mine = results.filter(r => r.term_id === t.id);
      // Like the class average, the term average leaves out students with learning difficulties.
      const pcts = mine.filter(r => !r.learning_difficulty).map(r => grades.Report.scores(r, t.max).pct).filter(p => p != null);
      return { ...t, count: mine.length, avg: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null };
    }));
  });

  // Archive the current grades under a title. Optionally empty them for the next period (a backup is kept first).
  // The archive belongs to a semester, the open one unless the teacher picks another; clearing closes it.
  router.post("/terms", async (req, res) => {
    const title = norm(req.body?.title).slice(0, 80);
    const clear = req.body?.clear === true;
    const nextTitle = norm(req.body?.next_title).slice(0, 80);
    const open = (await school.now(pool))?.current;
    const year = req.body?.year == null ? open?.year ?? null : Number(req.body.year);
    const semester = req.body?.semester == null ? open?.num ?? null : Number(req.body.semester);
    if (!title) return res.status(400).json({ error: "invalid", errors: ["اكتبي عنوان الفترة"] });
    if ((year != null && !(year >= 1440 && year <= 1500)) || (semester != null && ![1, 2, 3].includes(semester))) {
      return res.status(400).json({ error: "invalid", errors: ["الفصل الدراسي غير صحيح"] });
    }
    if (await titleTaken(title)) return res.status(409).json({ error: "exists", errors: ["توجد فترة مؤرشفة بنفس العنوان"] });
    const client = await pool.connect();
    const prevTitle = getSettings().term_title;
    let count;
    try {
      await client.query("BEGIN");
      const t = await client.query("INSERT INTO terms (title, max, year, semester) VALUES ($1, $2, $3, $4) RETURNING id", [title, JSON.stringify(maxOf(getSettings())), year, semester]);
      count = (await client.query(
        `INSERT INTO term_results (term_id, ${TERM_COLS.join(", ")}) SELECT $1, ${TERM_COLS.join(", ")} FROM students
         WHERE coalesce(${GRADE_COLS.join(", ")}) IS NOT NULL`, [t.rows[0].id])).rowCount;
      if (!count) { await client.query("ROLLBACK"); return res.status(400).json({ error: "empty", errors: ["ما فيه درجات مرصودة للأرشفة"] }); }
      // The log keeps the term id and the cleared grades, so the archive can be undone from there.
      const details = { title, count, cleared: clear, next_title: clear ? nextTitle : null, term_id: t.rows[0].id, prev_title: prevTitle, year, semester };
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
    const t = (await pool.query("SELECT title, max, created_at, year, semester FROM terms WHERE id = $1", [id])).rows[0];
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
    await sendExcel(res, rows, EXPORT_COLS.filter(([k]) => k !== "email" && k !== "notes"), `نتائج ${t.title}`);
  });

  router.get("/history", async (req, res) => res.json(await grades.history(pool)));

  // Uploads are previewed first; the parsed result waits here until the teacher approves it.
  const previews = new Map();
  const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });

  // A class picked before the upload takes every student in the file; without one, each row's class column decides.
  router.post("/import", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    const target = norm(req.body?.class) || null;
    if (target && !(await pool.query("SELECT 1 FROM classes WHERE name = $1", [target])).rowCount) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "unknown_class" });
    }
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
    const known = (await pool.query("SELECT name, aliases FROM classes")).rows;
    const current = new Map(rows.map(r => [r.national_id, fromRow(r)]));
    const seen = new Set();
    const added = [], changed = [], errors = [], unchanged = [], elsewhere = {}, named = new Set();
    for (const { line, raw } of parsed.rows) {
      const { student, errors: errs } = cleanStudent(raw);
      if (school.isLdGroup(student.class)) student.learning_difficulty ??= true;
      const fileClass = resolveClass(student.class, known);
      if (fileClass) named.add(fileClass);
      student.class = target || fileClass;
      if (seen.has(student.national_id)) errs.push("رقم الهوية مكرر في الملف");
      if (errs.length) { errors.push({ line, name: student.name || norm(raw.name), id: student.national_id, problems: errs }); continue; }
      seen.add(student.national_id);
      // A sheet that names another class may be the wrong file; the preview says so before anything changes.
      if (target && fileClass && fileClass !== target) elsewhere[fileClass] = (elsewhere[fileClass] || 0) + 1;
      const before = current.get(student.national_id);
      if (!before) { student.learning_difficulty ??= false; added.push(student); continue; }
      // An empty cell in the file never erases a value already saved (e.g. a style set from the panel).
      for (const [f] of FIELDS) if (student[f] == null && before[f] != null) student[f] = before[f];
      const changes = FIELDS.map(f => f[0]).filter(c => !same(before[c], student[c])).map(c => ({ field: c, label: LABEL[c], from: before[c], to: student[c] }));
      if (changes.length) changed.push({ student, changes }); else unchanged.push(student.national_id);
    }
    // With a class picked, only its own students can be missing from the file; without one, only those of the classes
    // the file names (all of them, if it names none).
    const missing = [...current.values()].filter(s => !seen.has(s.national_id) && (target ? s.class === target : !named.size || named.has(s.class)))
      .map(s => ({ national_id: s.national_id, name: s.name }));

    const token = crypto.randomBytes(16).toString("hex");
    previews.set(token, { at: Date.now(), name: req.file.originalname, target, upserts: [...added, ...changed.map(c => c.student)] });
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60 * 1000) previews.delete(k);
    res.json({ token, fileName: Buffer.from(req.file.originalname, "latin1").toString("utf8"), totalRows: parsed.rows.length, added, changed, unchanged: unchanged.length, errors, missing,
      target, elsewhere: Object.entries(elsewhere).map(([name, count]) => ({ name, count })),
      ignored: parsed.ignored, missingIds: errors.filter(e => e.problems.includes(ID_EMPTY)).length });
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
           ON CONFLICT (national_id) DO UPDATE SET ${cols.filter(c => c !== "national_id").map(c => `${c} = EXCLUDED.${c}`).join(", ")}`,
          valuesOf(s));
      }
      await syncClasses(client);
      await client.query("INSERT INTO audit_log (action, details) VALUES ('import', $1)", [JSON.stringify({ count: p.upserts.length, class: p.target || undefined })]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, count: p.upserts.length });
  });

  // ---------- Classes ----------
  // A student's class always names a class on the list. An old name joins the class that kept it as an alias,
  // a short form ("2/1") becomes the full name, and any other name is listed as written, without a grade.
  const resolveClass = (name, known) => {
    if (!name || known.some(c => c.name === name)) return name;
    const owner = known.find(c => c.aliases.includes(name));
    if (owner) return owner.name;
    const p = school.parseClass(name);
    return p ? school.className(p.grade, p.section) : name;
  };
  async function syncClasses(q) {
    const known = (await q.query("SELECT name, aliases FROM classes")).rows;
    const { rows } = await q.query("SELECT DISTINCT class FROM students WHERE class IS NOT NULL AND class NOT IN (SELECT name FROM classes)");
    for (const { class: name } of rows) {
      const to = resolveClass(name, known);
      if (!known.some(c => c.name === to)) {
        const p = grades.Report.classParts(to);
        await q.query("INSERT INTO classes (name, year, grade, section, track) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
          [to, p ? school.currentYear() : null, p?.grade ?? null, p?.section ?? null, p ? school.trackFor(p.grade) : null]);
        known.push({ name: to, aliases: [] });
      }
      if (to !== name) await q.query(`UPDATE students SET class = $1${school.isLdGroup(name) ? ", learning_difficulty = true" : ""} WHERE class = $2`, [to, name]);
    }
  }
  // A class taken by name is nobody's old name any more.
  const freeName = (q, name) => q.query("UPDATE classes SET aliases = array_remove(aliases, $1) WHERE name <> $1", [name]);

  const classOf = body => {
    const grade = Number(body?.grade), section = Number(body?.section), errors = [];
    if (![1, 2, 3].includes(grade)) errors.push("اختاري الصف");
    if (!Number.isInteger(section) || section < 1 || section > 99) errors.push("رقم الفصل لازم يكون من 1 إلى 99");
    const track = grade === 1 ? null : norm(body?.track);
    if (grade > 1 && !school.TRACKS.includes(track)) errors.push("اختاري المسار");
    return { grade, section, track, name: errors.length ? null : school.className(grade, section), errors };
  };

  async function inTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query(out?.rollback ? "ROLLBACK" : "COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  router.get("/classes", async (req, res) => {
    await syncClasses(pool);
    const { rows } = await pool.query(`SELECT c.name, c.year, c.grade, c.section, c.track, c.aliases, count(s.national_id)::int AS count
      FROM classes c LEFT JOIN students s ON s.class = c.name GROUP BY c.name ORDER BY c.grade NULLS LAST, c.section, c.name`);
    res.json(rows);
  });

  router.post("/classes", async (req, res) => {
    const c = classOf(req.body);
    if (c.errors.length) return res.status(400).json({ error: "invalid", errors: c.errors });
    const out = await inTransaction(async q => {
      const { rowCount } = await q.query("INSERT INTO classes (name, year, grade, section, track) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [c.name, school.currentYear(), c.grade, c.section, c.track]);
      if (!rowCount) return { rollback: true };
      await freeName(q, c.name);
      await q.query("INSERT INTO audit_log (action, details) VALUES ('class_add', $1)", [JSON.stringify({ name: c.name, track: c.track })]);
    });
    if (out?.rollback) return res.status(409).json({ error: "exists", errors: [`${c.name} موجود`] });
    res.json({ name: c.name, count: 0 });
  });

  // A new grade or section renames the class, keeping an unstructured old name ("1") as an alias.
  // Onto a class that exists, it merges the two. The same grade and section only changes the track.
  router.put("/classes/:name", async (req, res) => {
    const from = req.params.name, c = classOf(req.body);
    if (c.errors.length) return res.status(400).json({ error: "invalid", errors: c.errors });
    const out = await inTransaction(async q => {
      await syncClasses(q);
      const old = (await q.query("SELECT * FROM classes WHERE name = $1 FOR UPDATE", [from])).rows[0];
      if (!old) return { rollback: true };
      if (c.name === from) {
        if (old.track !== c.track) {
          await q.query("UPDATE classes SET track = $2 WHERE name = $1", [from, c.track]);
          await q.query("INSERT INTO audit_log (action, details) VALUES ('class_track', $1)", [JSON.stringify({ name: from, from: old.track, to: c.track })]);
        }
        return { moved: 0, name: from };
      }
      const target = (await q.query("SELECT track FROM classes WHERE name = $1 FOR UPDATE", [c.name])).rows[0];
      const aliases = [...old.aliases, ...(grades.Report.classParts(from) ? [] : [from])];
      await q.query("DELETE FROM classes WHERE name = $1", [from]);
      if (target) await q.query("UPDATE classes SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $2::text[])) WHERE name = $1", [c.name, aliases]);
      else await q.query("INSERT INTO classes (name, year, grade, section, track, aliases, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [c.name, old.year ?? school.currentYear(), c.grade, c.section, c.track, aliases, old.created_at]);
      await freeName(q, c.name);
      const ld = school.isLdGroup(from);
      const moved = (await q.query(`UPDATE students SET class = $1${ld ? ", learning_difficulty = true" : ""} WHERE class = $2`, [c.name, from])).rowCount;
      await q.query("INSERT INTO audit_log (action, details) VALUES ('class_rename', $1)",
        [JSON.stringify({ from, to: c.name, students: moved, merged: !!target, track: target ? target.track : c.track, learning_difficulty: ld && moved > 0 })]);
      return { moved, name: c.name, merged: !!target };
    });
    if (out?.rollback) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, ...out });
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
        await client.query(`INSERT INTO students (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, valuesOf(s));
      }
      await syncClasses(client);
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
