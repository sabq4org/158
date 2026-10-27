// The school's teachers. Each one has her own panel: her classes, students, archives, backups and log are hers alone,
// tied to her by teacher_id. Everything saved before there were several teachers belongs to the first one (id 1).
const crypto = require("crypto");
const util = require("util");
const ExcelJS = require("exceljs");
const school = require("./school");

const scrypt = util.promisify(crypto.scrypt);

// Run after every other table exists. Each step is safe to run again.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS teachers (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  subject      TEXT,
  national_id  TEXT,
  phone        TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  pw_salt      TEXT,
  pw_hash      TEXT,
  pw_ver       INT NOT NULL DEFAULT 0,
  settings     JSONB,
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_national_id ON teachers (national_id) WHERE national_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teachers_phone ON teachers (phone) WHERE phone IS NOT NULL;
INSERT INTO teachers (id, name) VALUES (1, 'فائزة محمد جبوع') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('teachers', 'id'), (SELECT max(id) FROM teachers));

-- Rows saved before there were several teachers are the first one's. The default is dropped right after,
-- so a write that forgets the teacher fails instead of landing in her panel.
ALTER TABLE students ADD COLUMN IF NOT EXISTS teacher_id INT NOT NULL DEFAULT 1;
ALTER TABLE students ALTER COLUMN teacher_id DROP DEFAULT;
ALTER TABLE classes ADD COLUMN IF NOT EXISTS teacher_id INT NOT NULL DEFAULT 1;
ALTER TABLE classes ALTER COLUMN teacher_id DROP DEFAULT;
ALTER TABLE terms ADD COLUMN IF NOT EXISTS teacher_id INT NOT NULL DEFAULT 1;
ALTER TABLE terms ALTER COLUMN teacher_id DROP DEFAULT;
ALTER TABLE backups ADD COLUMN IF NOT EXISTS teacher_id INT NOT NULL DEFAULT 1;
ALTER TABLE backups ALTER COLUMN teacher_id DROP DEFAULT;
ALTER TABLE lookups ADD COLUMN IF NOT EXISTS teacher_id INT NOT NULL DEFAULT 1;
ALTER TABLE lookups ALTER COLUMN teacher_id DROP DEFAULT;
-- The log also keeps the school's own changes (the calendar, the staff), with no teacher.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS teacher_id INT DEFAULT 1;
ALTER TABLE audit_log ALTER COLUMN teacher_id DROP DEFAULT;

-- A student taught by two teachers has a row with each; two teachers may each have a class with the same name.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname = 'students' AND i.indisprimary AND i.indnatts = 1) THEN
    ALTER TABLE students DROP CONSTRAINT students_pkey;
    ALTER TABLE students ADD PRIMARY KEY (teacher_id, national_id);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname = 'classes' AND i.indisprimary AND i.indnatts = 1) THEN
    ALTER TABLE classes DROP CONSTRAINT classes_pkey;
    ALTER TABLE classes ADD PRIMARY KEY (teacher_id, name);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS students_national_id ON students (national_id);
CREATE INDEX IF NOT EXISTS lookups_teacher ON lookups (teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_teacher ON audit_log (teacher_id, id DESC);`;

// ---------- Passwords ----------
// Eight digits: easy to read out or type on a phone. Logins are rate limited per device and per account.
const newPassword = () => String(crypto.randomInt(0, 1e8)).padStart(8, "0");
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: (await scrypt(pw, salt, 32)).toString("hex") };
}
async function checkPassword(t, pw) {
  if (!t?.pw_hash || !pw) return false;
  return crypto.timingSafeEqual(await scrypt(pw, t.pw_salt, 32), Buffer.from(t.pw_hash, "hex"));
}

// ---------- Identifiers ----------
const digits = s => school.toLatin(String(s ?? "")).replace(/\D/g, "");
// Saudi mobiles in any of their usual forms (+966 5…, 00966 5…, 5…, 05…) become 05XXXXXXXX.
function phoneOf(s) {
  let d = digits(s);
  if (d.startsWith("00966")) d = d.slice(5); else if (d.startsWith("966")) d = d.slice(3);
  if (d.length === 9 && d.startsWith("5")) d = "0" + d;
  return /^05\d{8}$/.test(d) ? d : null;
}
// International form for a WhatsApp link.
const waNumber = phone => (phone ? "966" + phone.slice(1) : null);
const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();

// A teacher from a form or a sheet row. Either her ID or her mobile is needed: she signs in with one of them.
function cleanTeacher(raw) {
  const errors = [];
  const t = { name: norm(raw.name).slice(0, 80), subject: norm(raw.subject).slice(0, 40) || null };
  if (!t.name) errors.push("الاسم مطلوب");
  const id = digits(raw.national_id);
  t.national_id = id || null;
  if (id && id.length !== 10) errors.push("رقم الهوية لازم يكون 10 أرقام");
  const phoneText = norm(raw.phone);
  t.phone = phoneText ? phoneOf(phoneText) : null;
  if (phoneText && !t.phone) errors.push(`رقم الجوال "${phoneText}" غير صحيح`);
  if (!t.national_id && !t.phone) errors.push("لازم رقم الهوية أو الجوال عشان تدخل فيه");
  return { teacher: t, errors };
}

// ---------- Reading a staff sheet ----------
const plainKey = s => school.plain(norm(s)).replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
const HEADER_MAP = {
  "الاسم": "name", "اسم المعلمة": "name", "اسم المعلم": "name", "اسم الموظفة": "name", "اسم الموظف": "name", "الاسم الكامل": "name", "اسم المنسوبة": "name",
  "رقم الهوية": "national_id", "الهوية": "national_id", "السجل المدني": "national_id", "رقم السجل المدني": "national_id", "الهوية الوطنية": "national_id", "رقم الهوية الوطنية": "national_id",
  "الجوال": "phone", "رقم الجوال": "phone", "الهاتف": "phone", "رقم الهاتف": "phone", "الجوال الشخصي": "phone", "رقم التواصل": "phone",
  "المادة": "subject", "التخصص": "subject", "مادة التدريس": "subject", "المادة الدراسية": "subject", "التخصص الدقيق": "subject",
};
const HEADERS = Object.fromEntries(Object.entries(HEADER_MAP).map(([k, f]) => [plainKey(k), f]));

function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map(t => t.text).join("");
    if ("result" in v) return cellText(v.result);
    if (v.text != null) return String(v.text);
    return "";
  }
  return String(v);
}

// The first sheet with a name column and an ID or mobile column. Rows stop at the first long gap.
async function readStaffSheet(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  for (const ws of wb.worksheets) {
    let cols = null, gap = 0;
    const rows = [];
    for (let r = 1; r <= Math.min(ws.rowCount, 2000); r++) {
      const values = ws.getRow(r).values || [];
      if (!cols) {
        const found = {};
        values.forEach((v, i) => { const f = HEADERS[plainKey(cellText(v))]; if (f && !(f in found)) found[f] = i; });
        if ("name" in found && ("national_id" in found || "phone" in found)) cols = found;
        if (r > 50 && !cols) break;
        continue;
      }
      const raw = {};
      for (const [f, i] of Object.entries(cols)) raw[f] = cellText(values[i]);
      if (!norm(raw.name) && !norm(raw.national_id) && !norm(raw.phone)) { if (rows.length && ++gap >= 5) break; continue; }
      gap = 0;
      rows.push({ line: r, raw });
    }
    if (cols) return rows;
  }
  return null;
}

module.exports = { SCHEMA, newPassword, hashPassword, checkPassword, digits, phoneOf, waNumber, cleanTeacher, readStaffSheet };
