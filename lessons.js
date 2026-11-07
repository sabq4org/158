const express = require("express");
const ExcelJS = require("exceljs");
const { getTeacher } = require("./settings");
const { Report } = require("./grades");

// The interactive lessons, gathered in one library, and the score each student got in a lesson's quiz.
// The first finished attempt is the one the teacher reads; later ones are practice and only raise "best".
// With it the page sends each question's answer (answers: [{ q, ok, t, p, r }] = question number in the book's order,
// right or wrong, and the question, her pick and the right answer as plain text), so the teacher sees what she chose.
// Attempts saved before answers were kept (2026-11-04) have the score only.
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
);
ALTER TABLE lesson_results ADD COLUMN IF NOT EXISTS answers JSONB;
CREATE TABLE IF NOT EXISTS lesson_visibility (
  lesson      TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,
  opens_at    TIMESTAMPTZ,
  closes_at   TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// The order here is the library's order. total is the number of points the lesson's quiz gives. owner is the id of the
// teacher who gave the lesson (her sign-in account); only she sees it and its scores in her panel.
// A new lesson gets startHidden: true (the user asked, 2026-11-05): it reaches no student until its teacher shows it or
// schedules it in her panel. The lessons before that have no flag and stay shown until she hides them.
const FAIZA = 1;
const LESSONS = [
  { key: "polynomials", name: "العمليات على كثيرات الحدود", title: "العمليات على كثيرات الحدود", ref: "3-3", book: "رياضيات 2", grade: 2, pages: "125–130", total: 12,
    quiz: "12 سؤال من «تأكد» و«تدريب على اختبار»", about: "تبسيط وحيدات الحد، وجمع كثيرات الحدود وطرحها وضربها، بمختبرات تفاعلية خطوة بخطوة.", theme: "lab", owner: FAIZA },
  { key: "polynomial-division", name: "ورشة القسمة", title: "قسمة كثيرات الحدود", ref: "3-4", book: "رياضيات 2", grade: 2, pages: "131–135", total: 5,
    quiz: "5 أسئلة من «تأكد» و«تدرّب»", about: "القسمة الطويلة والقسمة التركيبية في ورشة ورقية: مقص وصندوق مساحة وآلة قسمة.", theme: "paper", owner: FAIZA },
  { key: "polynomial-functions", name: "مرصد المنحنيات", title: "دوال كثيرات الحدود", ref: "3-5", book: "رياضيات 2", grade: 2, pages: "138–141", total: 15,
    quiz: "تحدي المحققة: 5 منحنيات × 3 أسئلة", about: "رحلة تحت سماء الليل: الدرجة وسلوك الطرفين والأصفار الحقيقية بمنحنيات حية.", theme: "night", owner: FAIZA },
  { key: "polynomial-equations", name: "خزانة المفاتيح", title: "حل معادلات كثيرات الحدود", ref: "3-6", book: "رياضيات 2", grade: 2, pages: "145–152", total: 6,
    quiz: "6 أسئلة من «تأكد»", about: "كل كثيرة حدود قفل وكل طريقة تحليل مفتاح: مكعب مقطوع من مكعب، وحلقة المفاتيح، والتجميع، والصورة التربيعية، وآلة حل بمنحنى حي، وخزنة تفتحينها بالحلول.", theme: "vault", owner: FAIZA },
  { key: "perpendicular-distance", name: "أقصر طريق", title: "الأعمدة والمسافة", ref: "2-6", book: "رياضيات 1", grade: 1, pages: "127–134", total: 6,
    quiz: "6 أسئلة من تمارين الكتاب", about: "البعد بين نقطة ومستقيم وبين مستقيمين متوازيين، بفرجار متحرك ومستوى إحداثي تسحبين فيه.", theme: "blueprint", owner: FAIZA },
  { key: "triangle-classification", name: "سدو المثلثات", title: "تصنيف المثلثات", ref: "3-1", book: "رياضيات 1-2", grade: 1, pages: "12–18", total: 6,
    quiz: "6 أسئلة من تمارين الكتاب", about: "تسحبين رؤوس المثلث على نول السدو فيصنّف نفسه حسب الزوايا والأضلاع، ثم تكملين لوحة الأنواع السبعة.", theme: "sadu", owner: FAIZA },
  { key: "triangle-angles", name: "روبوت الزوايا", title: "زوايا المثلثات", ref: "3-2", book: "رياضيات 1-2", grade: 1, pages: "20–27", total: 6,
    quiz: "6 أسئلة من تمارين الكتاب", about: "تشغّلين روبوتًا على مسار مثلث، وتقصّين زوايا المثلث وترصّينها على خط مستقيم، ثم الزاوية الخارجية والنتيجتان وورشة صيانة الروبوتات.", theme: "robot", owner: FAIZA },
  { key: "congruent-triangles", name: "المثلثات المتطابقة", title: "المثلثات المتطابقة", ref: "3-3", book: "رياضيات 1-2", grade: 1, pages: "28–35", total: 6,
    quiz: "6 أسئلة من تمارين الكتاب", about: "تركّبين قطعة في فتحة لوحة القيادة بالسحب واللف والقلب، وتطابقين العناصر المتناظرة وترتيب الرؤوس، ثم نظرية الزاوية الثالثة وبناء البرهان وورشة القطع.", theme: "puzzle", owner: FAIZA },
  { key: "congruence-sss-sas", name: "إثبات تطابق المثلثات SSS، SAS", title: "إثبات تطابق المثلثات SSS، SAS", ref: "3-4", book: "رياضيات 1-2", grade: 1, pages: "36–43", total: 6,
    quiz: "6 أسئلة من تمارين الكتاب", about: "ورشة جسور: إطار مثلث ما ينطوي، وثلاثة عيدان ما تركب إلا مثلثًا واحدًا، وعقربا ساعة يحددان الضلع الثالث، ثم المفتشة والمستوى الإحداثي والبراهين ولعبة بناء الجسر.", theme: "bridge", owner: FAIZA, startHidden: true },
];
const BY_KEY = Object.fromEntries(LESSONS.map(l => [l.key, l]));
const SUBJECT = "رياضيات";

// The lessons a teacher's panel shows: the ones she owns, in her math panel (not in another subject's panel she has).
// The principal and the platform admin get none.
const panelLessons = (role, login, subject) =>
  role !== "teacher" ? [] : LESSONS.filter(l => l.owner === login && (!subject || String(subject).includes(SUBJECT)));

const idOf = v => String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
// The answers a quiz page sends: one per question, plain text only (the panel escapes it), numbered in the book's order.
// They are kept only when they add up to the score and cover the whole quiz, so the sheet and the score always agree.
const clip = v => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 400);
function answersOf(raw, l, score) {
  if (!Array.isArray(raw) || raw.length !== l.total) return null;
  const out = [];
  for (const a of raw) {
    const q = Number(a?.q);
    if (!Number.isInteger(q) || q < 0 || q >= l.total || out.some(x => x.q === q)) return null;
    out.push({ q, ok: a.ok === true, t: clip(a.t), p: clip(a.p), r: clip(a.r) });
  }
  if (out.filter(a => a.ok).length !== score) return null;
  return out.sort((a, b) => a.q - b.q);
}
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

// A student of any active teacher; only her first name and her grade ever leave the server.
// grade is null when her class has no grade in its name (an old "1"/"2" name): she then sees every lesson.
async function studentOf(pool, id) {
  const { rows } = await pool.query(
    "SELECT s.name, s.class FROM students s JOIN teachers t ON t.id = s.teacher_id AND t.active WHERE s.national_id = $1 ORDER BY s.teacher_id", [id]);
  if (!rows.length) return null;
  // She may be on several teachers' lists; a class that names her grade wins over an old name without one.
  const grade = rows.map(r => Report.classParts(r.class)?.grade).find(Boolean) || null;
  return { name: rows[0].name, grade };
}
// Each grade sees its own lessons only (the user asked, 2026-11-02): a student of الثاني الثانوي sees the second grade's.
const forGrade = (l, grade) => !grade || l.grade === grade;

async function resultsOf(pool, id) {
  const { rows } = await pool.query("SELECT lesson, score, total, best, attempts FROM lesson_results WHERE national_id = $1", [id]);
  return Object.fromEntries(rows.filter(r => BY_KEY[r.lesson]).map(r => [r.lesson, { score: r.score, total: r.total, best: r.best, attempts: r.attempts }]));
}

// Each lesson is shown to students, hidden, or scheduled: open from one time and closed from another (either may be left
// out). The teacher picks the times in Riyadh time; they are kept as instants. A lesson with no row is shown, unless its
// catalog entry has startHidden. Staff signed in to the panel always see and open every lesson, to check it or show it
// in class. A hidden lesson is left out of the library, its page shows a locked notice and its quiz saves nothing.
// One server runs the site, so the rows are read once and kept in memory; the panel's changes update both.
let POOL = null, vis = null;
async function visibility() {
  if (!vis && POOL) {
    const { rows } = await POOL.query("SELECT lesson, mode, opens_at, closes_at FROM lesson_visibility");
    vis = new Map(rows.map(r => [r.lesson, { mode: r.mode, opens: r.opens_at?.toISOString() || null, closes: r.closes_at?.toISOString() || null }]));
  }
  return vis || new Map();
}
const MODES = ["shown", "hidden", "scheduled"];
// Whether students can open the lesson now; a scheduled one also says whether its window is still to come or has passed.
function stateOf(l, map, now = Date.now()) {
  const v = map.get(l.key) || { mode: l.startHidden ? "hidden" : "shown", opens: null, closes: null };
  if (v.mode !== "scheduled") return { ...v, open: v.mode === "shown" };
  const o = v.opens ? Date.parse(v.opens) : -Infinity, c = v.closes ? Date.parse(v.closes) : Infinity;
  return { ...v, open: now >= o && now < c, phase: now < o ? "before" : now >= c ? "after" : "during" };
}
// A time in another year names its year.
const riyadh = iso => new Date(iso).toLocaleString("ar-SA-u-nu-latn-ca-gregory", { timeZone: "Asia/Riyadh", weekday: "long", day: "numeric", month: "long",
  ...(new Date(iso).getUTCFullYear() !== new Date().getUTCFullYear() ? { year: "numeric" } : {}), hour: "numeric", minute: "2-digit" });
// One line on a lesson's state, for staff in the library and on its locked page.
function stateText(s) {
  if (s.mode === "shown") return "ظاهر للطالبات";
  if (s.mode === "hidden") return "مخفي عن الطالبات";
  if (s.phase === "before") return `يفتح ${riyadh(s.opens)}`;
  if (s.phase === "after") return `انقفل ${riyadh(s.closes)}`;
  return s.closes ? `مفتوح، ويقفل ${riyadh(s.closes)}` : "مفتوح للطالبات";
}
const staffOf = (app, req) => !!(typeof app.locals.readSession === "function" && app.locals.readSession(req));

function lockedPage(l, s) {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const [icon, head, line] = s.mode === "scheduled" && s.phase === "before"
    ? ["⏳", "الدرس ما فتح للحين", `يفتح ${riyadh(s.opens)}.`]
    : s.mode === "scheduled" && s.phase === "after"
      ? ["🔒", "انتهى وقت هذا الدرس", `انقفل ${riyadh(s.closes)}. لو تحتاجينه اسألي معلمتك.`]
      : ["🔒", "هذا الدرس مو متاح الحين", "معلمتك بتفتحه لكم في وقته."];
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(l.name)}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap">
<style>:root{--bg:#f4f7f6;--card:#fff;--ink:#12302e;--muted:#5b6f6d;--line:#dbe5e3;--accent:#0f766e;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0e1716;--card:#16211f;--ink:#e6f0ee;--muted:#9db1ae;--line:#26332f;--accent:#2bb3a4}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;line-height:1.8}
.box{box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px;max-width:420px;width:100%;text-align:center}
.i{font-size:44px}h1{font-size:20px;margin:6px 0}p{color:var(--muted);margin:0 0 6px}small{color:var(--muted)}
a{display:inline-block;margin-top:14px;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;border-radius:10px;padding:8px 18px}</style></head>
<body><main class="box"><div class="i">${icon}</div><small>الدرس <bdi dir="ltr">${esc(l.ref)}</bdi> · ${esc(l.title)}</small><h1>${head}</h1><p>${esc(line)}</p>
<a href="/lessons">مكتبة الدروس ←</a></main></body></html>`;
}

// The lesson's page, for students only while it is open. Staff always get it.
const gatePage = (app, key) => async (req, res, next) => {
  const l = BY_KEY[key];
  if (!l || staffOf(app, req)) return next();
  let s;
  try { s = stateOf(l, await visibility()); } catch (err) { console.error(err); return next(); }
  if (s.open) return next();
  res.status(403).set("Cache-Control", "no-cache").type("html").send(lockedPage(l, s));
};

function mount(app, pool) {
  POOL = pool;
  const json = express.json({ limit: "1kb" });
  const guard = fn => async (req, res) => {
    if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
    try { await fn(req, res); } catch (err) { console.error(err); res.status(500).json({ error: "server_error" }); }
  };

  // The library lists a student's own grade only, once she gives her ID. Staff signed in to the panel (a teacher, the
  // principal, the admin) see every grade, so a teacher can open any lesson in class.
  // Students get the open lessons only; staff get all of them, each with its state.
  app.get("/api/lessons", async (req, res) => {
    res.set("Cache-Control", "no-cache");
    const staff = staffOf(app, req);
    let map;
    try { map = await visibility(); } catch (err) { console.error(err); return res.status(500).json({ error: "server_error" }); }
    const list = LESSONS.map(l => ({ l, s: stateOf(l, map) })).filter(x => staff || x.s.open);
    res.json({ staff, lessons: list.map(({ l: { key, name, title, ref, book, grade, pages, total, quiz, about, theme }, s }) =>
      ({ key, name, title, ref, book, grade, gradeLabel: Report.GRADES[grade - 1], pages, total, quiz, about, theme,
        ...(staff ? { open: s.open, state: stateText(s) } : {}) })) });
  });

  // The student says who she is before the quiz; she gets her first name back and the scores she already has.
  app.post("/api/lessons/student", json, guard(async (req, res) => {
    const id = idOf(req.body?.id);
    if (id.length < 9 || id.length > 10) return res.status(400).json({ error: "invalid_id" });
    const s = await studentOf(pool, id);
    if (!s) return res.status(404).json({ error: "not_found" });
    const g = s.grade, l = BY_KEY[req.body?.lesson];
    // From a lesson's quiz: whether that lesson is for her grade (a link may have been passed on from another grade).
    // And whether it is open now: a page left open past the lesson's closing time saves nothing.
    const fit = l ? { fits: forGrade(l, g), lessonGrade: Report.GRADES[l.grade - 1],
      open: staffOf(app, req) || stateOf(l, await visibility()).open } : {};
    res.json({ name: firstName(s.name), grade: g, gradeLabel: g ? Report.GRADES[g - 1] : null, ...fit, results: await resultsOf(pool, id) });
  }));

  // A quiz of 15 questions with their texts is a few kilobytes.
  app.post("/api/lessons/:lesson/result", express.json({ limit: "24kb" }), guard(async (req, res) => {
    const l = BY_KEY[req.params.lesson];
    if (!l) return res.status(404).json({ error: "not_found" });
    const id = idOf(req.body?.id), score = Number(req.body?.score);
    if (!Number.isInteger(score) || score < 0 || score > l.total) return res.status(400).json({ error: "invalid_score" });
    const s = await studentOf(pool, id);
    if (!s) return res.status(404).json({ error: "not_found" });
    if (!forGrade(l, s.grade)) return res.status(403).json({ error: "wrong_grade" });
    if (!staffOf(app, req) && !stateOf(l, await visibility()).open) return res.status(403).json({ error: "closed" });
    const a = answersOf(req.body?.answers, l, score), answers = a ? JSON.stringify(a) : null;
    const { rows } = await pool.query(
      `INSERT INTO lesson_results (national_id, lesson, score, total, best, answers) VALUES ($1, $2, $3, $4, $3, $5)
       ON CONFLICT (national_id, lesson) DO UPDATE SET attempts = lesson_results.attempts + 1,
         best = GREATEST(lesson_results.best, EXCLUDED.score), last_at = now()
       RETURNING score, total, best, attempts`, [id, l.key, score, l.total, answers]);
    const r = rows[0];
    res.json({ first: r.attempts === 1, score: r.score, total: r.total, best: r.best, attempts: r.attempts });
  }));
}

// The panel's "الدروس" tab: the owner's students and their scores, in the lessons she owns that fit the grades she teaches.
// The overview carries each result's right/wrong marks; one lesson's page carries the full answers, for its question
// analysis and each student's answer sheet.
function mountPanel(router, pool) {
  // Her lessons and students, or the reason she has none. The principal and other teachers get nothing.
  async function mineOf(req, res) {
    if (req.role !== "teacher") { res.status(403).json({ error: "forbidden", errors: ["الدروس التفاعلية تشوفها المعلمة صاحبتها فقط"] }); return null; }
    const subject = String(getTeacher(req.tid)?.subject || "");
    return { subject, mine: panelLessons(req.role, req.login, subject) };
  }
  const visView = (l, map) => { const s = stateOf(l, map); return { mode: s.mode, opens: s.opens, closes: s.closes, open: s.open, text: stateText(s) }; };
  const resultOf = (r, full) => ({ score: r.score, total: r.total, best: r.best, attempts: r.attempts, at: r.first_at,
    marks: Array.isArray(r.answers) ? r.answers.map(a => (a.ok ? 1 : 0)).join("") : null, ...(full ? { answers: r.answers || null } : {}) });

  router.get("/lessons", async (req, res) => {
    const m = await mineOf(req, res); if (!m) return;
    const { subject, mine } = m;
    if (!mine.length) return res.json({ subject, lessons: [], students: [] });
    const keys = mine.map(l => l.key);
    const { rows } = await pool.query(
      `SELECT s.national_id, s.name, s.class, s.learning_difficulty, r.lesson, r.score, r.total, r.best, r.attempts, r.first_at, r.answers
       FROM students s LEFT JOIN lesson_results r ON r.national_id = s.national_id AND r.lesson = ANY($2)
       WHERE s.teacher_id = $1 ORDER BY s.class NULLS LAST, s.name`, [req.tid, keys]);
    const students = new Map();
    for (const r of rows) {
      const s = students.get(r.national_id) || { id: r.national_id, name: r.name, class: r.class, ld: !!r.learning_difficulty, results: {} };
      if (r.lesson && BY_KEY[r.lesson]) s.results[r.lesson] = resultOf(r, false);
      students.set(r.national_id, s);
    }
    const list = [...students.values()];
    // Her lessons for the grades she teaches, and any of hers her students have already taken.
    const grades = new Set(list.map(s => Report.classParts(s.class)?.grade).filter(Boolean));
    const taken = new Set(list.flatMap(s => Object.keys(s.results)));
    const map = await visibility();
    const lessons = mine.filter(l => taken.has(l.key) || !grades.size || grades.has(l.grade))
      .map(l => ({ key: l.key, name: l.name, title: l.title, ref: l.ref, grade: l.grade, gradeLabel: Report.GRADES[l.grade - 1], total: l.total, vis: visView(l, map) }));
    res.json({ subject, lessons, students: lessons.length ? list : [] });
  });

  // One lesson: every student of hers with her first attempt's answers.
  async function lessonRows(req, res) {
    const m = await mineOf(req, res); if (!m) return null;
    const l = m.mine.find(x => x.key === req.params.key);
    if (!l) { res.status(404).json({ error: "not_found", errors: ["الدرس غير موجود"] }); return null; }
    const { rows } = await pool.query(
      `SELECT s.national_id, s.name, s.class, r.score, r.total, r.best, r.attempts, r.first_at, r.answers
       FROM students s LEFT JOIN lesson_results r ON r.national_id = s.national_id AND r.lesson = $2
       WHERE s.teacher_id = $1 ORDER BY s.class NULLS LAST, s.name`, [req.tid, l.key]);
    return { l, students: rows.map(r => ({ id: r.national_id, name: r.name, class: r.class, result: r.score == null ? null : resultOf(r, true) })) };
  }
  router.get("/lessons/:key", async (req, res) => {
    const d = await lessonRows(req, res); if (!d) return;
    const { key, name, title, ref, grade, total } = d.l;
    res.json({ lesson: { key, name, title, ref, grade, gradeLabel: Report.GRADES[grade - 1], total, vis: visView(d.l, await visibility()) }, students: d.students });
  });

  // Show, hide or schedule one of her lessons. opens and closes are instants (ISO); a schedule needs at least one.
  router.put("/lessons/:key/visibility", async (req, res) => {
    const m = await mineOf(req, res); if (!m) return;
    const l = m.mine.find(x => x.key === req.params.key);
    if (!l) return res.status(404).json({ error: "not_found", errors: ["الدرس غير موجود"] });
    const mode = req.body?.mode;
    if (!MODES.includes(mode)) return res.status(400).json({ error: "invalid", errors: ["اختاري: ظاهر أو مخفي أو مجدول"] });
    const at = v => { if (v == null || v === "") return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t) : undefined; };
    let opens = null, closes = null;
    if (mode === "scheduled") {
      opens = at(req.body.opens); closes = at(req.body.closes);
      if (opens === undefined || closes === undefined) return res.status(400).json({ error: "invalid", errors: ["الوقت غير صحيح"] });
      if (!opens && !closes) return res.status(400).json({ error: "invalid", errors: ["حددي وقت الفتح أو وقت القفل، أو الاثنين"] });
      if (opens && closes && closes <= opens) return res.status(400).json({ error: "invalid", errors: ["وقت القفل لازم يكون بعد وقت الفتح"] });
    }
    await visibility();
    await pool.query(
      `INSERT INTO lesson_visibility (lesson, mode, opens_at, closes_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (lesson) DO UPDATE SET mode = EXCLUDED.mode, opens_at = EXCLUDED.opens_at, closes_at = EXCLUDED.closes_at, updated_at = now()`,
      [l.key, mode, opens, closes]);
    if (vis) vis.set(l.key, { mode, opens: opens?.toISOString() || null, closes: closes?.toISOString() || null });
    res.json({ vis: visView(l, await visibility()) });
  });

  // The lesson as a sheet: one row per student, a column per question (✓/✗), and a second sheet of each answer.
  router.get("/lessons/:key/export", async (req, res) => {
    const d = await lessonRows(req, res); if (!d) return;
    const { l } = d, cls = String(req.query.class || "");
    // The lesson page's students: this lesson's grade (or a class name with no grade), then the class picked.
    const fits = s => { const g = Report.classParts(s.class)?.grade; return !g || g === l.grade; };
    const list = d.students.filter(s => fits(s) && (!cls || s.class === cls));
    const wb = new ExcelJS.Workbook();
    const head = ws => {
      const h = ws.getRow(1);
      h.font = { bold: true, color: { argb: "FFFFFFFF" } };
      h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B2765" } };
      h.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    };
    const ws = wb.addWorksheet("الدرجات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    ws.columns = [["name", "الطالبة", 30], ["class", "الفصل", 20], ["score", "الدرجة", 9], ["pct", "النسبة", 9], ["attempts", "المحاولات", 10], ["best", "أفضل محاولة", 11],
      ...Array.from({ length: l.total }, (_, k) => [`q${k}`, `س${k + 1}`, 6])].map(([key, header, width]) => ({ key, header, width }));
    for (const s of list) {
      const r = s.result, row = { name: s.name, class: Report.classLabel(s.class) };
      if (!r) row.score = "لم تحل";
      else {
        Object.assign(row, { score: `${r.score} من ${r.total}`, pct: Math.round((100 * r.score) / r.total) + "%", attempts: r.attempts, best: r.best });
        for (const a of r.answers || []) row[`q${a.q}`] = a.ok ? "✓" : "✗";
      }
      ws.addRow(row);
    }
    head(ws);
    const wa = wb.addWorksheet("الإجابات", { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
    wa.columns = [["name", "الطالبة", 26], ["class", "الفصل", 18], ["n", "السؤال", 8], ["t", "نص السؤال", 60], ["p", "إجابتها", 30], ["r", "الإجابة الصحيحة", 30], ["ok", "", 6]]
      .map(([key, header, width]) => ({ key, header, width }));
    const plain = v => String(v || "").replace(/[⁦-⁩]/g, "");
    for (const s of list) for (const a of s.result?.answers || [])
      wa.addRow({ name: s.name, class: Report.classLabel(s.class), n: a.q + 1, t: plain(a.t), p: plain(a.p), r: plain(a.r), ok: a.ok ? "✓" : "✗" });
    head(wa);
    const fileName = `${l.name} ${cls ? Report.classLabel(cls) : "كل الفصول"}`.replace(/[\\/:*?"<>|]/g, "-");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="lesson-${l.key}.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName + ".xlsx")}`);
    await wb.xlsx.write(res);
    res.end();
  });
}

module.exports = { SCHEMA, LESSONS, panelLessons, forGrade, gatePage, mount, mountPanel };
