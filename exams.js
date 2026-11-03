const express = require("express");
const { listTeachers, getTeacher, getSettings, maxOf } = require("./settings");
const { Report } = require("./grades");

// Interactive exams: a teacher's paper exam taken online, timed and marked on the server. The answer key never leaves
// the server. A student has one attempt; her answers are saved as she goes, and the attempt closes itself at the deadline.
// The score is for following up until the teacher approves it: then it goes into الاختبار الأول or الثاني on the card
// (the user chose this, 2026-11-03), through the panel's own edit so the change is logged and can be undone.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS exam_attempts (
  exam            TEXT NOT NULL,
  national_id     TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline        TIMESTAMPTZ NOT NULL,
  answers         JSONB NOT NULL DEFAULT '{}',
  submitted_at    TIMESTAMPTZ,
  auto_submitted  BOOLEAN NOT NULL DEFAULT false,
  score           NUMERIC,
  approved_at     TIMESTAMPTZ,
  approved_field  TEXT,
  approved_value  NUMERIC,
  PRIMARY KEY (exam, national_id)
);
CREATE TABLE IF NOT EXISTS exam_state (
  exam        TEXT PRIMARY KEY,
  open        BOOLEAN NOT NULL DEFAULT false,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

// Text marks the page renders: {p:2,1} a point, {f:-2/3} a fraction, {e:ص = 3س + 1} an equation, {d:90} degrees.
const FAIZA = 1;
const EXAMS = [{
  key: "parallel-perpendicular",
  title: "اختبار الباب الثاني: التوازي والتعامد",
  subject: "الرياضيات 1", book: "رياضيات 1", grade: 1, semester: "الفصل الدراسي الأول",
  minutes: 60, total: 20, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختيار من متعدد", marks: 10, hint: "اختاري الإجابة الصحيحة لكل فقرة (لكل فقرة نصف درجة).", items: [
      ["المستقيمان اللذان لا يتقاطعان ولا يقعان في مستوى واحد يسمّيان:", ["متخالفين", "متوازيين", "متعامدين", "متقاطعين"], 0],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن كل زاويتين متبادلتين داخليًا تكونان:", ["متكاملتين", "متتامّتين", "متطابقتين", "غير متطابقتين"], 2],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن كل زاويتين متناظرتين تكونان:", ["مجموعهما {d:90}", "مجموعهما {d:180}", "مجموعهما {d:360}", "متطابقتين"], 3],
      ["مجموع قياسي زاويتين متحالفتين (داخليتين على جهة واحدة من القاطع) عند توازي المستقيمين يساوي:", ["{d:180}", "{d:90}", "{d:360}", "{d:120}"], 0],
      ["إذا كانت الزاويتان 1 و 2 متحالفتين، وكان {e:ق∠1 = 65°}، والمستقيمان متوازيان، فإن ق∠2 يساوي:", ["{d:25}", "{d:65}", "{d:295}", "{d:115}"], 3],
      ["قطع قاطع مستقيمين متوازيين، وكان قياسا زاويتين متبادلتين خارجيًا {e:(3س + 10)°} و {e:(5س − 30)°}، فإن قيمة س تساوي:", ["10", "20", "15", "25"], 1],
      ["إذا قطع قاطع مستقيمين وكانت زاويتان متناظرتان متطابقتين، فإن المستقيمين:", ["متخالفان", "متقاطعان", "متوازيان", "متعامدان"], 2],
      ["إذا كان مستقيم عموديًا على أحد مستقيمين متوازيين في المستوى نفسه، فإنه:", ["يوازي المستقيم الآخر", "عمودي على المستقيم الآخر", "ينطبق على المستقيم الآخر", "يقطع المستقيم الآخر بزاوية {d:45}"], 1],
      ["ميل المستقيم المار بالنقطتين {p:2,1} و {p:4,7} يساوي:", ["{f:1/3}", "2", "3", "6"], 2],
      ["ميل المستقيم الأفقي يساوي:", ["0", "1", "{e:−1}", "غير معرّف"], 0],
      ["ميل المستقيم الرأسي:", ["0", "1", "{e:−1}", "غير معرّف"], 3],
      ["ميل أي مستقيم يوازي المستقيم {e:ص = −2س + 5} يساوي:", ["2", "{e:−2}", "{f:1/2}", "5"], 1],
      ["ميل المستقيم العمودي على مستقيم ميله 4 يساوي:", ["4", "{e:−4}", "{f:1/4}", "{f:-1/4}"], 3],
      ["المستقيمان اللذان ميلاهما {f:3/2} و {f:-2/3} يكونان:", ["متوازيين", "متعامدين", "متقاطعين وغير متعامدين", "منطبقين"], 1],
      ["معادلة المستقيم الذي ميله 3 ومقطعه الصادي {e:−2} هي:", ["{e:ص = −2س + 3}", "{e:ص = 2س − 3}", "{e:ص = 3س − 2}", "{e:ص = 3س + 2}"], 2],
      ["معادلة المستقيم المار بالنقطة {p:1,5} وميله 2 بصيغة الميل ونقطة هي:", ["{e:ص − 1 = 2(س − 5)}", "{e:ص + 5 = 2(س + 1)}", "{e:ص − 5 = 2(س − 1)}", "{e:ص − 2 = 5(س − 1)}"], 2],
      ["معادلة المستقيم المار بالنقطتين {p:0,3} و {p:2,7} هي:", ["{e:ص = 2س + 3}", "{e:ص = 3س + 2}", "{e:ص = 2س − 3}", "{e:ص = 4س + 3}"], 0],
      ["المسافة بين نقطة ومستقيم لا تنتمي إليه هي طول:", ["أي قطعة مستقيمة تصل بين النقطة والمستقيم", "القطعة المستقيمة العمودية من النقطة إلى المستقيم", "أطول قطعة مستقيمة بين النقطة والمستقيم", "القطعة المستقيمة الموازية للمستقيم"], 1],
      ["المسافة بين النقطة {p:3,4} والمستقيم {e:س = 7} تساوي:", ["3", "7", "11", "4"], 3],
      ["المسافة بين المستقيمين المتوازيين {e:ص = 2} و {e:ص = −3} تساوي:", ["5", "1", "6", "2"], 0],
    ] },
    { key: "t", type: "tf", title: "السؤال الثاني: صح وخطأ", marks: 5, hint: "اختاري «صح» للعبارة الصحيحة و«خطأ» للعبارة الخاطئة (لكل فقرة نصف درجة).", items: [
      ["المستقيمان المتخالفان يقعان في مستوى واحد.", false],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن الزاويتين المتناظرتين متطابقتان.", true],
      ["الزاويتان المتحالفتان متكاملتان عندما يكون المستقيمان متوازيين.", true],
      ["ميل المستقيم الأفقي يساوي 1.", false],
      ["المستقيمان اللذان ميلاهما 2 و {f:-1/2} متعامدان.", true],
      ["ميل المستقيم المار بالنقطتين {p:1,3} و {p:5,3} يساوي صفرًا.", true],
      ["المستقيمان {e:ص = 3س + 1} و {e:ص = 3س − 4} يتقاطعان في نقطة واحدة.", false],
      ["المسافة بين نقطة ومستقيم هي طول القطعة العمودية من النقطة إلى المستقيم.", true],
      ["ميل المستقيم {e:ص = 4س − 7} يساوي {e:−7}.", false],
      ["الزاويتان المتبادلتان خارجيًا متكاملتان دائمًا عندما يتوازى المستقيمان.", false],
    ] },
    { key: "p", type: "match", title: "السؤال الثالث: المزاوجة", marks: 5, hint: "اختاري لكل عبارة الرمز المناسب من العمود الثاني. انتبهي: فيه رمز زائد (لكل فقرة نصف درجة).",
      choices: [
        ["أ", "2"],
        ["ب", "زاويتان داخليتان على جهة واحدة من القاطع، مجموعهما {d:180} عند توازي المستقيمين"],
        ["ج", "{e:ص − ص₁ = م(س − س₁)}"],
        ["د", "مستقيمان لا يتقاطعان ولا يقعان في مستوى واحد"],
        ["هـ", "{f:-3/2}"],
        ["و", "طول القطعة المستقيمة العمودية من النقطة إلى المستقيم"],
        ["ز", "مستقيم يقطع مستقيمين أو أكثر في نقاط مختلفة"],
        ["ح", "مستقيمان لا يتقاطعان أبدًا ويقعان في المستوى نفسه"],
        ["ط", "{e:ص = م س + ب}"],
        ["ي", "زاويتان داخليتان على جهتين مختلفتين من القاطع، وهما متطابقتان عند توازي المستقيمين"],
        ["ك", "زاويتان في الموضع نفسه بالنسبة إلى القاطع والمستقيمين"],
      ],
      items: [
        ["المستقيمان المتخالفان", "د"],
        ["المستقيمان المتوازيان", "ح"],
        ["القاطع", "ز"],
        ["الزاويتان المتبادلتان داخليًا (عند توازي المستقيمين)", "ي"],
        ["الزاويتان المتحالفتان", "ب"],
        ["ميل المستقيم المار بالنقطتين {p:1,2} و {p:3,6}", "أ"],
        ["ميل المستقيم العمودي على مستقيم ميله {f:2/3}", "هـ"],
        ["صيغة الميل والمقطع", "ط"],
        ["صيغة الميل ونقطة", "ج"],
        ["المسافة بين نقطة ومستقيم", "و"],
      ] },
  ],
}];

// Each item gets an id (m1…m20, t1…, p1…) and the same weight: the section's marks over its items.
for (const ex of EXAMS) {
  ex.items = [];
  for (const s of ex.sections) {
    s.weight = s.marks / s.items.length;
    s.items = s.items.map((it, i) => {
      const id = s.key + (i + 1);
      const item = s.type === "mcq" ? { id, q: it[0], options: it[1], answer: it[2] }
        : s.type === "tf" ? { id, q: it[0], answer: it[1] } : { id, q: it[0], answer: it[1] };
      ex.items.push({ ...item, section: s.key, type: s.type, weight: s.weight, n: i + 1 });
      return item;
    });
  }
  ex.byId = Object.fromEntries(ex.items.map(i => [i.id, i]));
}
const BY_KEY = Object.fromEntries(EXAMS.map(e => [e.key, e]));
const SUBJECT = "رياضيات";
const GRACE_MS = 2 * 60 * 1000;
const round2 = n => Math.round(n * 100) / 100;

// What the page gets: the questions without their answers.
const publicSections = ex => ex.sections.map(s => ({ key: s.key, type: s.type, title: s.title, marks: s.marks, hint: s.hint,
  choices: s.choices?.map(([sym, text]) => ({ sym, text })),
  items: s.items.map(({ id, q, options }) => ({ id, q, ...(options ? { options } : {}) })) }));
const meta = ex => ({ key: ex.key, title: ex.title, subject: ex.subject, grade: ex.grade, gradeLabel: Report.GRADES[ex.grade - 1],
  semester: ex.semester, minutes: ex.minutes, total: ex.total, count: ex.items.length,
  sections: ex.sections.map(s => ({ key: s.key, title: s.title, marks: s.marks, count: s.items.length })) });

// Only answers the exam has, in the shape each item takes.
function cleanAnswers(ex, raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw)) {
    const it = ex.byId[id];
    if (!it) continue;
    if (it.type === "mcq" && Number.isInteger(v) && v >= 0 && v < it.options.length) out[id] = v;
    else if (it.type === "tf" && typeof v === "boolean") out[id] = v;
    else if (it.type === "match" && ex.sections.find(s => s.key === it.section).choices.some(c => c[0] === v)) out[id] = v;
  }
  return out;
}

// The mark and, per section, the marks and the items right.
function grade(ex, answers) {
  const parts = Object.fromEntries(ex.sections.map(s => [s.key, { title: s.title, marks: s.marks, score: 0, right: 0, count: s.items.length }]));
  const right = {};
  for (const it of ex.items) {
    const ok = answers?.[it.id] === it.answer;
    right[it.id] = ok;
    if (ok) { parts[it.section].score += it.weight; parts[it.section].right++; }
  }
  for (const p of Object.values(parts)) p.score = round2(p.score);
  const score = round2(Object.values(parts).reduce((a, p) => a + p.score, 0));
  return { score, total: ex.total, parts: Object.values(parts), right };
}

// The owner's math panels: a student of the exam is on one of them.
const ownerPanels = ex => listTeachers().filter(t => t.active !== false && (t.id === ex.owner || t.owner_id === ex.owner)
  && (!t.subject || String(t.subject).includes(SUBJECT)));
const panelExams = (role, login, subject) =>
  role !== "teacher" ? [] : EXAMS.filter(e => e.owner === login && (!subject || String(subject).includes(SUBJECT)));

const idOf = v => String(v ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
const firstName = name => String(name || "").trim().split(/\s+/)[0] || "";

async function studentOf(pool, ex, id) {
  const panels = ownerPanels(ex).map(t => t.id);
  if (!panels.length) return null;
  const { rows } = await pool.query("SELECT name, class, email FROM students WHERE national_id = $1 AND teacher_id = ANY($2) ORDER BY teacher_id", [id, panels]);
  if (!rows.length) return null;
  const r = rows.find(x => Report.classParts(x.class)) || rows[0];
  return { name: r.name, class: r.class, email: !!r.email, grade: Report.classParts(r.class)?.grade || null };
}

const isOpen = async (pool, ex) => !!(await pool.query("SELECT open FROM exam_state WHERE exam = $1", [ex.key])).rows[0]?.open;

// Attempts past their deadline (and its grace) close with the answers they saved.
async function closeExpired(pool, ex, id) {
  const { rows } = await pool.query(
    `SELECT national_id, answers FROM exam_attempts WHERE exam = $1 AND submitted_at IS NULL AND deadline + interval '${GRACE_MS / 1000} seconds' < now()
     ${id ? "AND national_id = $2" : ""}`, id ? [ex.key, id] : [ex.key]);
  for (const r of rows) {
    await pool.query("UPDATE exam_attempts SET submitted_at = deadline, auto_submitted = true, score = $3 WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL",
      [ex.key, r.national_id, grade(ex, r.answers).score]);
  }
}

const attemptOf = async (pool, ex, id) => (await pool.query("SELECT * FROM exam_attempts WHERE exam = $1 AND national_id = $2", [ex.key, id])).rows[0] || null;
// What the student sees of her attempt. After she hands it in: her mark by section, not the answer key.
function attemptView(ex, a) {
  if (!a) return { status: "none" };
  if (a.submitted_at) {
    const g = grade(ex, a.answers);
    return { status: "submitted", score: g.score, total: g.total, parts: g.parts.map(({ title, marks, score }) => ({ title, marks, score })),
      auto: a.auto_submitted, submittedAt: a.submitted_at };
  }
  return { status: "in_progress", deadline: a.deadline, answers: a.answers };
}

// A whole class takes it at once on one school network, saving as it goes.
const WINDOW_MS = 10 * 60 * 1000, MAX_HITS = 3000;
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

function mount(app, pool) {
  const json = express.json({ limit: "4kb" });
  const guard = fn => async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (limited(req.ip)) return res.status(429).json({ error: "rate_limited" });
    const ex = BY_KEY[req.params.exam];
    if (!ex) return res.status(404).json({ error: "no_exam" });
    try { await fn(req, res, ex); } catch (err) { console.error(err); res.status(500).json({ error: "server_error" }); }
  };
  // Who she is, and where her attempt stands. Her first name and class only: anyone can type an ID.
  const who = async (ex, id) => {
    if (id.length < 9 || id.length > 10) return { error: [400, "invalid_id"] };
    const s = await studentOf(pool, ex, id);
    if (!s) return { error: [404, "not_found"] };
    if (s.grade && s.grade !== ex.grade) return { error: [403, "wrong_grade"], s };
    return { s };
  };

  app.get("/api/exams/:exam", guard(async (req, res, ex) => res.json({ ...meta(ex), open: await isOpen(pool, ex) })));

  app.post("/api/exams/:exam/student", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id), w = await who(ex, id);
    if (w.error) return res.status(w.error[0]).json({ error: w.error[1], gradeLabel: Report.GRADES[ex.grade - 1] });
    await closeExpired(pool, ex, id);
    res.json({ name: firstName(w.s.name), classLabel: Report.classLabel(w.s.class), email: w.s.email, open: await isOpen(pool, ex),
      now: new Date(), ...attemptView(ex, await attemptOf(pool, ex, id)) });
  }));

  // Starting (or coming back to) her attempt. The clock starts once, here, and runs on the server.
  app.post("/api/exams/:exam/start", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id), w = await who(ex, id);
    if (w.error) return res.status(w.error[0]).json({ error: w.error[1] });
    await closeExpired(pool, ex, id);
    let a = await attemptOf(pool, ex, id);
    if (!a) {
      if (!(await isOpen(pool, ex))) return res.status(423).json({ error: "closed" });
      await pool.query(`INSERT INTO exam_attempts (exam, national_id, deadline) VALUES ($1, $2, now() + interval '${ex.minutes} minutes') ON CONFLICT DO NOTHING`, [ex.key, id]);
      a = await attemptOf(pool, ex, id);
    }
    res.json({ now: new Date(), sections: publicSections(ex), ...attemptView(ex, a) });
  }));

  // Saved as she goes; the last save before the deadline is what gets marked if time runs out.
  app.post("/api/exams/:exam/answers", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id);
    const answers = cleanAnswers(ex, req.body?.answers);
    const { rowCount } = await pool.query(
      `UPDATE exam_attempts SET answers = $3 WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL
       AND now() < deadline + interval '${GRACE_MS / 1000} seconds'`, [ex.key, id, JSON.stringify(answers)]);
    if (!rowCount) {
      await closeExpired(pool, ex, id);
      const a = await attemptOf(pool, ex, id);
      return res.status(a ? 409 : 404).json({ error: a ? "closed" : "not_started", ...attemptView(ex, a) });
    }
    res.json({ ok: true, saved: Object.keys(answers).length });
  }));

  app.post("/api/exams/:exam/submit", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id);
    const answers = cleanAnswers(ex, req.body?.answers);
    const { rows } = await pool.query(
      `UPDATE exam_attempts SET answers = $3, submitted_at = now(), score = $4 WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL
       AND now() < deadline + interval '${GRACE_MS / 1000} seconds' RETURNING *`, [ex.key, id, JSON.stringify(answers), grade(ex, answers).score]);
    if (!rows.length) await closeExpired(pool, ex, id);
    const a = rows[0] || await attemptOf(pool, ex, id);
    if (!a) return res.status(404).json({ error: "not_started" });
    res.json(attemptView(ex, a));
  }));
}

// The panel's «الاختبارات» tab: the owner teacher only. applyGrade(client, tid, nationalId, field, value) is the panel's
// own logged edit of a student (admin.js), so an approval shows in the audit log and undoes like any edit.
function mountPanel(router, pool, { applyGrade }) {
  const mine = req => panelExams(req.role, req.login, getTeacher(req.tid)?.subject);
  const pick = (req, res) => {
    if (req.role !== "teacher") { res.status(403).json({ error: "forbidden", errors: ["الاختبارات التفاعلية تشوفها المعلمة صاحبتها فقط"] }); return null; }
    const ex = mine(req).find(e => e.key === req.params.exam);
    if (!ex) { res.status(404).json({ error: "not_found" }); return null; }
    return ex;
  };

  router.get("/exams", async (req, res) => {
    if (req.role !== "teacher") return res.status(403).json({ error: "forbidden", errors: ["الاختبارات التفاعلية تشوفها المعلمة صاحبتها فقط"] });
    const list = mine(req);
    const out = [];
    for (const ex of list) {
      await closeExpired(pool, ex);
      const { rows } = await pool.query(
        `SELECT s.national_id, s.name, s.class, s.test1, s.test2, a.started_at, a.deadline, a.answers, a.submitted_at, a.auto_submitted,
           a.approved_at, a.approved_field, a.approved_value
         FROM students s LEFT JOIN exam_attempts a ON a.exam = $2 AND a.national_id = s.national_id
         WHERE s.teacher_id = $1 ORDER BY s.class NULLS LAST, s.name`, [req.tid, ex.key]);
      // Her students in the exam's grade, and anyone of hers who took it anyway.
      const students = rows.filter(r => r.started_at || !Report.classParts(r.class) || Report.classParts(r.class).grade === ex.grade).map(r => {
        const base = { id: r.national_id, name: r.name, class: r.class, test1: r.test1 == null ? null : Number(r.test1), test2: r.test2 == null ? null : Number(r.test2) };
        if (!r.started_at) return { ...base, status: "none" };
        const g = grade(ex, r.answers);
        return { ...base, status: r.submitted_at ? "submitted" : "in_progress", startedAt: r.started_at, deadline: r.deadline, submittedAt: r.submitted_at,
          auto: r.auto_submitted, answered: Object.keys(r.answers || {}).length, answers: r.answers,
          ...(r.submitted_at ? { score: g.score, parts: g.parts.map(p => p.score), right: g.right } : {}),
          approved: r.approved_at ? { at: r.approved_at, field: r.approved_field, value: Number(r.approved_value) } : null };
      });
      const sections = ex.sections.map(s => ({ key: s.key, type: s.type, title: s.title, marks: s.marks, choices: s.choices?.map(([sym, text]) => ({ sym, text })),
        items: s.items.map(({ id, q, options, answer }) => ({ id, q, options, answer })) }));
      out.push({ ...meta(ex), open: await isOpen(pool, ex), sections, students });
    }
    res.json({ max: maxOf(getSettings(req.tid)).test, exams: out });
  });

  router.put("/exams/:exam/open", async (req, res) => {
    const ex = pick(req, res);
    if (!ex) return;
    const open = !!req.body?.open;
    await pool.query("INSERT INTO exam_state (exam, open, changed_at) VALUES ($1, $2, now()) ON CONFLICT (exam) DO UPDATE SET open = EXCLUDED.open, changed_at = now()", [ex.key, open]);
    res.json({ ok: true, open });
  });

  // Lets a student take it again (a dropped connection, a mistake): her attempt is removed.
  router.delete("/exams/:exam/attempts/:id", async (req, res) => {
    const ex = pick(req, res);
    if (!ex) return;
    const own = await pool.query("SELECT 1 FROM students WHERE teacher_id = $1 AND national_id = $2", [req.tid, req.params.id]);
    if (!own.rowCount) return res.status(404).json({ error: "not_found" });
    await pool.query("DELETE FROM exam_attempts WHERE exam = $1 AND national_id = $2", [ex.key, req.params.id]);
    res.json({ ok: true });
  });

  // Puts the marks of handed-in attempts into الاختبار الأول or الثاني, scaled to the teacher's maximum.
  router.post("/exams/:exam/approve", async (req, res) => {
    const ex = pick(req, res);
    if (!ex) return;
    const field = req.body?.field;
    if (!["test1", "test2"].includes(field)) return res.status(400).json({ error: "invalid", errors: ["اختاري الاختبار الأول أو الثاني"] });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(idOf).filter(Boolean).slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ error: "invalid", errors: ["ما فيه طالبات للاعتماد"] });
    await closeExpired(pool, ex);
    const max = maxOf(getSettings(req.tid)).test;
    const { rows } = await pool.query(
      `SELECT a.national_id, a.answers FROM exam_attempts a JOIN students s ON s.national_id = a.national_id AND s.teacher_id = $3
       WHERE a.exam = $1 AND a.national_id = ANY($2) AND a.submitted_at IS NOT NULL`, [ex.key, ids, req.tid]);
    const client = await pool.connect();
    const done = [];
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        const value = round2((grade(ex, r.answers).score * max) / ex.total);
        await applyGrade(client, req.tid, r.national_id, field, value);
        await client.query("UPDATE exam_attempts SET approved_at = now(), approved_field = $3, approved_value = $4 WHERE exam = $1 AND national_id = $2",
          [ex.key, r.national_id, field, value]);
        done.push({ id: r.national_id, value });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, field, max, done });
  });
}

module.exports = { SCHEMA, EXAMS, panelExams, grade, mount, mountPanel };
