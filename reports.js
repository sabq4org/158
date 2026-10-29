// The principal's reports: the school's grades compared by class and subject, and how they moved over the semester.
// Only averages leave the server, and only for groups of at least MIN_CLASS students, as on the student's card.
const { getSettings, maxOf, listTeachers } = require("./settings");
const { Report } = require("./grades");
const school = require("./school");

// One row per teacher, class and study week: how many students had a percentage that week, and their sum (0 to 1 each),
// so classes and subjects add up weighted. The row of the current week is rewritten until the week ends.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS report_weeks (
  year        INT NOT NULL,
  semester    INT NOT NULL,
  week        INT NOT NULL,
  teacher_id  INT NOT NULL,
  class       TEXT NOT NULL,
  n           INT NOT NULL,
  pct_sum     NUMERIC NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (year, semester, week, teacher_id, class)
);`;

const MIN = Report.MIN_CLASS;
const HOUR = 3600 * 1000;
const GRADE_COLS = "national_id, name, class, test1, test2, test_avg, participation, projects, homework, final_exam, learning_difficulty";
const mean = v => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
// A percentage of a group, or null when the group is too small to show one.
const avgOf = v => (v.length >= MIN ? Math.round(mean(v) * 100) : null);
const LEVELS = [["excellent", p => p >= 0.9], ["vgood", p => p >= 0.75], ["good", p => p >= 0.6], ["support", () => true]];
const levelOf = p => LEVELS.find(([, test]) => test(p))[0];
const gradeOf = name => Report.classParts(name)?.grade || null;

// This week's averages for every teacher and class, kept while the school is in a study week.
async function snapshot(pool) {
  const at = school.situation();
  if (!at?.week || at.holiday) return;
  const { rows } = await pool.query(`SELECT teacher_id, ${GRADE_COLS} FROM students WHERE NOT learning_difficulty AND class IS NOT NULL`);
  const groups = new Map();
  for (const r of rows) {
    const sc = Report.scores(r, maxOf(getSettings(r.teacher_id)));
    if (!sc.has) continue;
    const key = `${r.teacher_id}\u0000${r.class}`, g = groups.get(key) || { tid: r.teacher_id, cls: r.class, n: 0, sum: 0 };
    g.n++; g.sum += sc.total / sc.maxTotal;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    await pool.query(`INSERT INTO report_weeks (year, semester, week, teacher_id, class, n, pct_sum) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (year, semester, week, teacher_id, class) DO UPDATE SET n = EXCLUDED.n, pct_sum = EXCLUDED.pct_sum, taken_at = now()`,
      [at.year, at.semester, at.week, g.tid, g.cls, g.n, g.sum]);
  }
}

// The periods a report can cover: the grades on the panels now, and each semester some teacher archived.
async function periodsOf(pool) {
  const { rows } = await pool.query("SELECT DISTINCT year, semester FROM terms WHERE year IS NOT NULL AND semester IS NOT NULL ORDER BY year DESC, semester DESC");
  const now = school.situation();
  return [{ key: "current", title: now ? `الدرجات الحالية · ${school.semesterTitle(now.year, now.semester)}` : "الدرجات الحالية" },
    ...rows.map(r => ({ key: `${r.year}-${r.semester}`, title: `أرشيف ${school.semesterTitle(r.year, r.semester)}` }))];
}

// Every graded row of the period, one per teacher and student, with the maximum scores it was graded with.
async function recordsOf(pool, period) {
  const m = /^(\d{4})-(\d)$/.exec(period || "");
  if (!m) {
    const { rows } = await pool.query(`SELECT teacher_id, ${GRADE_COLS} FROM students`);
    return rows.map(r => ({ ...r, max: maxOf(getSettings(r.teacher_id)) }));
  }
  // A teacher who archived the same semester more than once is read from her latest archive.
  const { rows } = await pool.query(`SELECT DISTINCT ON (t.teacher_id, r.national_id) t.teacher_id, t.max, r.national_id, r.name, r.class, r.test1, r.test2,
      r.test_avg, r.participation, r.projects, r.homework, r.final_exam, coalesce(r.learning_difficulty, false) AS learning_difficulty
    FROM term_results r JOIN terms t ON t.id = r.term_id WHERE t.year = $1 AND t.semester = $2
    ORDER BY t.teacher_id, r.national_id, t.created_at DESC, t.id DESC`, [Number(m[1]), Number(m[2])]);
  return rows;
}

function build(records, teachers, f) {
  const subjectOf = tid => teachers.get(tid)?.subject || "بدون مادة";
  const list = records.filter(r => teachers.has(r.teacher_id)
    && (!f.grade || gradeOf(r.class) === f.grade)
    && (!f.subject || subjectOf(r.teacher_id) === f.subject)
    && (!f.teacher || r.teacher_id === f.teacher))
    .map(r => ({ ...r, sc: Report.scores(r, r.max), subject: subjectOf(r.teacher_id) }));
  // Students with learning difficulties are counted, but kept out of every average, as in their class.
  const counted = list.filter(r => !r.learning_difficulty && r.sc.has);
  const frac = r => r.sc.total / r.sc.maxTotal;

  // A student taught several subjects stands at the mean of her percentages, for her level and her class.
  const byStudent = new Map();
  for (const r of counted) {
    const s = byStudent.get(r.national_id) || { cls: r.class, p: [] };
    s.p.push(frac(r));
    byStudent.set(r.national_id, s);
  }
  const students = [...byStudent.values()].map(s => ({ cls: s.cls, p: mean(s.p) }));

  // Each test as a share of its own maximum; the change is from the first test to the second, over rows that have both.
  const part = (rows, get, of) => avgOf(rows.map(r => [get(r.sc), r.max[of]]).filter(([v, m]) => v != null && m > 0).map(([v, m]) => v / m));
  const both = rows => rows.filter(r => r.sc.t1 != null && r.sc.t2 != null);
  const change = rows => {
    const b = both(rows), a = part(b, s => s.t1, "test"), z = part(b, s => s.t2, "test");
    return a == null || z == null ? null : z - a;
  };

  const classNames = [...new Set(list.map(r => r.class).filter(Boolean))]
    .sort((a, b) => (gradeOf(a) || 9) - (gradeOf(b) || 9) || String(a).localeCompare(String(b), "ar", { numeric: true }));
  const subjects = [...new Set(list.map(r => r.subject))].sort((a, b) => a.localeCompare(b, "ar"));

  const classes = classNames.map(name => {
    const mine = students.filter(s => s.cls === name), dist = { excellent: 0, vgood: 0, good: 0, support: 0 };
    for (const s of mine) dist[levelOf(s.p)]++;
    return { name, grade: gradeOf(name), students: new Set(list.filter(r => r.class === name).map(r => r.national_id)).size,
      n: mine.length, avg: avgOf(mine.map(s => s.p)), dist: mine.length >= MIN ? dist : null };
  });

  const steps = classNames.map(name => {
    const rows = counted.filter(r => r.class === name);
    return { name, t1: part(rows, s => s.t1, "test"), t2: part(rows, s => s.t2, "test"), participation: part(rows, s => s.part, "participation"),
      projects: part(rows, s => s.proj, "projects"), homework: part(rows, s => s.homework, "homework"), final: part(rows, s => s.final, "final"), change: change(rows) };
  });

  // Each cell names its teacher when one teaches that subject in that class, so the principal can open her panel.
  const matrix = classNames.map(name => {
    const cells = {};
    for (const sub of subjects) {
      const rows = counted.filter(r => r.class === name && r.subject === sub);
      const tids = [...new Set(list.filter(r => r.class === name && r.subject === sub).map(r => r.teacher_id))];
      if (tids.length) cells[sub] = { avg: avgOf(rows.map(frac)), n: rows.length, teacher: tids.length === 1 ? tids[0] : null };
    }
    return { name, cells, avg: classes.find(c => c.name === name).avg };
  });

  const all = students.map(s => s.p);
  return {
    kpis: {
      students: new Set(list.map(r => r.national_id)).size,
      graded: students.length,
      avg: avgOf(all),
      top: all.filter(p => p >= 0.9).length,
      support: all.filter(p => p < 0.6).length,
      change: change(counted),
      coverage: list.length ? Math.round((list.filter(r => r.sc.has).length / list.length) * 100) : null,
    },
    classes,
    subjects: subjects.map(name => { const rows = counted.filter(r => r.subject === name); return { name, n: rows.length, avg: avgOf(rows.map(frac)) }; }),
    steps,
    matrix: { subjects, rows: matrix },
  };
}

// The semester's weeks, a line for each class and one for all of them together.
async function weeksOf(pool, teachers, f) {
  const at = school.situation();
  if (!at) return null;
  const { rows } = await pool.query("SELECT week, teacher_id, class, n, pct_sum::float AS sum FROM report_weeks WHERE year = $1 AND semester = $2 ORDER BY week",
    [at.year, at.semester]);
  const list = rows.filter(r => teachers.has(r.teacher_id) && (!f.grade || gradeOf(r.class) === f.grade)
    && (!f.subject || (teachers.get(r.teacher_id).subject || "بدون مادة") === f.subject) && (!f.teacher || r.teacher_id === f.teacher));
  const weeks = [...new Set(list.map(r => r.week))].sort((a, b) => a - b);
  const line = rows => weeks.map(w => {
    const g = rows.filter(r => r.week === w), n = g.reduce((a, r) => a + r.n, 0);
    return n >= MIN ? Math.round((g.reduce((a, r) => a + r.sum, 0) / n) * 100) : null;
  });
  const names = [...new Set(list.map(r => r.class))].sort((a, b) => (gradeOf(a) || 9) - (gradeOf(b) || 9) || String(a).localeCompare(String(b), "ar", { numeric: true }));
  const series = names.map(name => ({ name, points: line(list.filter(r => r.class === name)) })).filter(s => s.points.some(p => p != null));
  return { title: school.semesterTitle(at.year, at.semester), week: at.week, weeks: at.weeks, at: weeks, all: line(list), series };
}

function mount(router, pool) {
  pool.query(SCHEMA).then(() => snapshot(pool)).catch(err => console.error("weekly report snapshot failed", err.message));
  setInterval(() => snapshot(pool).catch(err => console.error("weekly report snapshot failed", err.message)), HOUR).unref();

  // The principal and the platform admin; a teacher reads her own classes on her panel.
  router.get("/school/reports", async (req, res) => {
    if (req.role === "teacher") return res.status(403).json({ error: "forbidden" });
    const teachers = new Map(listTeachers().filter(t => t.active).map(t => [t.id, t]));
    const f = { grade: Number(req.query.grade) || null, subject: String(req.query.subject || "") || null, teacher: Number(req.query.teacher) || null };
    const period = String(req.query.period || "current");
    const [periods, records] = await Promise.all([periodsOf(pool), recordsOf(pool, period)]);
    const report = build(records, teachers, f);
    res.json({
      period: periods.some(p => p.key === period) ? period : "current",
      periods,
      options: {
        grades: Report.GRADES.map((name, i) => ({ value: i + 1, name })),
        subjects: [...new Set([...teachers.values()].map(t => t.subject || "بدون مادة"))].sort((a, b) => a.localeCompare(b, "ar")),
        teachers: [...teachers.values()].map(t => ({ id: t.id, name: t.name, subject: t.subject || "" })),
      },
      ...report,
      weeks: period === "current" ? await weeksOf(pool, teachers, f) : null,
      principal: getSettings(listTeachers()[0]?.id).principal_name || "",
    });
  });
}

module.exports = { SCHEMA, mount, build, snapshot };
