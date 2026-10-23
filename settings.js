// Site settings the teacher edits from the panel. One JSON row, cached in memory (single instance).
const { STAGE } = require("./school");

const DEFAULTS = {
  subject: "رياضيات",
  term_title: "",
  teacher_name: "فائزة محمد جبوع",
  principal_name: "د. حنان المطيري",
  max_test: 20,
  max_participation: 10,
  max_projects: 10,
  lookup_open: true,
  closed_message: "النتائج غير متاحة حالياً، ترقّبي إعلانها قريباً.",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// The stage is fixed and the teacher names her subject; the line on the cards and PDFs is built from both.
const withLabel = s => ({ ...s, grade_label: [STAGE, s.subject].filter(Boolean).join(" · ") });
let current = withLabel({ ...DEFAULTS });

async function loadSettings(pool) {
  await pool.query(SCHEMA);
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'site'");
  const saved = { ...(rows[0]?.value || {}) };
  // Before the stage was fixed the subject was typed into the grade label, as in "المرحلة الثانوية - رياضيات".
  if (saved.subject === undefined && saved.grade_label) saved.subject = saved.grade_label.split(/\s[-–]\s/).slice(1).join(" - ").trim();
  delete saved.grade_label;
  current = withLabel({ ...DEFAULTS, ...saved });
  return current;
}

async function saveSettings(pool, next) {
  const { grade_label, ...value } = next;
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('site', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [JSON.stringify(value)]);
  current = withLabel({ ...DEFAULTS, ...value });
  return current;
}

const getSettings = () => current;
const maxOf = s => ({ test: s.max_test, participation: s.max_participation, projects: s.max_projects });
// A title the teacher typed wins; otherwise the period is named after the open semester in the calendar.
const termTitleOf = (s, cal) => s.term_title || cal?.current.title || "";

module.exports = { DEFAULTS, loadSettings, saveSettings, getSettings, maxOf, termTitleOf };
