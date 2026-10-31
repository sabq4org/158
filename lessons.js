const express = require("express");
const { getTeacher } = require("./settings");
const { Report } = require("./grades");

// The interactive lessons, gathered in one library, and the score each student got in a lesson's quiz.
// The first finished attempt is the one the teacher reads; later ones are practice and only raise "best".
// These scores are for following up: they never reach the result card, its total, the early alerts or the principal's
// reports. Only the teacher who owns a lesson sees them, in her own panel: not the principal, not another teacher.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_results (
  national_id  TEXT NOT NULL,
  lesson       TEXT NOT NULL,
  score        INT NOT NULL,
  total        INT NOT NULL,
  best         INT NOT NULL,
  attempts     INT NOT NULL DEFAULT 1,
  first_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (national_id, lesson)
);`;

// The order here is the library's order. total is the number of points the lesson's quiz gives. owner is the id of the
// teacher who gave the lesson (her sign-in account); only she sees it and its scores in her panel.
const FAIZA = 1;
const LESSONS = [
  { key: "polynomials", name: "العمليات على كثيرات الحدود", title: "العمليات على كثيرات الحدود", ref: "3-3", book: "رياضيات 2", grade: 2, pages: "125–130", total: 12,
    quiz: "12 سؤال من «تأكد» و«تدريب على اختبار»", about: "تبسيط وحيدات الحد، وجمع كثيرات الحدود وطرحها وضربها، بمختبرات تفاعلية خطوة بخطوة.", theme: "lab", owner: FAIZA },
  { key: "polynomial-division", name: "ورشة القسمة", title: "قسمة كثيرات الحدود", ref: "3-4", book: "رياضيات 2", grade: 2, pages: "131–135", total: 5,
    quiz: "5 أسئلة من «تأكد» و«تدرّب»", about: "القسمة الطويلة والقسمة التركيبية في ورشة ورقية: مقص وصندوق مساحة وآلة قسمة.", theme: "paper", owner: FAIZA },
  { key: "polynomial-functions", name: "مرصد المنحنيات", title: "دوال كثيرات الحدود", ref: "3-5", book: "رياضيات 2", grade: 2, pages: "138–141", total: 15,
    quiz: "تحدي المحققة: 5 منحنيات × 3 أسئلة", about: "رحلة تحت سماء الليل: الدرجة وسلوك الطرفين والأصفار الحقيقية بمنحنيات حية.", theme: "night", owner: FAIZA },
  { key: "perpendicular-distance", name: "أقصر طريق", title: "الأعمدة والمسافة", ref: "2-6", book: "رياضيات 1", grade: 1, pages: "127–134", total: 6,
    quiz: "6 أسئلة من تمارين الكتاب", about: "البعد بين نقطة ومستقيم وبين مستقيمين متوازيين، بفرجار متحرك ومستوى إحداثي تسحبين فيه.", theme: "blueprint", owner: FAIZA },
];
const BY_KEY = Object.fromEntries(LESSONS.map(l => [l.key, l]));
const SUBJECT = "رياضيات";

// The lessons a teacher's panel shows: the ones she owns, in her math panel (not in another subject's panel she has).
// The principal and the platform admin get none.
const panelLessons = (role, login, subject) =>
  role !== "teacher" ? [] : LESSONS.filter(l => l.owner === login && (!subject || String(subject).includes(SUBJECT)));

const idOf = v => String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
const firstName = name => String(name || "").trim().split(/\s+/)[0] || "";

// A whole class answers on one school network at once, so the limit is per address but generous.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 300;
const hits = new Map();
const limited = ip => {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_HITS;
};
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (list.every(t => now - t >= WINDOW_MS)) hits.delete(ip);
}, WINDOW_MS).unref();

// A student of any active teacher; only her first name ever leaves the server.
async function studentOf(pool, id) {
  const { rows } = await pool.query(
    "SELECT s.name FROM students s JOIN teachers t ON t.id = s.teacher_id AND t.active WHERE s.national_id = $1 LIMIT 1", [id]);
  return rows[0] || null;
}

async function resultsOf(pool, id) {
  const { rows } = await pool.query("SELECT lesson, score, total, best, attempts FROM lesson_results WHERE national_id = $1", [id]);
  return Object.fromEntries(rows.filter(r => BY_KEY[r.lesson]).map(r => [r.lesson, { score: r.score, total: r.total, best: r.best, attempts: r.attempts }]));
}

function mount(app, pool) {
  const json = express.json({ limit: "1kb" });
  const guard = fn => async (req, res) => {
    if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
    try { await fn(req, res); } catch (err) { console.error(err); res.status(500).json({ error: "server_error" }); }
  };

  app.get("/api/lessons", (req, res) => {
    res.set("Cache-Control", "no-cache");
    res.json({ lessons: LESSONS.map(({ key, name, title, ref, book, grade, pages, total, quiz, about, theme }) =>
      ({ key, name, title, ref, book, grade, gradeLabel: Report.GRADES[grade - 1], pages, total, quiz, about, theme })) });
  });

  // The student says who she is before the quiz; she gets her first name back and the scores she already has.
  app.post("/api/lessons/student", json, guard(async (req, res) => {
    const id = idOf(req.body?.id);
    if (id.length < 9 || id.length > 10) return res.status(400).json({ error: "invalid_id" });
    const s = await studentOf(pool, id);
    if (!s) return res.status(404).json({ error: "not_found" });
    res.json({ name: firstName(s.name), results: await resultsOf(pool, id) });
  }));

  app.post("/api/lessons/:lesson/result", json, guard(async (req, res) => {
    const l = BY_KEY[req.params.lesson];
    if (!l) return res.status(404).json({ error: "not_found" });
    const id = idOf(req.body?.id), score = Number(req.body?.score);
    if (!Number.isInteger(score) || score < 0 || score > l.total) return res.status(400).json({ error: "invalid_score" });
    if (!(await studentOf(pool, id))) return res.status(404).json({ error: "not_found" });
    const { rows } = await pool.query(
      `INSERT INTO lesson_results (national_id, lesson, score, total, best) VALUES ($1, $2, $3, $4, $3)
       ON CONFLICT (national_id, lesson) DO UPDATE SET attempts = lesson_results.attempts + 1,
         best = GREATEST(lesson_results.best, EXCLUDED.score), last_at = now()
       RETURNING score, total, best, attempts`, [id, l.key, score, l.total]);
    const r = rows[0];
    res.json({ first: r.attempts === 1, score: r.score, total: r.total, best: r.best, attempts: r.attempts });
  }));
}

// The panel's "الدروس" tab: the owner's students and their scores, in the lessons she owns that fit the grades she teaches.
function mountPanel(router, pool) {
  router.get("/lessons", async (req, res) => {
    const t = getTeacher(req.tid);
    const subject = String(t?.subject || "");
    const mine = panelLessons(req.role, req.login, subject);
    if (req.role !== "teacher") return res.status(403).json({ error: "forbidden", errors: ["الدروس التفاعلية تشوفها المعلمة صاحبتها فقط"] });
    if (!mine.length) return res.json({ subject, lessons: [], students: [] });
    const keys = mine.map(l => l.key);
    const { rows } = await pool.query(
      `SELECT s.national_id, s.name, s.class, r.lesson, r.score, r.total, r.best, r.attempts, r.first_at
       FROM students s LEFT JOIN lesson_results r ON r.national_id = s.national_id AND r.lesson = ANY($2)
       WHERE s.teacher_id = $1 ORDER BY s.class NULLS LAST, s.name`, [req.tid, keys]);
    const students = new Map();
    for (const r of rows) {
      const s = students.get(r.national_id) || { id: r.national_id, name: r.name, class: r.class, results: {} };
      if (r.lesson && BY_KEY[r.lesson]) s.results[r.lesson] = { score: r.score, total: r.total, best: r.best, attempts: r.attempts, at: r.first_at };
      students.set(r.national_id, s);
    }
    const list = [...students.values()];
    // Her lessons for the grades she teaches, and any of hers her students have already taken.
    const grades = new Set(list.map(s => Report.classParts(s.class)?.grade).filter(Boolean));
    const taken = new Set(list.flatMap(s => Object.keys(s.results)));
    const lessons = mine.filter(l => taken.has(l.key) || !grades.size || grades.has(l.grade))
      .map(({ key, name, title, ref, grade, total }) => ({ key, name, title, ref, grade, total }));
    res.json({ subject, lessons, students: lessons.length ? list : [] });
  });
}

module.exports = { SCHEMA, LESSONS, panelLessons, mount, mountPanel };
