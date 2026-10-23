// Numbers the lookup page and the panel both read from the database. The math itself lives in public/report.js,
// so a student online, a printed card and the teacher's panel always agree.
const Report = require("./public/report.js");
const { getSettings, maxOf } = require("./settings");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS terms (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  max         JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS term_results (
  term_id         INT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  national_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  class           TEXT,
  test1           NUMERIC,
  test2           NUMERIC,
  test_avg        NUMERIC,
  participation   NUMERIC,
  projects        NUMERIC,
  lateness        NUMERIC,
  learning_style  TEXT,
  PRIMARY KEY (term_id, national_id)
);
CREATE INDEX IF NOT EXISTS term_results_national_id ON term_results (national_id);
-- The semester an archive belongs to.
ALTER TABLE terms ADD COLUMN IF NOT EXISTS year INT;
ALTER TABLE terms ADD COLUMN IF NOT EXISTS semester INT;
ALTER TABLE term_results ADD COLUMN IF NOT EXISTS learning_difficulty BOOLEAN;`;

// Archived percentages, oldest term first. Each term keeps the maximum scores it was graded with.
// With an id: that student's list. Without: { national_id: list } for everyone.
async function history(pool, nationalId) {
  const { rows } = await pool.query(
    `SELECT r.national_id, t.title, t.max, r.test1, r.test2, r.test_avg, r.participation, r.projects
     FROM term_results r JOIN terms t ON t.id = r.term_id ${nationalId ? "WHERE r.national_id = $1" : ""} ORDER BY t.created_at, t.id`,
    nationalId ? [nationalId] : []);
  const out = {};
  for (const r of rows) (out[r.national_id] ||= []).push({ title: r.title, pct: Report.scores(r, r.max).pct });
  return nationalId ? out[nationalId] || [] : out;
}

// The class average leaves out students with learning difficulties.
async function classStats(pool, cls) {
  if (!cls) return null;
  const { rows } = await pool.query("SELECT test1, test2, test_avg, participation, projects FROM students WHERE class = $1 AND NOT learning_difficulty", [cls]);
  return Report.classStats(rows, maxOf(getSettings()));
}

module.exports = { SCHEMA, history, classStats, Report };
