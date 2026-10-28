const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const multer = require("multer");
const util = require("util");
const ExcelJS = require("exceljs");
const { DEFAULTS, getSettings, saveSettings, saveSchool, getSchool, maxOf, getTeacher, listTeachers, reloadTeachers } = require("./settings");
const grades = require("./grades");
const school = require("./school");
const feedback = require("./feedback");
const staff = require("./staff");

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

// Turns raw input into a clean student record against the teacher's maximum scores, collecting problems instead of throwing.
function cleanStudent(raw, max) {
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
// A student's class, joined within her teacher's classes.
const CLASS_JOIN = "LEFT JOIN classes c ON c.teacher_id = s.teacher_id AND c.name = s.class";
// The lessons and their feedback belong to the first teacher, who gave them.
const LESSONS_OWNER = 1;
// The platform admin runs the school, not a class: these are the only routes that account reaches. No teacher's
// students, classes, archives or log are among them.
const ADMIN_ROUTES = /^\/(me|logout|calendar|viewer|staff|school|catalog|feedback|attendance)(\/|$)/;

module.exports = function mountAdmin(app, pool) {
  const PASSWORD = process.env.ADMIN_PASSWORD || "";
  const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  if (!PASSWORD) console.warn("ADMIN_PASSWORD is not set; the platform admin account is disabled");

  const sign = v => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
  const hash = v => crypto.createHash("sha256").update(String(v)).digest();

  // The principal's read-only password, set by the platform admin. Kept apart from the site settings so it is never sent out.
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

  // Three accounts: the platform admin ("admin", ADMIN_PASSWORD), the principal ("viewer", read-only, every teacher)
  // and each teacher ("teacher", her own data only).
  // Cookie: role.teacher.expiry.version.signature. A new password bumps the version and ends the account's old sessions.
  function readSession(req) {
    const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return null;
    const parts = m[1].split(".");
    if (parts.length !== 5) return null;
    const [role, tid, exp, ver, sig] = parts;
    const expected = sign(`${role}.${tid}.${exp}.${ver}`);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (!(Number(exp) > Date.now())) return null;
    if (role === "admin" && PASSWORD) return { role };
    if (role === "viewer" && viewer.hash && Number(ver) === viewer.ver) return { role };
    const t = role === "teacher" && getTeacher(Number(tid));
    if (t && !t.owner_id && t.active && t.pw_hash && Number(ver) === t.pw_ver) return { role, tid: t.id };
    return null;
  }

  function setSession(res, ms, role = "admin", t = null) {
    const ver = role === "viewer" ? viewer.ver : role === "teacher" ? t.pw_ver : 0;
    const payload = `${role}.${t ? t.id : 0}.${Date.now() + ms}.${ver}`;
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ms / 1000)}${secure}`);
  }

  // 5 wrong passwords lock that device out for 15 minutes; 10 on one teacher's account lock the account.
  const failures = new Map(), accountFailures = new Map();
  const LOCK_MS = 15 * 60 * 1000;
  const recent = (map, key) => (map.get(key) || []).filter(t => Date.now() - t < LOCK_MS);

  const router = express.Router();
  router.use(express.json({ limit: "100kb" }));
  // Express 4 does not catch rejected promises; send them to the error handler.
  for (const m of ["get", "post", "put", "delete"]) {
    const orig = router[m].bind(router);
    router[m] = (route, ...fns) => orig(route, ...fns.map(fn => (req, res, next) => {
      try { const r = fn(req, res, next); if (r && typeof r.catch === "function") r.catch(next); } catch (err) { next(err); }
    }));
  }

  // A teacher signs in with her email and her password; the admin and the principal with a password alone.
  const findTeacher = user => {
    const email = staff.emailOf(user);
    return (email && listTeachers().find(t => t.email === email)) || null;
  };
  // A teacher's panels: her own, then one for each other subject she teaches.
  const panelsOf = id => listTeachers().filter(t => t.id === id || t.owner_id === id);

  router.post("/login", async (req, res) => {
    const now = Date.now();
    const list = recent(failures, req.ip);
    if (list.length >= 5) return res.status(429).json({ error: "locked" });
    const pw = String(req.body?.password ?? "");
    const user = norm(req.body?.user);
    let role = null, t = null;
    if (user) {
      t = findTeacher(user);
      if (t && recent(accountFailures, t.id).length >= 10) return res.status(429).json({ error: "locked" });
      if (t && (await staff.checkPassword(t, pw))) {
        if (!t.active) return res.status(403).json({ error: "inactive" });
        role = "teacher";
      }
    } else {
      if (!PASSWORD && !viewer.hash) return res.status(503).json({ error: "disabled" });
      role = PASSWORD && crypto.timingSafeEqual(hash(pw), hash(PASSWORD)) ? "admin" : (await isViewerPassword(pw)) ? "viewer" : null;
    }
    if (!role) {
      list.push(now); failures.set(req.ip, list);
      if (t) accountFailures.set(t.id, [...recent(accountFailures, t.id), now]);
      return res.status(401).json({ error: "wrong_password", left: 5 - list.length });
    }
    failures.delete(req.ip);
    if (t) {
      accountFailures.delete(t.id);
      await pool.query("UPDATE teachers SET last_login = now() WHERE id = $1", [t.id]);
    }
    setSession(res, SESSION_HOURS * 3600 * 1000, role, t);
    res.json({ ok: true, role });
  });

  router.post("/logout", (req, res) => { setSession(res, 0); res.json({ ok: true }); });

  // Whose data a request reads and writes. A teacher only ever her own; the principal picks a teacher
  // (the X-Teacher header, or ?t= on a download link), the first one by default. The admin reads none.
  router.use((req, res, next) => {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: "unauthorized" });
    req.role = s.role;
    // A teacher reads her own panels only: the one she signed in with, or another of her subjects (X-Teacher).
    if (s.role === "teacher") {
      req.login = s.tid;
      const want = getTeacher(Number(req.get("x-teacher") || req.query.t));
      req.tid = want && want.owner_id === s.tid ? want.id : s.tid;
    } else {
      const want = Number(req.get("x-teacher") || req.query.t);
      req.tid = getTeacher(want) ? want : listTeachers()[0]?.id ?? 1;
    }
    // The admin reads the school's own log, never a teacher's (nor undoes anything in it).
    const schoolLog = req.path === "/audit" && req.method === "GET";
    if (req.role === "admin" && !schoolLog && !ADMIN_ROUTES.test(req.path)) return res.status(403).json({ error: "school_only", errors: ["حساب الإدارة ما يعرض بيانات المعلمات"] });
    // The principal's account sees everything and changes nothing.
    if (req.role === "viewer" && req.method !== "GET") return res.status(403).json({ error: "read_only", errors: ["هذا الحساب للعرض فقط"] });
    next();
  });
  const adminOnly = (req, res, next) => (req.role === "admin" ? next() : res.status(403).json({ error: "forbidden", errors: ["هذا الإجراء لإدارة المنصة فقط"] }));

  // Every change is logged against the teacher it touched; the school's own (calendar, staff) against none.
  const log = (q, tid, action, nationalId, details) =>
    q.query("INSERT INTO audit_log (teacher_id, action, national_id, details) VALUES ($1, $2, $3, $4)", [tid, action, nationalId ?? null, JSON.stringify(details ?? {})]);

  // The admin sees the school's calendar as it stands; a teacher's semester also follows her own archives.
  const calendarInfo = async (tid, role) => ({ years: school.getYears(), now: role === "admin" ? school.situation() : await school.now(pool, tid) });
  const teacherInfo = t => ({ id: t.id, name: t.name, subject: t.subject || "", active: t.active });

  router.get("/me", async (req, res) => {
    if (req.role === "admin") {
      return res.json({ ok: true, role: "admin", schoolSettings: getSchool(), calendar: await calendarInfo(null, "admin"),
        school: { stage: school.STAGE, tracks: school.TRACKS } });
    }
    const t = getTeacher(req.tid), mine = req.role === "teacher" ? panelsOf(req.login) : [];
    res.json({ ok: true, role: req.role, teacher: t ? teacherInfo(t) : null,
      // The principal switches between teachers; a teacher between her subjects, when she has several.
      teachers: req.role === "viewer" ? listTeachers().map(teacherInfo) : mine.length > 1 ? mine.map(teacherInfo) : undefined,
      user: req.role === "teacher" ? getTeacher(req.login).email : undefined, login: req.login,
      max: maxOf(getSettings(req.tid)), styles: STYLES, settings: getSettings(req.tid),
      calendar: await calendarInfo(req.tid), school: { stage: school.STAGE, tracks: school.TRACKS } });
  });

  // A teacher changes her own password. Her other sessions end; this one carries on.
  router.put("/password", async (req, res) => {
    if (req.role !== "teacher") return res.status(403).json({ error: "forbidden" });
    const t = getTeacher(req.login);
    const next = String(req.body?.next ?? "");
    if (!(await staff.checkPassword(t, String(req.body?.current ?? "")))) return res.status(400).json({ error: "invalid", errors: ["كلمة المرور الحالية غير صحيحة"] });
    if (next.length < 6) return res.status(400).json({ error: "invalid", errors: ["كلمة المرور الجديدة لازم تكون 6 أحرف أو أرقام أو أكثر"] });
    const h = await staff.hashPassword(next);
    await pool.query("UPDATE teachers SET pw_salt = $2, pw_hash = $3, pw_ver = pw_ver + 1 WHERE id = $1", [t.id, h.salt, h.hash]);
    await reloadTeachers(pool);
    await log(pool, t.id, "password", null, {});
    setSession(res, SESSION_HOURS * 3600 * 1000, "teacher", getTeacher(t.id));
    res.json({ ok: true });
  });

  // ---------- Workshop feedback (the lessons' owner, the admin and the principal) ----------
  const lessonsOnly = (req, res, next) => (req.role !== "teacher" || req.login === LESSONS_OWNER ? next() : res.status(403).json({ error: "forbidden" }));
  router.get("/feedback/:workshop", lessonsOnly, async (req, res) => {
    const out = await feedback.results(pool, req.params.workshop);
    if (!out) return res.status(404).json({ error: "not_found" });
    res.set("Cache-Control", "no-store").json({ ...out, role: req.role === "viewer" ? "viewer" : "admin" });
  });

  // For clearing a test answer before the real attendees arrive.
  router.delete("/feedback/:workshop/:id", lessonsOnly, async (req, res) => {
    const { rowCount } = await pool.query("DELETE FROM workshop_feedback WHERE workshop = $1 AND id = $2", [req.params.workshop, Number(req.params.id) || 0]);
    res.json({ ok: rowCount > 0 });
  });
  router.delete("/attendance/:workshop/:id", lessonsOnly, async (req, res) => {
    const { rowCount } = await pool.query("DELETE FROM workshop_attendance WHERE workshop = $1 AND id = $2", [req.params.workshop, Number(req.params.id) || 0]);
    res.json({ ok: rowCount > 0 });
  });

  // ---------- School calendar (the school's; only the admin edits it) ----------
  router.get("/calendar", async (req, res) => res.json(await calendarInfo(req.tid, req.role)));

  router.put("/calendar/:hijri", adminOnly, async (req, res) => {
    const hijri = Number(req.params.hijri);
    if (!school.getYears().some(y => y.hijri === hijri)) return res.status(404).json({ error: "not_found" });
    const y = school.cleanYear(req.body);
    if (y.errors.length) return res.status(400).json({ error: "invalid", errors: y.errors });
    await school.saveYear(pool, hijri, y);
    await log(pool, null, "calendar", null, { year: hijri });
    res.json(await calendarInfo(req.tid, req.role));
  });

  router.get("/viewer", adminOnly, (req, res) => res.json({ enabled: !!viewer.hash }));

  router.put("/viewer", adminOnly, async (req, res) => {
    const pw = String(req.body?.password ?? "");
    if (pw.length < 6) return res.status(400).json({ error: "invalid", errors: ["كلمة المرور لازم تكون 6 أحرف أو أكثر"] });
    if (pw === PASSWORD) return res.status(400).json({ error: "invalid", errors: ["كلمة مرور المديرة لازم تختلف عن كلمة مرور الإدارة"] });
    const salt = crypto.randomBytes(16).toString("hex");
    await saveViewer({ salt, hash: (await scrypt(pw, salt, 32)).toString("hex"), ver: viewer.ver + 1 });
    await log(pool, null, "viewer_set", null, {});
    res.json({ enabled: true });
  });

  router.delete("/viewer", adminOnly, async (req, res) => {
    await saveViewer({ ver: viewer.ver + 1 });
    await log(pool, null, "viewer_off", null, {});
    res.json({ enabled: false });
  });

  router.get("/settings", (req, res) => res.json(getSettings(req.tid)));

  // The teacher's own settings. The principal's name is the school's and stays as the admin set it.
  // Her subject is one on the school's list, once the list has any.
  router.put("/settings", async (req, res) => {
    const T = req.tid, b = req.body || {}, errors = [];
    const before = getSettings(T);
    const next = {};
    for (const k of ["subject", "term_title", "teacher_name", "principal_name", "closed_message"]) {
      next[k] = norm(b[k] ?? DEFAULTS[k]).slice(0, 200);
    }
    next.principal_name = before.principal_name;
    const subjects = (await pool.query("SELECT name FROM subjects")).rows.map(r => r.name);
    if (subjects.length && next.subject !== before.subject && !subjects.includes(next.subject)) errors.push("اختاري المادة من القائمة");
    const owner = getTeacher(T)?.owner_id || T;
    if (next.subject !== before.subject && panelsOf(owner).some(p => p.id !== T && p.subject === next.subject)) errors.push(`عندك لوحة ثانية لمادة ${next.subject}`);
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
    next.compare_chart = grades.Report.isChart(b.compare_chart) ? b.compare_chart : before.compare_chart;
    next.lookup_open = b.lookup_open !== false;
    if (errors.length) return res.status(400).json({ error: "invalid", errors });

    // A lower maximum must not leave saved scores above it.
    const checks = [["test1", next.max_test], ["test2", next.max_test], ["participation", next.max_participation], ["projects", next.max_projects],
      ["homework", next.max_homework], ["final_exam", next.max_final]].filter(([, m]) => m != null);
    for (const [f, m] of checks) {
      const { rows } = await pool.query(`SELECT name FROM students WHERE teacher_id = $1 AND ${f} > $2 ORDER BY name LIMIT 3`, [T, m]);
      if (rows.length) errors.push(`${LABEL[f]}: فيه طالبات درجاتهن أعلى من ${m} (${rows.map(r => r.name).join("، ")})`);
    }
    if (errors.length) return res.status(409).json({ error: "scores_above_max", errors });

    const changes = Object.keys(next).filter(k => before[k] !== next[k]).map(k => ({ field: k, from: before[k], to: next[k] }));
    await saveSettings(pool, T, next);
    // Her name is the same on all her subjects' panels.
    if (next.teacher_name !== before.teacher_name) {
      await pool.query("UPDATE teachers SET name = $2 WHERE id = $1 OR owner_id = $1", [owner, next.teacher_name]);
      await reloadTeachers(pool);
    }
    if (changes.length) await log(pool, T, "settings", null, changes);
    res.json(getSettings(T));
  });

  router.get("/audit", async (req, res) => {
    const { rows } = await pool.query(`SELECT a.id, a.created_at, a.action, a.national_id, a.details, a.undone_at, s.name AS current_name
      FROM audit_log a LEFT JOIN students s ON s.teacher_id = a.teacher_id AND s.national_id = a.national_id
      WHERE a.teacher_id IS NOT DISTINCT FROM $1 ORDER BY a.id DESC LIMIT 300`, [req.role === "admin" ? null : req.tid]);
    res.json(rows);
  });

  // Undo one student change. Fields edited again since then are left alone and reported back.
  router.post("/audit/:id/undo", async (req, res) => {
    const T = req.tid;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM audit_log WHERE id = $1 AND teacher_id = $2 FOR UPDATE", [Number(req.params.id) || 0, T]);
      const e = rows[0];
      if (!e) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
      if (e.undone_at) { await client.query("ROLLBACK"); return res.status(409).json({ error: "already_undone", errors: ["تم التراجع عن هذا التعديل من قبل"] }); }
      const cols = FIELDS.map(f => f[0]);
      const cur = (await client.query("SELECT * FROM students WHERE teacher_id = $1 AND national_id = $2", [T, e.national_id])).rows[0];
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
        await updateStudent(client, T, e.national_id, next);
      } else if (e.action === "add") {
        if (cur) await client.query("DELETE FROM students WHERE teacher_id = $1 AND national_id = $2", [T, e.national_id]);
      } else if (e.action === "delete") {
        if (cur) { await client.query("ROLLBACK"); return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية حالياً"] }); }
        await insertStudent(client, T, e.details || {});
        await syncClasses(client, T);
      } else if (e.action === "term_delete") {
        const d = e.details || {};
        if ((await client.query("SELECT 1 FROM terms WHERE teacher_id = $1 AND title = $2", [T, d.title])).rowCount) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "exists", errors: ["توجد فترة بنفس العنوان حالياً"] });
        }
        const t = await client.query("INSERT INTO terms (teacher_id, title, max, created_at, year, semester) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
          [T, d.title, JSON.stringify(d.max), d.created_at, d.year ?? null, d.semester ?? null]);
        await insertTermResults(client, t.rows[0].id, d.results || []);
      } else if (e.action === "term_archive" && e.details?.term_id) {
        const d = e.details;
        await client.query("DELETE FROM terms WHERE teacher_id = $1 AND id = $2", [T, d.term_id]);
        if (d.grades?.length) {
          const graded = `coalesce(${GRADE_COLS.map(c => "s." + c).join(", ")}) IS NOT NULL`;
          const g = `jsonb_to_recordset($2) AS g(national_id TEXT, ${GRADE_COLS.map(c => c + " NUMERIC").join(", ")})`;
          const list = JSON.stringify(d.grades);
          skipped = (await client.query(`SELECT s.name FROM students s JOIN ${g} ON g.national_id = s.national_id WHERE s.teacher_id = $1 AND ${graded} ORDER BY s.name`, [T, list])).rows.map(r => r.name);
          await client.query(`UPDATE students s SET ${GRADE_COLS.map(c => `${c} = g.${c}`).join(", ")} FROM ${g}
            WHERE s.teacher_id = $1 AND g.national_id = s.national_id AND NOT (${graded})`, [T, list]);
        }
        if (d.cleared && getSettings(T).term_title === (d.next_title || "")) title = d.prev_title ?? "";
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "not_undoable", errors: ["هذا النوع يُسترجع من النسخ الاحتياطية"] });
      }
      await client.query("UPDATE audit_log SET undone_at = now() WHERE id = $1", [e.id]);
      await log(client, T, "undo", e.national_id, { of: e.id, action: e.action, skipped });
      await client.query("COMMIT");
      if (title != null) await saveSettings(pool, T, { ...getSettings(T), term_title: title });
      res.json({ ok: true, skipped, settings: getSettings(T) });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // Lookups count from the start of the teacher's current period: her last archive that cleared the grades.
  // The query passes the teacher as $1.
  const SINCE = `created_at > coalesce((SELECT max(created_at) FROM audit_log
    WHERE teacher_id = $1 AND action = 'term_archive' AND undone_at IS NULL AND (details->>'cleared')::boolean), '-infinity')`;

  router.get("/students", async (req, res) => {
    const { rows } = await pool.query(`SELECT s.*, l.last_lookup, l.lookup_count FROM students s
      LEFT JOIN (SELECT national_id, max(created_at) AS last_lookup, count(*)::int AS lookup_count FROM lookups WHERE teacher_id = $1 AND ${SINCE} GROUP BY national_id) l
      ON l.national_id = s.national_id ${CLASS_JOIN} WHERE s.teacher_id = $1 ORDER BY ${CLASS_ORDER}, s.name`, [req.tid]);
    res.json(rows.map(r => ({ ...fromRow(r), last_lookup: r.last_lookup, lookup_count: r.lookup_count || 0 })));
  });

  router.get("/lookups", async (req, res) => {
    const { rows } = await pool.query(`SELECT l.id, l.national_id, l.kind, l.device, l.created_at, s.name, s.class
      FROM lookups l LEFT JOIN students s ON s.teacher_id = l.teacher_id AND s.national_id = l.national_id
      WHERE l.teacher_id = $1 AND l.${SINCE} ORDER BY l.id DESC LIMIT 100`, [req.tid]);
    const totals = (await pool.query(`SELECT kind, count(*)::int AS n FROM lookups WHERE teacher_id = $1 AND ${SINCE} GROUP BY kind`, [req.tid])).rows;
    res.json({ recent: rows, totals: Object.fromEntries(totals.map(t => [t.kind, t.n])) });
  });

  // Every write of a student names her teacher.
  const COLS = FIELDS.map(f => f[0]);
  const insertStudent = (q, tid, s, { upsert = false } = {}) => q.query(
    `INSERT INTO students (teacher_id, ${COLS.join(",")}) VALUES ($1, ${COLS.map((_, i) => "$" + (i + 2)).join(",")})
     ${upsert ? `ON CONFLICT (teacher_id, national_id) DO UPDATE SET ${COLS.filter(c => c !== "national_id").map(c => `${c} = EXCLUDED.${c}`).join(", ")}` : ""}`,
    [tid, ...valuesOf(s)]);
  const updateStudent = (q, tid, id, s) => q.query(
    `UPDATE students SET ${COLS.map((c, i) => `${c} = $${i + 3}`).join(", ")} WHERE teacher_id = $1 AND national_id = $2`, [tid, id, ...valuesOf(s)]);
  const studentsOf = (q, tid) => q.query("SELECT * FROM students WHERE teacher_id = $1 ORDER BY national_id", [tid]).then(r => r.rows);
  const backup = (q, tid, note, rows) => q.query("INSERT INTO backups (teacher_id, note, data) VALUES ($1, $2, $3)", [tid, note, JSON.stringify(rows.map(fromRow))]);

  router.post("/students", async (req, res) => {
    const T = req.tid;
    const { student, errors } = cleanStudent(req.body || {}, maxOf(getSettings(T)));
    if (errors.length) return res.status(400).json({ error: "invalid", errors });
    student.learning_difficulty ??= false;
    try {
      await insertStudent(pool, T, student);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية"] });
      throw err;
    }
    await log(pool, T, "add", student.national_id, student);
    res.json(student);
  });

  router.put("/students/:id", async (req, res) => {
    const T = req.tid;
    const { student, errors } = cleanStudent({ ...req.body, national_id: req.body?.national_id ?? req.params.id }, maxOf(getSettings(T)));
    if (errors.length) return res.status(400).json({ error: "invalid", errors });
    const { rows } = await pool.query("SELECT * FROM students WHERE teacher_id = $1 AND national_id = $2", [T, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    student.learning_difficulty ??= rows[0].learning_difficulty;
    try {
      await updateStudent(pool, T, req.params.id, student);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "exists", errors: ["توجد طالبة بنفس رقم الهوية"] });
      throw err;
    }
    const before = fromRow(rows[0]);
    const changes = COLS.filter(c => !same(before[c], student[c])).map(c => ({ field: c, from: before[c], to: student[c] }));
    await log(pool, T, "edit", req.params.id, changes);
    res.json(student);
  });

  router.delete("/students/:id", async (req, res) => {
    const { rows } = await pool.query("DELETE FROM students WHERE teacher_id = $1 AND national_id = $2 RETURNING *", [req.tid, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    await log(pool, req.tid, "delete", req.params.id, fromRow(rows[0]));
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

  // All the teacher's students, or one class (?class=) from its page.
  router.get("/export", async (req, res) => {
    const cls = typeof req.query.class === "string" && req.query.class ? req.query.class : null;
    const { rows } = await pool.query(`SELECT s.* FROM students s ${CLASS_JOIN}
      WHERE s.teacher_id = $1 ${cls ? "AND s.class = $2" : ""} ORDER BY ${CLASS_ORDER}, s.name`, cls ? [req.tid, cls] : [req.tid]);
    await sendExcel(res, rows, EXPORT_COLS, cls ? `نتائج ${grades.Report.classLabel(cls).replace(/\//g, "-")}` : "نتائج الطالبات");
  });

  // ---------- Terms: each archived period keeps its own copy of the results ----------
  const insertTermResults = (q, termId, list) => q.query(
    `INSERT INTO term_results (term_id, ${TERM_COLS.join(", ")})
     SELECT $1, ${TERM_COLS.join(", ")} FROM jsonb_to_recordset($2) AS x(${TERM_COLS.map(c => `${c} ${TERM_TYPES[c] || "NUMERIC"}`).join(", ")})`,
    [termId, JSON.stringify(list)]);
  const termId = req => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);
  const titleTaken = (tid, title, except = 0) => pool.query("SELECT 1 FROM terms WHERE teacher_id = $1 AND title = $2 AND id <> $3", [tid, title, except]).then(r => r.rowCount > 0);

  router.get("/terms", async (req, res) => {
    const terms = (await pool.query("SELECT id, title, max, created_at, year, semester FROM terms WHERE teacher_id = $1 ORDER BY created_at, id", [req.tid])).rows;
    const results = (await pool.query(`SELECT r.term_id, ${GRADE_COLS.map(c => "r." + c).join(", ")}, r.learning_difficulty FROM term_results r
      JOIN terms t ON t.id = r.term_id WHERE t.teacher_id = $1`, [req.tid])).rows;
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
    const T = req.tid;
    const title = norm(req.body?.title).slice(0, 80);
    const clear = req.body?.clear === true;
    const nextTitle = norm(req.body?.next_title).slice(0, 80);
    const open = (await school.now(pool, T))?.current;
    const year = req.body?.year == null ? open?.year ?? null : Number(req.body.year);
    const semester = req.body?.semester == null ? open?.num ?? null : Number(req.body.semester);
    if (!title) return res.status(400).json({ error: "invalid", errors: ["اكتبي عنوان الفترة"] });
    if ((year != null && !(year >= 1440 && year <= 1500)) || (semester != null && ![1, 2, 3].includes(semester))) {
      return res.status(400).json({ error: "invalid", errors: ["الفصل الدراسي غير صحيح"] });
    }
    if (await titleTaken(T, title)) return res.status(409).json({ error: "exists", errors: ["توجد فترة مؤرشفة بنفس العنوان"] });
    const client = await pool.connect();
    const prevTitle = getSettings(T).term_title;
    let count;
    try {
      await client.query("BEGIN");
      const t = await client.query("INSERT INTO terms (teacher_id, title, max, year, semester) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [T, title, JSON.stringify(maxOf(getSettings(T))), year, semester]);
      count = (await client.query(
        `INSERT INTO term_results (term_id, ${TERM_COLS.join(", ")}) SELECT $1, ${TERM_COLS.join(", ")} FROM students
         WHERE teacher_id = $2 AND coalesce(${GRADE_COLS.join(", ")}) IS NOT NULL`, [t.rows[0].id, T])).rowCount;
      if (!count) { await client.query("ROLLBACK"); return res.status(400).json({ error: "empty", errors: ["ما فيه درجات مرصودة للأرشفة"] }); }
      // The log keeps the term id and the cleared grades, so the archive can be undone from there.
      const details = { title, count, cleared: clear, next_title: clear ? nextTitle : null, term_id: t.rows[0].id, prev_title: prevTitle, year, semester };
      if (clear) {
        const rows = await studentsOf(client, T);
        await backup(client, T, "قبل أرشفة الفترة ومسح الدرجات", rows);
        details.grades = rows.filter(r => GRADE_COLS.some(c => r[c] != null))
          .map(r => Object.fromEntries(["national_id", ...GRADE_COLS].map(c => [c, r[c]])));
        await client.query(`UPDATE students SET ${GRADE_COLS.map(c => `${c} = NULL`).join(", ")} WHERE teacher_id = $1`, [T]);
      }
      await log(client, T, "term_archive", null, details);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // A fresh period starts with its own title on the lookup page (empty until the teacher names it).
    if (clear) await saveSettings(pool, T, { ...getSettings(T), term_title: nextTitle });
    res.json({ ok: true, count, settings: getSettings(T) });
  });

  router.put("/terms/:id", async (req, res) => {
    const T = req.tid, id = termId(req), title = norm(req.body?.title).slice(0, 80);
    if (!title) return res.status(400).json({ error: "invalid", errors: ["اكتبي عنوان الفترة"] });
    if (await titleTaken(T, title, id || 0)) return res.status(409).json({ error: "exists", errors: ["توجد فترة مؤرشفة بنفس العنوان"] });
    const old = (await pool.query("SELECT title FROM terms WHERE teacher_id = $1 AND id = $2", [T, id])).rows[0];
    if (!old) return res.status(404).json({ error: "not_found" });
    await pool.query("UPDATE terms SET title = $1 WHERE id = $2", [title, id]);
    await log(pool, T, "term_rename", null, { from: old.title, to: title });
    res.json({ ok: true });
  });

  // The deleted results stay in the log, so the deletion can be undone from there.
  router.delete("/terms/:id", async (req, res) => {
    const T = req.tid, id = termId(req);
    const t = (await pool.query("SELECT title, max, created_at, year, semester FROM terms WHERE teacher_id = $1 AND id = $2", [T, id])).rows[0];
    if (!t) return res.status(404).json({ error: "not_found" });
    const results = (await pool.query(`SELECT ${TERM_COLS.join(", ")} FROM term_results WHERE term_id = $1 ORDER BY national_id`, [id])).rows;
    await pool.query("DELETE FROM terms WHERE id = $1", [id]);
    await log(pool, T, "term_delete", null, { ...t, count: results.length, results });
    res.json({ ok: true });
  });

  router.get("/terms/:id/export", async (req, res) => {
    const id = termId(req);
    const t = (await pool.query("SELECT title FROM terms WHERE teacher_id = $1 AND id = $2", [req.tid, id])).rows[0];
    if (!t) return res.status(404).json({ error: "not_found" });
    const { rows } = await pool.query("SELECT * FROM term_results WHERE term_id = $1 ORDER BY class NULLS LAST, name", [id]);
    await sendExcel(res, rows, EXPORT_COLS.filter(([k]) => k !== "email" && k !== "notes"), `نتائج ${t.title}`);
  });

  router.get("/history", async (req, res) => res.json(await grades.history(pool, req.tid)));

  // Uploads are previewed first; the parsed result waits here until it is approved, by the same teacher's panel.
  const previews = new Map();
  const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024 } });
  const keepPreview = p => {
    const token = crypto.randomBytes(16).toString("hex");
    previews.set(token, { at: Date.now(), ...p });
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60 * 1000) previews.delete(k);
    return token;
  };
  const takePreview = (req, kind) => {
    const p = previews.get(req.params.token);
    if (!p || p.kind !== kind || p.tid !== req.tid) return null;
    previews.delete(req.params.token);
    return p;
  };

  // A class picked before the upload takes every student in the file; without one, each row's class column decides.
  router.post("/import", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    const T = req.tid;
    const target = norm(req.body?.class) || null;
    if (target && !(await pool.query("SELECT 1 FROM classes WHERE teacher_id = $1 AND name = $2", [T, target])).rowCount) {
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

    const max = maxOf(getSettings(T));
    const rows = await studentsOf(pool, T);
    const known = (await pool.query("SELECT name, aliases FROM classes WHERE teacher_id = $1", [T])).rows;
    const current = new Map(rows.map(r => [r.national_id, fromRow(r)]));
    const seen = new Set();
    const added = [], changed = [], errors = [], unchanged = [], elsewhere = {}, named = new Set();
    for (const { line, raw } of parsed.rows) {
      const { student, errors: errs } = cleanStudent(raw, max);
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

    const token = keepPreview({ kind: "students", tid: T, target, upserts: [...added, ...changed.map(c => c.student)] });
    res.json({ token, fileName: Buffer.from(req.file.originalname, "latin1").toString("utf8"), totalRows: parsed.rows.length, added, changed, unchanged: unchanged.length, errors, missing,
      target, elsewhere: Object.entries(elsewhere).map(([name, count]) => ({ name, count })),
      ignored: parsed.ignored, missingIds: errors.filter(e => e.problems.includes(ID_EMPTY)).length });
  });

  router.post("/import/:token/apply", async (req, res) => {
    const p = takePreview(req, "students");
    if (!p) return res.status(410).json({ error: "expired" });
    const T = p.tid;
    await inTransaction(async client => {
      await backup(client, T, "قبل رفع ملف إكسل", await studentsOf(client, T));
      for (const s of p.upserts) await insertStudent(client, T, s, { upsert: true });
      await syncClasses(client, T);
      await log(client, T, "import", null, { count: p.upserts.length, class: p.target || undefined });
    });
    res.json({ ok: true, count: p.upserts.length });
  });

  // ---------- Classes (each teacher's own) ----------
  // A student's class always names a class on the list. An old name joins the class that kept it as an alias,
  // a short form ("2/1") becomes the full name, and any other name is listed as written, without a grade.
  const resolveClass = (name, known) => {
    if (!name || known.some(c => c.name === name)) return name;
    const owner = known.find(c => c.aliases.includes(name));
    if (owner) return owner.name;
    const p = school.parseClass(name);
    return p ? school.className(p.grade, p.section) : name;
  };
  async function syncClasses(q, tid) {
    const known = (await q.query("SELECT name, aliases FROM classes WHERE teacher_id = $1", [tid])).rows;
    const { rows } = await q.query(`SELECT DISTINCT class FROM students WHERE teacher_id = $1 AND class IS NOT NULL
      AND class NOT IN (SELECT name FROM classes WHERE teacher_id = $1)`, [tid]);
    for (const { class: name } of rows) {
      const to = resolveClass(name, known);
      if (!known.some(c => c.name === to)) {
        const p = grades.Report.classParts(to);
        const sc = p && (await q.query("SELECT track FROM school_classes WHERE name = $1", [to])).rows[0];
        const track = p ? (sc ? sc.track : school.trackFor(p.grade)) : null;
        await q.query("INSERT INTO classes (teacher_id, name, year, grade, section, track) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
          [tid, to, p ? school.currentYear() : null, p?.grade ?? null, p?.section ?? null, track]);
        // A class a teacher's sheet names joins the school's list.
        if (p && !sc) await q.query("INSERT INTO school_classes (name, grade, section, track) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [to, p.grade, p.section, track]);
        known.push({ name: to, aliases: [] });
      }
      if (to !== name) await q.query(`UPDATE students SET class = $2${school.isLdGroup(name) ? ", learning_difficulty = true" : ""} WHERE teacher_id = $1 AND class = $3`, [tid, to, name]);
    }
  }
  // A class taken by name is nobody's old name any more.
  const freeName = (q, tid, name) => q.query("UPDATE classes SET aliases = array_remove(aliases, $2) WHERE teacher_id = $1 AND name <> $2", [tid, name]);

  // A teacher's class is one of the school's, picked by name.
  const schoolClass = async name => {
    const c = (await pool.query("SELECT name, grade, section, track FROM school_classes WHERE name = $1", [norm(name)])).rows[0];
    return c ? { ...c, errors: [] } : { errors: ["اختاري الفصل من قائمة فصول المدرسة"] };
  };
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
    await syncClasses(pool, req.tid);
    const { rows } = await pool.query(`SELECT c.name, c.year, c.grade, c.section, c.track, c.aliases, count(s.national_id)::int AS count
      FROM classes c LEFT JOIN students s ON s.teacher_id = c.teacher_id AND s.class = c.name WHERE c.teacher_id = $1
      GROUP BY c.teacher_id, c.name ORDER BY c.grade NULLS LAST, c.section, c.name`, [req.tid]);
    res.json(rows);
  });

  router.post("/classes", async (req, res) => {
    const T = req.tid, c = await schoolClass(req.body?.name);
    if (c.errors.length) return res.status(400).json({ error: "invalid", errors: c.errors });
    const out = await inTransaction(async q => {
      const { rowCount } = await q.query("INSERT INTO classes (teacher_id, name, year, grade, section, track) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
        [T, c.name, school.currentYear(), c.grade, c.section, c.track]);
      if (!rowCount) return { rollback: true };
      await freeName(q, T, c.name);
      await log(q, T, "class_add", null, { name: c.name, track: c.track });
    });
    if (out?.rollback) return res.status(409).json({ error: "exists", errors: [`${c.name} موجود`] });
    res.json({ name: c.name, count: 0 });
  });

  // A new grade or section renames the class, keeping an unstructured old name ("1") as an alias.
  // Onto a class that exists, it merges the two. The same grade and section only changes the track.
  router.put("/classes/:name", async (req, res) => {
    const T = req.tid, from = req.params.name, c = await schoolClass(req.body?.name);
    if (c.errors.length) return res.status(400).json({ error: "invalid", errors: c.errors });
    const out = await inTransaction(async q => {
      await syncClasses(q, T);
      const old = (await q.query("SELECT * FROM classes WHERE teacher_id = $1 AND name = $2 FOR UPDATE", [T, from])).rows[0];
      if (!old) return { rollback: true };
      if (c.name === from) {
        if (old.track !== c.track) {
          await q.query("UPDATE classes SET track = $3 WHERE teacher_id = $1 AND name = $2", [T, from, c.track]);
          await log(q, T, "class_track", null, { name: from, from: old.track, to: c.track });
        }
        return { moved: 0, name: from };
      }
      const target = (await q.query("SELECT track FROM classes WHERE teacher_id = $1 AND name = $2 FOR UPDATE", [T, c.name])).rows[0];
      const aliases = [...old.aliases, ...(grades.Report.classParts(from) ? [] : [from])];
      await q.query("DELETE FROM classes WHERE teacher_id = $1 AND name = $2", [T, from]);
      if (target) await q.query("UPDATE classes SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $3::text[])) WHERE teacher_id = $1 AND name = $2", [T, c.name, aliases]);
      else await q.query("INSERT INTO classes (teacher_id, name, year, grade, section, track, aliases, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [T, c.name, old.year ?? school.currentYear(), c.grade, c.section, c.track, aliases, old.created_at]);
      await freeName(q, T, c.name);
      const ld = school.isLdGroup(from);
      const moved = (await q.query(`UPDATE students SET class = $2${ld ? ", learning_difficulty = true" : ""} WHERE teacher_id = $1 AND class = $3`, [T, c.name, from])).rowCount;
      await log(q, T, "class_rename", null, { from, to: c.name, students: moved, merged: !!target, track: target ? target.track : c.track, learning_difficulty: ld && moved > 0 });
      return { moved, name: c.name, merged: !!target };
    });
    if (out?.rollback) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, ...out });
  });

  router.delete("/classes/:name", async (req, res) => {
    const T = req.tid;
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM students WHERE teacher_id = $1 AND class = $2", [T, req.params.name]);
    if (rows[0].n) return res.status(409).json({ error: "not_empty", errors: ["انقلي طالبات الفصل أولاً"] });
    await pool.query("DELETE FROM classes WHERE teacher_id = $1 AND name = $2", [T, req.params.name]);
    await log(pool, T, "class_delete", null, { name: req.params.name });
    res.json({ ok: true });
  });

  router.get("/backups", async (req, res) => {
    const { rows } = await pool.query("SELECT id, created_at, note, jsonb_array_length(data) AS count FROM backups WHERE teacher_id = $1 ORDER BY id DESC LIMIT 30", [req.tid]);
    res.json(rows);
  });

  // Restoring brings back one teacher's students as they were; the other teachers' are not touched.
  router.post("/backups/:id/restore", async (req, res) => {
    const T = req.tid;
    const out = await inTransaction(async client => {
      const b = await client.query("SELECT data FROM backups WHERE teacher_id = $1 AND id = $2", [T, Number(req.params.id) || 0]);
      if (!b.rows.length) return { rollback: true };
      await backup(client, T, "قبل استرجاع نسخة احتياطية", await studentsOf(client, T));
      await client.query("DELETE FROM students WHERE teacher_id = $1", [T]);
      for (const s of b.rows[0].data) await insertStudent(client, T, s);
      await syncClasses(client, T);
      await log(client, T, "restore", null, { backup: Number(req.params.id) });
      return { count: b.rows[0].data.length };
    });
    if (out?.rollback) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, count: out.count });
  });

  // ---------- The school's lists and settings (the platform admin) ----------
  const schoolClasses = () => pool.query(`SELECT sc.name, sc.grade, sc.section, sc.track,
      coalesce(array_agg(t.name ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS teachers,
      (SELECT count(DISTINCT s.national_id)::int FROM students s WHERE s.class = sc.name) AS students
    FROM school_classes sc LEFT JOIN classes c ON c.name = sc.name LEFT JOIN teachers t ON t.id = c.teacher_id
    GROUP BY sc.name ORDER BY sc.grade, sc.section`).then(r => r.rows);
  const subjectList = () => pool.query(`SELECT s.name, coalesce(array_agg(t.name ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}') AS teachers
    FROM subjects s LEFT JOIN teachers t ON t.subject = s.name GROUP BY s.name ORDER BY s.name`).then(r => r.rows);
  const addSubject = (q, name) => (name ? q.query("INSERT INTO subjects (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]) : null);

  // What a teacher picks from: the school's classes and subjects.
  router.get("/catalog", async (req, res) => {
    const [classes, subjects] = await Promise.all([pool.query("SELECT name, grade, section, track FROM school_classes ORDER BY grade, section"),
      pool.query("SELECT name FROM subjects ORDER BY name")]);
    res.json({ classes: classes.rows, subjects: subjects.rows.map(r => r.name) });
  });

  router.get("/school/settings", adminOnly, (req, res) => res.json(getSchool()));
  router.put("/school/settings", adminOnly, async (req, res) => {
    const b = req.body || {}, before = getSchool();
    const next = {
      principal_name: norm(b.principal_name ?? before.principal_name).slice(0, 80),
      site_open: b.site_open === undefined ? before.site_open : b.site_open !== false,
      site_closed_message: norm(b.site_closed_message ?? before.site_closed_message).slice(0, 200) || DEFAULTS.site_closed_message,
    };
    if (!next.principal_name) return res.status(400).json({ error: "invalid", errors: ["اسم المديرة مطلوب"] });
    const changes = Object.keys(next).filter(k => before[k] !== next[k]).map(k => ({ field: k, from: before[k], to: next[k] }));
    await saveSchool(pool, next);
    if (changes.length) await log(pool, null, "school_settings", null, changes);
    res.json(getSchool());
  });

  // Every teacher at a glance: her classes, students, average and lookups. Names and numbers only, no student's grades.
  // The admin's home, and the principal's too (she reads it and opens any teacher's panel from it).
  router.get("/school/overview", (req, res, next) => (req.role === "teacher" ? res.status(403).json({ error: "forbidden" }) : next()), async (req, res) => {
    // A teacher's other subjects show as rows of their own; her sign-in is on her first one.
    const teachers = (await pool.query(`SELECT t.id, t.name, t.subject, t.active, coalesce(o.last_login, t.last_login) AS last_login,
        coalesce(o.pw_hash, t.pw_hash) IS NOT NULL AS has_password,
        (SELECT count(*)::int FROM classes c WHERE c.teacher_id = t.id) AS classes,
        (SELECT count(*)::int FROM lookups l WHERE l.teacher_id = t.id AND l.kind = 'view') AS lookups
      FROM teachers t LEFT JOIN teachers o ON o.id = t.owner_id ORDER BY coalesce(t.owner_id, t.id), t.id`)).rows;
    const rows = (await pool.query("SELECT teacher_id, test1, test2, test_avg, participation, projects, homework, final_exam, learning_difficulty FROM students")).rows;
    // Fewer graded students than a class average needs would give away a grade: no average then.
    for (const t of teachers) {
      const mine = rows.filter(r => r.teacher_id === t.id), max = maxOf(getSettings(t.id));
      const pcts = mine.filter(r => !r.learning_difficulty).map(r => grades.Report.scores(r, max).pct).filter(p => p != null);
      Object.assign(t, { students: mine.length, avg: pcts.length >= grades.Report.MIN_CLASS ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
        open: getSettings(t.id).lookup_open });
    }
    const totals = (await pool.query(`SELECT (SELECT count(DISTINCT national_id)::int FROM students) AS students,
      (SELECT count(*)::int FROM school_classes) AS classes, (SELECT count(*)::int FROM subjects) AS subjects,
      (SELECT count(*)::int FROM lookups WHERE kind = 'view' AND created_at > now() - interval '7 days') AS week`)).rows[0];
    res.json({ teachers, totals, settings: getSchool() });
  });

  router.get("/school/classes", adminOnly, async (req, res) => res.json({ classes: await schoolClasses(), subjects: await subjectList() }));

  router.post("/school/classes", adminOnly, async (req, res) => {
    const c = classOf(req.body);
    if (c.errors.length) return res.status(400).json({ error: "invalid", errors: c.errors });
    const { rowCount } = await pool.query("INSERT INTO school_classes (name, grade, section, track) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [c.name, c.grade, c.section, c.track]);
    if (!rowCount) return res.status(409).json({ error: "exists", errors: [`${c.name} موجود`] });
    await log(pool, null, "school_class_add", null, { name: c.name, track: c.track });
    res.json({ name: c.name });
  });

  // Only the track changes; every teacher's copy of the class follows it.
  router.put("/school/classes/:name", adminOnly, async (req, res) => {
    const old = (await pool.query("SELECT * FROM school_classes WHERE name = $1", [req.params.name])).rows[0];
    if (!old) return res.status(404).json({ error: "not_found" });
    const track = old.grade === 1 ? null : norm(req.body?.track);
    if (old.grade > 1 && !school.TRACKS.includes(track)) return res.status(400).json({ error: "invalid", errors: ["اختر المسار"] });
    await inTransaction(async q => {
      await q.query("UPDATE school_classes SET track = $2 WHERE name = $1", [old.name, track]);
      await q.query("UPDATE classes SET track = $2 WHERE name = $1", [old.name, track]);
      await log(q, null, "school_class_track", null, { name: old.name, from: old.track, to: track });
    });
    res.json({ ok: true });
  });

  router.delete("/school/classes/:name", adminOnly, async (req, res) => {
    const used = (await pool.query("SELECT t.name FROM classes c JOIN teachers t ON t.id = c.teacher_id WHERE c.name = $1", [req.params.name])).rows;
    if (used.length) return res.status(409).json({ error: "in_use", errors: [`الفصل عند: ${used.map(r => r.name).join("، ")}`] });
    const { rowCount } = await pool.query("DELETE FROM school_classes WHERE name = $1", [req.params.name]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    await log(pool, null, "school_class_delete", null, { name: req.params.name });
    res.json({ ok: true });
  });

  router.post("/school/subjects", adminOnly, async (req, res) => {
    const name = norm(req.body?.name).slice(0, 40);
    if (!name) return res.status(400).json({ error: "invalid", errors: ["اكتب اسم المادة"] });
    const { rowCount } = await pool.query("INSERT INTO subjects (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
    if (!rowCount) return res.status(409).json({ error: "exists", errors: [`${name} موجودة`] });
    await log(pool, null, "subject_add", null, { name });
    res.json({ name });
  });

  router.delete("/school/subjects/:name", adminOnly, async (req, res) => {
    const used = listTeachers().filter(t => t.subject === req.params.name);
    if (used.length) return res.status(409).json({ error: "in_use", errors: [`المادة عند: ${used.map(t => t.name).join("، ")}`] });
    const { rowCount } = await pool.query("DELETE FROM subjects WHERE name = $1", [req.params.name]);
    if (!rowCount) return res.status(404).json({ error: "not_found" });
    await log(pool, null, "subject_delete", null, { name: req.params.name });
    res.json({ ok: true });
  });

  // ---------- School staff (the platform admin only) ----------
  // A teacher signs in with her email.
  const userOf = t => t.email || null;
  const credentials = (t, password) => ({ id: t.id, name: t.name,
    subject: (t.subjects || panelsOf(t.id).map(p => p.subject).filter(Boolean)).join("، "), user: userOf(t), phone: t.phone, wa: staff.waNumber(t.phone), password });
  // Another teacher already has this email, ID or mobile.
  const taken = async (t, except = 0) => (await pool.query(
    `SELECT name FROM teachers WHERE id <> $1 AND ((email IS NOT NULL AND email = $4)
      OR (national_id IS NOT NULL AND national_id = $2) OR (phone IS NOT NULL AND phone = $3))`,
    [except, t.national_id, t.phone, t.email])).rows[0]?.name;
  const takenMsg = name => [`الإيميل أو رقم الهوية أو الجوال مسجّل للمعلمة ${name}`];
  const hasData = async (q, id) => Number((await q.query(`SELECT (SELECT count(*) FROM students WHERE teacher_id = $1)
    + (SELECT count(*) FROM classes WHERE teacher_id = $1) + (SELECT count(*) FROM terms WHERE teacher_id = $1) AS n`, [id])).rows[0].n) > 0;
  const refuse = (status, msg) => Object.assign(new Error(msg), { status, errors: [msg] });
  // A teacher's subjects, a panel each. A panel keeps its subject while it is still on the list; one taken off the
  // list takes a new subject from it (its classes and students go with it), else it goes, if nothing is saved under it.
  async function syncSubjects(q, id, subjects) {
    const rows = (await q.query("SELECT id, name, subject, active FROM teachers WHERE id = $1 OR owner_id = $1 ORDER BY owner_id IS NOT NULL, id", [id])).rows;
    const want = subjects.filter(s => !rows.some(r => r.subject === s));
    for (const r of rows) {
      if (r.subject && subjects.includes(r.subject)) continue;
      if (want.length) await q.query("UPDATE teachers SET subject = $2 WHERE id = $1", [r.id, want.shift()]);
      else if (r.id === id) await q.query("UPDATE teachers SET subject = NULL WHERE id = $1", [id]);
      else if (await hasData(q, r.id)) throw refuse(409, `مادة ${r.subject} عندها فصول أو طالبات، فما تنشال من المعلمة.`);
      else await q.query("DELETE FROM teachers WHERE id = $1", [r.id]);
    }
    for (const s of want) await q.query("INSERT INTO teachers (name, subject, owner_id, active, settings) VALUES ($1, $2, $3, $4, '{}')", [rows[0].name, s, id, rows[0].active]);
    for (const s of subjects) await addSubject(q, s);
  }
  // A new password ends the teacher's old sessions. It is shown once and only its hash is kept.
  async function issuePassword(q, id) {
    const password = staff.newPassword();
    const h = await staff.hashPassword(password);
    await q.query("UPDATE teachers SET pw_salt = $2, pw_hash = $3, pw_ver = pw_ver + 1 WHERE id = $1", [id, h.salt, h.hash]);
    return password;
  }

  router.get("/staff", adminOnly, async (req, res) => {
    // One row a teacher, with all her subjects and what is saved under any of them.
    const { rows } = await pool.query(`SELECT t.id, t.name, t.subject, t.email, t.national_id, t.phone, t.active, t.pw_hash IS NOT NULL AS has_password, t.last_login, t.created_at,
        coalesce((SELECT array_agg(p.subject ORDER BY p.owner_id IS NOT NULL, p.id) FROM teachers p WHERE (p.id = t.id OR p.owner_id = t.id) AND p.subject IS NOT NULL), '{}') AS subjects,
        (SELECT count(*)::int FROM students s JOIN teachers p ON p.id = s.teacher_id WHERE p.id = t.id OR p.owner_id = t.id) AS students,
        (SELECT count(*)::int FROM classes c JOIN teachers p ON p.id = c.teacher_id WHERE p.id = t.id OR p.owner_id = t.id) AS classes
      FROM teachers t WHERE t.owner_id IS NULL ORDER BY t.id`);
    res.json({ teachers: rows.map(t => ({ ...t, user: userOf(t), wa: staff.waNumber(t.phone) })), viewer: !!viewer.hash });
  });

  router.post("/staff", adminOnly, async (req, res) => {
    const { teacher: t, errors } = staff.cleanTeacher(req.body || {});
    if (errors.length) return res.status(400).json({ error: "invalid", errors });
    const other = await taken(t);
    if (other) return res.status(409).json({ error: "exists", errors: takenMsg(other) });
    const out = await inTransaction(async q => {
      const { rows } = await q.query("INSERT INTO teachers (name, subject, national_id, phone, email, settings) VALUES ($1, $2, $3, $4, $5, '{}') RETURNING *",
        [t.name, t.subject, t.national_id, t.phone, t.email]);
      const password = await issuePassword(q, rows[0].id);
      await syncSubjects(q, rows[0].id, t.subjects);
      await log(q, null, "staff_add", null, { id: rows[0].id, name: t.name });
      return credentials({ ...rows[0], subjects: t.subjects }, password);
    });
    await reloadTeachers(pool);
    res.json(out);
  });

  router.put("/staff/:id", adminOnly, async (req, res) => {
    const id = Number(req.params.id), cur = getTeacher(id);
    if (!cur || cur.owner_id) return res.status(404).json({ error: "not_found" });
    const subjects = req.body?.subjects ?? panelsOf(id).map(p => p.subject).filter(Boolean);
    const { teacher: t, errors } = staff.cleanTeacher({ ...cur, ...req.body, subjects });
    if (errors.length) return res.status(400).json({ error: "invalid", errors });
    const other = await taken(t, id);
    if (other) return res.status(409).json({ error: "exists", errors: takenMsg(other) });
    const active = req.body?.active === undefined ? cur.active : req.body.active !== false;
    // Turning an account off ends its sessions.
    // A new email also ends her sessions: she signs in with it.
    // Her other subjects' panels carry her name and go on or off with her.
    await inTransaction(async q => {
      await q.query("UPDATE teachers SET name = $2, national_id = $3, phone = $4, email = $7, active = $5, pw_ver = pw_ver + $6 WHERE id = $1",
        [id, t.name, t.national_id, t.phone, active, (cur.active && !active) || cur.email !== t.email ? 1 : 0, t.email]);
      await q.query("UPDATE teachers SET name = $2, active = $3 WHERE owner_id = $1", [id, t.name, active]);
      await syncSubjects(q, id, t.subjects);
      await log(q, null, "staff_edit", null, { id, name: t.name, active, subjects: t.subjects });
    });
    await reloadTeachers(pool);
    res.json({ ok: true });
  });

  router.post("/staff/:id/password", adminOnly, async (req, res) => {
    const id = Number(req.params.id);
    if (!getTeacher(id) || getTeacher(id).owner_id) return res.status(404).json({ error: "not_found" });
    if (!getTeacher(id).email) return res.status(400).json({ error: "no_email", errors: ["أضيفي إيميل المعلمة أول، تدخل فيه"] });
    const password = await issuePassword(pool, id);
    await log(pool, null, "staff_password", null, { id, name: getTeacher(id).name });
    await reloadTeachers(pool);
    res.json(credentials(getTeacher(id), password));
  });

  // Only an account with nothing saved under it can go; one with data is turned off instead.
  router.delete("/staff/:id", adminOnly, async (req, res) => {
    const id = Number(req.params.id), t = getTeacher(id);
    if (!t || t.owner_id) return res.status(404).json({ error: "not_found" });
    for (const p of panelsOf(id)) {
      if (await hasData(pool, p.id)) return res.status(409).json({ error: "has_data", errors: ["المعلمة عندها فصول أو طالبات، فيُوقف حسابها بدل الحذف."] });
    }
    await inTransaction(async q => {
      await q.query("DELETE FROM teachers WHERE owner_id = $1", [id]);
      await q.query("DELETE FROM teachers WHERE id = $1", [id]);
    });
    await log(pool, null, "staff_delete", null, { id, name: t.name });
    await reloadTeachers(pool);
    res.json({ ok: true });
  });

  // A staff sheet is previewed like a students sheet. Teachers match on their email, else their ID or mobile.
  router.post("/staff/import", adminOnly, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    let rows;
    try {
      rows = await staff.readStaffSheet(req.file.path);
    } catch (err) {
      console.error(err);
      return res.status(400).json({ error: "unreadable" });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
    if (!rows) return res.status(400).json({ error: "no_table" });
    const all = listTeachers().filter(t => !t.owner_id);
    const subjectsOf = id => panelsOf(id).map(p => p.subject).filter(Boolean);
    const added = [], changed = [], errors = [], seen = new Set();
    let unchanged = 0;
    for (const { line, raw } of rows) {
      const { teacher: t, errors: errs } = staff.cleanTeacher(raw);
      const keys = [t.email, t.national_id, t.phone].filter(Boolean);
      for (const k of keys) { if (seen.has(k)) errs.push("مكررة في الملف"); }
      if (errs.length) { errors.push({ line, name: t.name || norm(raw.name), problems: [...new Set(errs)] }); continue; }
      keys.forEach(k => seen.add(k));
      const before = all.find(x => x.email === t.email) || all.find(x => (t.national_id && x.national_id === t.national_id) || (t.phone && x.phone === t.phone));
      const other = all.find(x => x.id !== before?.id && (x.email === t.email || (t.national_id && x.national_id === t.national_id) || (t.phone && x.phone === t.phone)));
      if (other) { errors.push({ line, name: t.name, problems: takenMsg(other.name) }); continue; }
      if (!before) { added.push(t); continue; }
      // As with students, an empty cell keeps what is saved.
      const had = subjectsOf(before.id), subjects = t.subjects.length ? t.subjects : had;
      const was = { ...before, subject: had.join("، ") };
      const next = { name: t.name, subject: subjects.join("، "), subjects, email: t.email, national_id: t.national_id ?? before.national_id, phone: t.phone ?? before.phone };
      // The same subjects in another order are no change.
      if ([...subjects].sort().join() === [...had].sort().join()) next.subject = was.subject;
      const changes = ["name", "subject", "email", "national_id", "phone"].filter(k => (next[k] || null) !== (was[k] || null))
        .map(k => ({ field: k, from: was[k], to: next[k] }));
      if (changes.length) changed.push({ id: before.id, name: before.name, next, changes }); else unchanged++;
    }
    const token = keepPreview({ kind: "staff", tid: req.tid, added, changed });
    res.json({ token, fileName: Buffer.from(req.file.originalname, "latin1").toString("utf8"), totalRows: rows.length, added, changed, unchanged, errors });
  });

  // New teachers get their passwords here, returned once for the admin to hand out.
  router.post("/staff/import/:token/apply", adminOnly, async (req, res) => {
    const p = takePreview(req, "staff");
    if (!p) return res.status(410).json({ error: "expired" });
    const issued = await inTransaction(async q => {
      const out = [];
      for (const c of p.changed) {
        await q.query("UPDATE teachers SET name = $2, national_id = $3, phone = $4, email = $5, pw_ver = pw_ver + $6 WHERE id = $1",
          [c.id, c.next.name, c.next.national_id, c.next.phone, c.next.email, c.changes.some(x => x.field === "email") ? 1 : 0]);
        await q.query("UPDATE teachers SET name = $2 WHERE owner_id = $1", [c.id, c.next.name]);
        await syncSubjects(q, c.id, c.next.subjects);
      }
      for (const t of p.added) {
        const { rows } = await q.query("INSERT INTO teachers (name, subject, national_id, phone, email, settings) VALUES ($1, $2, $3, $4, $5, '{}') RETURNING *",
          [t.name, t.subject, t.national_id, t.phone, t.email]);
        out.push(credentials({ ...rows[0], subjects: t.subjects }, await issuePassword(q, rows[0].id)));
        await syncSubjects(q, rows[0].id, t.subjects);
      }
      await log(q, null, "staff_import", null, { added: p.added.length, changed: p.changed.length });
      return out;
    });
    await reloadTeachers(pool);
    res.json({ ok: true, issued, changed: p.changed.length });
  });

  router.use((err, req, res, next) => {
    if (err.status && err.errors) return res.status(err.status).json({ error: "refused", errors: err.errors });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "too_large" : "upload_failed" });
    // Two teachers can't share an ID or a mobile; a race past the check above lands here.
    if (err.code === "23505" && /teachers_/.test(err.constraint || "")) return res.status(409).json({ error: "exists", errors: ["رقم الهوية أو الجوال مسجّل لمعلمة ثانية"] });
    console.error(err);
    res.status(500).json({ error: "server_error" });
  });

  app.use("/api/admin", router);
  app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

  return loadViewer();
};

module.exports.SCHEMA = ADMIN_SCHEMA;
