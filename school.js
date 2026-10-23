// The school's calendar and class structure. A school year is named after the Hijri year it starts in:
// 1448 runs from August 2026 to June 2027, in two semesters. Dates are ISO strings (YYYY-MM-DD) in Riyadh time.
const DAY = 864e5;
const ORDINALS = ["الأول", "الثاني", "الثالث"];

// Secondary school only. The first grade is the common first year; tracks start in the second.
const STAGE = "المرحلة الثانوية";
const GRADES = ["الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي"];
const TRACKS = ["المسار العام", "علوم الحاسب والهندسة", "الصحة والحياة", "إدارة الأعمال", "الشرعي"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS school_years (
  hijri       INT PRIMARY KEY,
  semesters   JSONB NOT NULL,
  breaks      JSONB NOT NULL DEFAULT '[]',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// The ministry's calendar for 1448 (two semesters, as the Cabinet decided in August 2025 for the next four years).
const SEED = [{
  hijri: 1448,
  semesters: [
    { num: 1, starts: "2026-08-23", ends: "2027-01-07" },
    { num: 2, starts: "2027-01-17", ends: "2027-06-24" },
  ],
  breaks: [
    { name: "إجازة اليوم الوطني", starts: "2026-09-23", ends: "2026-09-26" },
    { name: "إجازة الخريف", starts: "2026-11-20", ends: "2026-11-28" },
    { name: "إجازة منتصف العام", starts: "2027-01-08", ends: "2027-01-16" },
    { name: "إجازة يوم التأسيس", starts: "2027-02-19", ends: "2027-02-22" },
    { name: "إجازة عيد الفطر", starts: "2027-02-26", ends: "2027-03-13" },
    { name: "إجازة عيد الأضحى", starts: "2027-05-07", ends: "2027-05-22" },
  ],
}];

const dayNum = iso => Date.parse(iso + "T00:00:00Z") / DAY;
const isoOf = n => new Date(n * DAY).toISOString().slice(0, 10);
// Riyadh is UTC+3 all year, so today's date there needs no time zone data.
const today = () => isoOf(Math.floor((Date.now() + 3 * 3600 * 1000) / DAY));
const validDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(dayNum(s)) === s;
const semesterName = num => `الفصل الدراسي ${ORDINALS[num - 1] || num}`;
const semesterTitle = (year, num) => `${semesterName(num)} ${year}هـ`;

let years = [];

async function load(pool) {
  await pool.query(SCHEMA);
  for (const y of SEED) {
    await pool.query("INSERT INTO school_years (hijri, semesters, breaks) VALUES ($1, $2, $3) ON CONFLICT (hijri) DO NOTHING",
      [y.hijri, JSON.stringify(y.semesters), JSON.stringify(y.breaks)]);
  }
  years = (await pool.query("SELECT hijri, semesters, breaks FROM school_years ORDER BY hijri")).rows;
  return years;
}

const getYears = () => years;

// Study weeks of a semester, counted Sunday to Thursday. A week the breaks cover entirely is not counted.
function weeksOf(sem, breaks, d) {
  const off = n => breaks.some(b => dayNum(b.starts) <= n && n <= dayNum(b.ends));
  const start = dayNum(sem.starts), sunday = start - ((start + 4) % 7);
  const last = Math.floor((dayNum(sem.ends) - sunday) / 7);
  const isBreak = i => [0, 1, 2, 3, 4].every(k => off(sunday + 7 * i + k));
  const at = Math.floor((d - sunday) / 7);
  let weeks = 0, week = null, left = 0;
  for (let i = 0; i <= last; i++) {
    if (isBreak(i)) continue;
    weeks++;
    if (i === at && d >= start && d <= dayNum(sem.ends)) week = weeks;
    if (i > at) left++;
  }
  return { week, weeks, left };
}

// Where a date falls in the calendar. A semester is closed once it was archived with its grades cleared (`closed`
// lists those), and the grades on the panel belong to the earliest semester so far that is still open.
// With no grades at all (`empty`), nothing is left over from an earlier semester, so the calendar decides.
function situation(closed = [], date = today(), { empty = false } = {}) {
  if (!years.length) return null;
  const d = dayNum(date);
  const year = years.filter(y => dayNum(y.semesters[0].starts) <= d).pop() || years[0];
  const sem = year.semesters.filter(s => dayNum(s.starts) <= d).pop() || year.semesters[0];
  const all = years.flatMap(y => y.semesters.map(s => ({ ...s, year: y.hijri })));
  const at = all.findIndex(s => s.year === year.hijri && s.num === sem.num);
  const shut = new Set(closed.map(c => `${c.year}-${c.semester}`));
  const open = s => !shut.has(`${s.year}-${s.num}`);
  // The semester after another; past the last year in the calendar it has no dates yet.
  const after = s => {
    const i = all.indexOf(s);
    if (i >= 0 && all[i + 1]) return all[i + 1];
    const count = years.find(y => y.hijri === s.year)?.semesters.length || 2;
    return s.num < count ? { year: s.year, num: s.num + 1 } : { year: s.year + 1, num: 1 };
  };
  let cur = empty ? null : all.slice(0, at + 1).find(open);
  if (!cur) { cur = all[at]; while (!open(cur) && cur.starts) cur = after(cur); }
  const next = after(cur);
  return {
    today: date,
    year: year.hijri,
    semester: sem.num,
    ...weeksOf(sem, year.breaks, d),
    holiday: year.breaks.find(b => dayNum(b.starts) <= d && d <= dayNum(b.ends)) || null,
    current: { year: cur.year, num: cur.num, title: semesterTitle(cur.year, cur.num), starts: cur.starts || null, ends: cur.ends || null },
    ended: !!cur.ends && d > dayNum(cur.ends),
    next: { year: next.year, num: next.num, title: semesterTitle(next.year, next.num) },
  };
}

// Read from the log, so deleting an archived period later does not reopen its semester; undoing the archive does.
const closedSemesters = pool => pool.query(`SELECT DISTINCT (details->>'year')::int AS year, (details->>'semester')::int AS semester
  FROM audit_log WHERE action = 'term_archive' AND undone_at IS NULL AND (details->>'cleared')::boolean AND details ? 'semester'`).then(r => r.rows);
const now = async pool => {
  const [closed, graded] = await Promise.all([closedSemesters(pool),
    pool.query("SELECT 1 FROM students WHERE coalesce(test1, test2, test_avg, participation, projects) IS NOT NULL LIMIT 1")]);
  return situation(closed, today(), { empty: !graded.rowCount });
};

// A calendar edited in the settings. Semesters run in order without overlapping; each break has a name and dates.
function cleanYear(body) {
  const errors = [];
  const semesters = (Array.isArray(body?.semesters) ? body.semesters : []).slice(0, 3).map((s, i) => ({ num: i + 1, starts: String(s?.starts || ""), ends: String(s?.ends || "") }));
  if (!semesters.length) errors.push("لازم يكون في العام فصل دراسي واحد على الأقل");
  semesters.forEach((s, i) => {
    const name = semesterName(s.num);
    if (!validDate(s.starts) || !validDate(s.ends)) errors.push(`${name}: التاريخ غير صحيح`);
    else if (s.starts > s.ends) errors.push(`${name}: البداية بعد النهاية`);
    else if (i && validDate(semesters[i - 1].ends) && s.starts <= semesters[i - 1].ends) errors.push(`${name}: يبدأ قبل نهاية الفصل اللي قبله`);
  });
  const breaks = (Array.isArray(body?.breaks) ? body.breaks : []).slice(0, 20)
    .map(b => ({ name: String(b?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60), starts: String(b?.starts || ""), ends: String(b?.ends || "") }))
    .filter(b => b.name || b.starts || b.ends);
  for (const b of breaks) {
    if (!b.name) errors.push("فيه إجازة بدون اسم");
    else if (!validDate(b.starts) || !validDate(b.ends)) errors.push(`${b.name}: التاريخ غير صحيح`);
    else if (b.starts > b.ends) errors.push(`${b.name}: البداية بعد النهاية`);
  }
  breaks.sort((a, b) => (a.starts < b.starts ? -1 : 1));
  return { semesters, breaks, errors };
}

async function saveYear(pool, hijri, y) {
  await pool.query("UPDATE school_years SET semesters = $2, breaks = $3, updated_at = now() WHERE hijri = $1",
    [hijri, JSON.stringify(y.semesters), JSON.stringify(y.breaks)]);
  return load(pool);
}

// ---------- Classes: "الثاني الثانوي / 1" is the second grade, section 1 ----------
const className = (grade, section) => `${GRADES[grade - 1]} / ${section}`;
const toLatin = s => String(s ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
const GRADE_WORDS = { "أول": 1, "اول": 1, "ثاني": 2, "ثالث": 3 };

// Short forms people write in a sheet: "ثاني ثانوي / 1"، "الأول ثانوي - 2"، "2/1". A bare "1" stays as written.
function parseClass(text) {
  const t = toLatin(text).replace(/\s+/g, " ").trim();
  let m = t.match(/^(?:ال)?(أول|اول|ثاني|ثالث)(?: (?:ال)?ثانوي(?:ة)?)? ?[/\-–]? ?(\d{1,2})$/);
  if (m) return { grade: GRADE_WORDS[m[1]], section: Number(m[2]) };
  m = t.match(/^([1-3]) ?[/\-–] ?(\d{1,2})$/);
  if (m) return { grade: Number(m[1]), section: Number(m[2]) };
  return null;
}

module.exports = { STAGE, GRADES, TRACKS, ORDINALS, load, getYears, situation, now, today, semesterName, semesterTitle, cleanYear, saveYear, className, parseClass };
