// Settings, cached in memory (single instance). The school's own (the principal's name) are one JSON row; each teacher
// keeps hers on her row in `teachers`: her name and subject in their columns, the rest in `settings`.
const { STAGE } = require("./school");

const DEFAULTS = {
  subject: "رياضيات",
  term_title: "",
  teacher_name: "فائزة محمد جبوع",
  principal_name: "د. حنان المطيري",
  max_test: 20,
  max_participation: 10,
  max_projects: 10,
  // Empty until the teacher sets them: homework and the final exam stay out of the percentage until then.
  max_homework: null,
  max_final: null,
  // How a student's card compares her with the class average: "bars", "pie" or "table" (CHARTS in public/report.js).
  compare_chart: "bars",
  lookup_open: true,
  closed_message: "النتائج غير متاحة حالياً، ترقّبي إعلانها قريباً.",
};
const SCHOOL_KEYS = ["principal_name"];
// What a teacher's `settings` column holds; her name and subject have columns of their own.
const TEACHER_KEYS = ["term_title", "max_test", "max_participation", "max_projects", "max_homework", "max_final", "compare_chart", "lookup_open", "closed_message"];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// The stage is fixed and the teacher names her subject; the line on the cards and PDFs is built from both.
const withLabel = s => ({ ...s, grade_label: [STAGE, s.subject].filter(Boolean).join(" · ") });
let school = pick(DEFAULTS, SCHOOL_KEYS);
const teachers = new Map();

const merged = t => withLabel({ ...DEFAULTS, ...(t?.settings || {}), teacher_name: t?.name ?? "", subject: t?.subject ?? "", ...school });

async function loadSettings(pool) {
  await pool.query(SCHEMA);
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'site'");
  const saved = { ...(rows[0]?.value || {}) };
  // Before the stage was fixed the subject was typed into the grade label, as in "المرحلة الثانوية - رياضيات".
  if (saved.subject === undefined && saved.grade_label) saved.subject = saved.grade_label.split(/\s[-–]\s/).slice(1).join(" - ").trim();
  school = { ...pick(DEFAULTS, SCHOOL_KEYS), ...pick(saved, SCHOOL_KEYS) };
  // Before there were several teachers, the first one's settings were the site's. They move to her row once.
  const first = await pool.query("SELECT id FROM teachers WHERE settings IS NULL ORDER BY id LIMIT 1");
  if (first.rowCount) {
    const id = first.rows[0].id;
    await pool.query("UPDATE teachers SET settings = $2, name = $3, subject = $4 WHERE id = $1",
      [id, JSON.stringify(pick({ ...DEFAULTS, ...saved }, TEACHER_KEYS)), saved.teacher_name || DEFAULTS.teacher_name, saved.subject ?? DEFAULTS.subject]);
  }
  await reloadTeachers(pool);
}

async function reloadTeachers(pool) {
  const { rows } = await pool.query("SELECT * FROM teachers ORDER BY id");
  teachers.clear();
  for (const t of rows) teachers.set(t.id, t);
}

// A teacher's settings with the school's, in the shape the panel and the cards have always read.
const getSettings = tid => merged(teachers.get(tid));
const getTeacher = tid => teachers.get(tid) || null;
const listTeachers = () => [...teachers.values()];
const getSchool = () => ({ ...school });

// Saves what belongs to the teacher on her row, and the school's part only when `withSchool` (the platform admin).
async function saveSettings(pool, tid, next, { withSchool = false } = {}) {
  const t = teachers.get(tid);
  await pool.query("UPDATE teachers SET settings = $2, name = $3, subject = $4 WHERE id = $1",
    [tid, JSON.stringify(pick({ ...DEFAULTS, ...(t?.settings || {}), ...next }, TEACHER_KEYS)), next.teacher_name ?? t?.name, next.subject ?? t?.subject ?? ""]);
  if (withSchool) {
    const value = { ...school, ...pick(next, SCHOOL_KEYS) };
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('site', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [JSON.stringify(value)]);
    school = value;
  }
  await reloadTeachers(pool);
  return getSettings(tid);
}

const maxOf = s => ({ test: s.max_test, participation: s.max_participation, projects: s.max_projects, homework: s.max_homework || null, final: s.max_final || null });
// A title the teacher typed wins; otherwise the period is named after the open semester in the calendar.
const termTitleOf = (s, cal) => s.term_title || cal?.current.title || "";

module.exports = { DEFAULTS, SCHOOL_KEYS, TEACHER_KEYS, loadSettings, reloadTeachers, saveSettings, getSettings, getTeacher, listTeachers, getSchool, maxOf, termTitleOf };
