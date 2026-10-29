// Early alerts: the teacher's panel lists the students whose grades are low or dropping, or who are often late,
// so she steps in early. Each alert says why in numbers. A follow-up she records moves the student aside until
// her numbers get worse again. The thresholds are the teacher's settings (alert_*); an empty one is off.
const { Report } = require("./grades");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS followups (
  id          SERIAL PRIMARY KEY,
  teacher_id  INT NOT NULL,
  national_id TEXT NOT NULL,
  action      TEXT NOT NULL,
  note        TEXT,
  -- What the alert showed when she followed up, so a later drop brings it back.
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followups_student ON followups (teacher_id, national_id, created_at DESC);`;

const ACTIONS = ["كلمتها", "تواصلت مع ولي الأمر", "حصة تقوية", "حوّلتها للموجهة", "غيرها"];
const NOTE_MAX = 500;

// Setting key → what it measures. Defaults live in settings.js.
const KEYS = ["alert_below", "alert_urgent", "alert_test_drop", "alert_term_drop", "alert_class_gap", "alert_participation", "alert_lateness"];

const fmt = Report.fmt;
// Arabic counting: 1 درجة, 2 درجتين, 3–10 درجات, 11+ درجة. A fraction reads with the singular.
const count = (n, [one, two, few, many]) => {
  if (!Number.isInteger(n)) return `${fmt(n)} ${one}`;
  return n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
};
const DEGREES = ["درجة", "درجتين", "درجات", "درجة"];
const POINTS = ["نقطة", "نقطتين", "نقاط", "نقطة"];
const TIMES = ["مرة", "مرتين", "مرات", "مرة"];

// The parts a class is graded in. Homework and the final exam only once their maximum is set.
const PARTS = [["test1", "الاختبار الأول"], ["test2", "الاختبار الثاني"], ["participation", "المشاركة"], ["projects", "المشاريع والمهام"],
  ["homework", "الواجبات", "homework"], ["final_exam", "الاختبار النهائي", "final"]];
// A part counts as missing for a student when most of her class (and at least this many) has it.
const MISSING_SHARE = 0.6, MISSING_MIN = 3;

const on = v => v != null && v !== "" && Number.isFinite(Number(v));

// Every student's alert, worked out from the panel's rows (students), her archived terms (history: id → [{pct}]),
// the teacher's maximum scores and settings. Students without a signal are left out.
function compute(students, history, max, settings) {
  const th = Object.fromEntries(KEYS.map(k => [k.slice(6), on(settings[k]) ? Number(settings[k]) : null]));
  const byClass = new Map();
  for (const s of students) (byClass.get(s.class ?? "") || byClass.set(s.class ?? "", []).get(s.class ?? "")).push(s);
  const classPct = new Map([...byClass].map(([c, list]) => [c, c ? Report.classStats(list.filter(s => !s.learning_difficulty), max)?.pct ?? null : null]));
  const parts = PARTS.filter(p => !p[2] || max[p[2]] > 0);
  // Which parts most of each class has been graded in.
  const graded = new Map([...byClass].map(([c, list]) => [c, parts.filter(([f]) => {
    const n = list.filter(s => s[f] != null).length;
    return list.length >= MISSING_MIN && n >= MISSING_MIN && n / list.length >= MISSING_SHARE;
  })]));

  const out = [];
  for (const s of students) {
    const sc = Report.scores(s, max);
    const pct = sc.pct;
    const prev = (history[s.national_id] || []).filter(h => h.pct != null).pop()?.pct ?? null;
    const cls = s.learning_difficulty ? null : classPct.get(s.class ?? "");
    const late = on(s.lateness) ? Number(s.lateness) : null;
    const signals = [];
    const add = (key, sev, text) => signals.push({ key, sev, text });

    if (th.below != null && pct != null && pct < th.below) add("below", "low", `النسبة ${pct}% (أقل من ${th.below}%)`);
    if (th.test_drop != null && sc.t1 != null && sc.t2 != null) {
      const d = Math.round((sc.t1 - sc.t2) * 100) / 100;
      if (d > 0 && d >= th.test_drop) add("test_drop", d >= th.test_drop * 2 ? "low" : "warn", `نزلت ${count(d, DEGREES)} من الاختبار الأول للثاني`);
    }
    if (th.term_drop != null && pct != null && prev != null && prev - pct > 0 && prev - pct >= th.term_drop) {
      add("term_drop", "low", `نزلت عن الفترة السابقة ${count(prev - pct, POINTS)}`);
    }
    if (th.class_gap != null && pct != null && cls != null && cls - pct > 0 && cls - pct >= th.class_gap) {
      add("class_gap", "low", `أقل من متوسط فصلها بـ ${count(cls - pct, POINTS)}`);
    }
    if (th.participation != null && sc.part != null && sc.part < th.participation) {
      add("participation", "warn", `المشاركة ${fmt(sc.part)} من ${fmt(max.participation)}`);
    }
    if (th.lateness != null && late != null && late > 0 && late >= th.lateness) {
      add("lateness", late >= th.lateness * 2 ? "low" : "warn", `تأخير ${count(late, TIMES)}`);
    }
    const missing = (graded.get(s.class ?? "") || []).filter(([f]) => s[f] == null);
    if (missing.length) {
      add("missing", "warn", missing.length === parts.length ? "ما انرصد لها شي من درجات فصلها"
        : missing.length === 1 ? `${missing[0][1]} غير مرصود` : `غير مرصود لها: ${missing.map(m => m[1]).join("، ")}`);
    }
    out.push({
      national_id: s.national_id, name: s.name, class: s.class, learning_difficulty: !!s.learning_difficulty,
      signals, urgent: signals.length >= 2 || (signals.length > 0 && th.urgent != null && pct != null && pct < th.urgent),
      facts: { t1: sc.t1, t2: sc.t2, pct, prev, classPct: cls, lateness: late, part: sc.part },
    });
  }
  return out;
}

// What a follow-up remembers: the reasons and the numbers that can get worse.
const snapshotOf = a => ({ keys: a.signals.map(x => x.key), pct: a.facts.pct, lateness: a.facts.lateness, t2: a.facts.t2 });

// After a follow-up the alert stays aside while nothing got worse: no new reason, no lower percentage, no more lateness.
function worseSince(a, snap) {
  const why = [];
  const fresh = a.signals.filter(x => !(snap.keys || []).includes(x.key));
  if (fresh.length) why.push(...fresh.map(x => x.text));
  if (a.facts.pct != null && snap.pct != null && a.facts.pct < snap.pct) why.push(`نسبتها نزلت من ${snap.pct}% إلى ${a.facts.pct}%`);
  if (a.facts.lateness != null && a.facts.lateness > (snap.lateness ?? 0) && (snap.keys || []).includes("lateness")) {
    why.push(`تأخرت ${count(a.facts.lateness - (snap.lateness ?? 0), TIMES)} بعد المتابعة`);
  }
  return why;
}

// The tab's list. state: "urgent" and "watch" need her; "followed" is aside; "improved" has no reason left after a follow-up.
function board(alerts, followups) {
  const byStudent = new Map();
  for (const f of followups) (byStudent.get(f.national_id) || byStudent.set(f.national_id, []).get(f.national_id)).push(f);
  const items = [];
  for (const a of alerts) {
    const list = byStudent.get(a.national_id) || [];
    const last = list[0] || null;
    let state = null, back = [];
    if (!a.signals.length) state = last ? "improved" : null;
    else if (last) { back = worseSince(a, last.snapshot || {}); state = back.length ? (a.urgent ? "urgent" : "watch") : "followed"; }
    else state = a.urgent ? "urgent" : "watch";
    if (state) items.push({ ...a, state, back, followups: list });
  }
  const order = { urgent: 0, watch: 1, followed: 2, improved: 3 };
  items.sort((x, y) => order[x.state] - order[y.state] || y.signals.length - x.signals.length || (x.facts.pct ?? 101) - (y.facts.pct ?? 101)
    || x.name.localeCompare(y.name, "ar"));
  const counts = { urgent: 0, watch: 0, followed: 0, improved: 0 };
  for (const i of items) counts[i.state]++;
  return { items, counts };
}

module.exports = { SCHEMA, ACTIONS, NOTE_MAX, KEYS, compute, snapshotOf, worseSince, board };
