// Site settings the teacher edits from the panel. One JSON row, cached in memory (single instance).
const DEFAULTS = {
  grade_label: "الصف الثاني",
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

let current = { ...DEFAULTS };

async function loadSettings(pool) {
  await pool.query(SCHEMA);
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'site'");
  current = { ...DEFAULTS, ...(rows[0]?.value || {}) };
  return current;
}

async function saveSettings(pool, next) {
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('site', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [JSON.stringify(next)]);
  current = { ...DEFAULTS, ...next };
  return current;
}

const getSettings = () => current;
const maxOf = s => ({ test: s.max_test, participation: s.max_participation, projects: s.max_projects });

module.exports = { DEFAULTS, loadSettings, saveSettings, getSettings, maxOf };
