// The panel's "الدروس" tab: the quiz at the end of every interactive lesson, sorted the way the teacher works.
// 1. She picks the grade and the class, and sees that grade's lessons as cards (who solved, the average, the hardest question).
// 2. A lesson opens its page: how the class did in each question, the wrong answer chosen most, and every student with a
//    ✓/✗ square per question.
// 3. A student opens her answer sheet: each question, what she chose and the right answer.
// The first attempt counts; later ones are practice. For following up only, never part of the result card.
// Runs inside admin.html and uses its helpers ($, esc, api, levelPill, Report, withT, toast).
const LessonResults = (() => {
  let data = null, grade = null, cls = "", key = null, sid = null, missing = false;
  const detail = new Map();
  const host = () => $("#lessonsPanel");
  const pct = r => Math.round((100 * r.score) / r.total);
  const when = at => new Date(at).toLocaleDateString("ar-SA-u-nu-latn", { day: "numeric", month: "long" });
  const gradeOf = c => Report.classParts(c)?.grade || null;
  // A class whose name has no grade (an old "1"/"2") shows under every grade, as the library shows it every lesson.
  const inGrade = s => !gradeOf(s.class) || gradeOf(s.class) === grade;
  // Math runs come wrapped in left-to-right isolates (U+2066 … U+2069); each becomes a <bdi dir="ltr">, innermost first.
  const rich = t => {
    let h = esc(t || ""), prev;
    do { prev = h; h = h.replace(/\u2066([^\u2066\u2069]*)\u2069/g, '<bdi dir="ltr">$1</bdi>'); } while (h !== prev);
    return h.replace(/[\u2066-\u2069]/g, "");
  };
  // A question cut short for its tile, keeping its math runs closed so they still read left to right.
  const cut = (t, n) => {
    const s = String(t || "");
    if (s.replace(/[\u2066-\u2069]/g, "").length <= n) return s;
    let out = "", len = 0, open = 0;
    for (const ch of s) {
      if (ch === "\u2066") open++; else if (ch === "\u2069") open--; else if (++len > n - 1) break;
      out += ch;
    }
    return out.trim() + "\u2069".repeat(Math.max(open, 0)) + "…";
  };
  // A tile shows the question's opening words (بسّطي:، أوجدي الناتج:); the whole question is in its tooltip.
  const tileText = t => { const head = String(t || "").split("\u2066")[0].trim(); return head.length >= 3 ? esc(cut(head, 26)) : rich(cut(t, 22)); };
  const tone = p => (p == null ? "none" : p >= 75 ? "good" : p >= 60 ? "warn" : "low");

  async function load() {
    if (!data) host().innerHTML = '<div class="card note" style="padding:20px">جاري التحميل…</div>';
    try { data = await api("/lessons"); detail.clear(); }
    catch { host().innerHTML = '<div class="card note" style="padding:20px">تعذّر تحميل نتائج الدروس. حاولي مرة ثانية.</div>'; return; }
    if (key) await loadLesson(key); else render();
  }

  async function loadLesson(k) {
    key = k;
    if (!detail.has(k)) {
      host().querySelector(".lr-detail")?.classList.add("lr-busy");
      try { detail.set(k, await api(`/lessons/${encodeURIComponent(k)}`)); }
      catch { toast("تعذّر فتح الدرس. حاولي مرة ثانية."); key = null; }
    }
    render();
  }

  // Per question: how many of these students got it right, and the wrong answer chosen most.
  function analyse(lesson, rows) {
    const withAns = rows.filter(s => s.result?.answers);
    return Array.from({ length: lesson.total }, (_, q) => {
      const as = withAns.map(s => s.result.answers.find(a => a.q === q)).filter(Boolean);
      const right = as.filter(a => a.ok).length, wrong = {};
      for (const a of as) if (!a.ok && a.p) wrong[a.p] = (wrong[a.p] || 0) + 1;
      const top = Object.entries(wrong).sort((x, y) => y[1] - x[1])[0];
      const sample = as.find(a => a.t);
      return { q, n: as.length, pct: as.length ? Math.round((100 * right) / as.length) : null, text: sample?.t || "",
        right: as.find(a => !a.ok && a.r)?.r || as.find(a => a.ok)?.p || "", top: top ? { p: top[0], n: top[1] } : null };
    });
  }
  // The same from the overview's marks, for a lesson's card.
  function hardest(lesson, list) {
    const ms = list.map(s => s.results[lesson.key]?.marks).filter(Boolean);
    if (!ms.length) return null;
    let worst = null;
    for (let q = 0; q < lesson.total; q++) {
      const ok = ms.filter(m => m[q] === "1").length;
      if (!worst || ok < worst.ok) worst = { q, ok, n: ms.length };
    }
    return worst && worst.ok < worst.n ? worst : null;
  }

  const dots = (lesson, r) => {
    if (!r) return `<div class="lr-dots">${"<span></span>".repeat(Math.min(lesson.total, 15))}</div>`;
    if (!r.marks) return '<span class="note" title="حلّت الاختبار قبل ما نبدأ نحفظ الإجابات، فعندها الدرجة بس">الدرجة فقط</span>';
    return `<div class="lr-dots" aria-label="${[...r.marks].map((m, q) => `س${q + 1} ${m === "1" ? "صح" : "خطأ"}`).join("، ")}">${[...r.marks].map((m, q) =>
      `<span class="${m === "1" ? "ok" : "no"}" title="س${q + 1}">${m === "1" ? "✓" : "✗"}</span>`).join("")}</div>`;
  };

  function render() {
    const lib = '<a class="btn sm quiet" href="/lessons" target="_blank" rel="noopener">فتح مكتبة الدروس</a>';
    if (!data.lessons.length) {
      host().innerHTML = `<div class="card"><div class="toolbar"><div class="grow note">الدروس التفاعلية الحالية لمادة الرياضيات. أول ما تحل طالباتك اختبار درس، تظهر درجاتهن هنا.</div>${lib}</div></div>`;
      return;
    }
    // The grades come from her lessons; she starts on the grade most of her students are in.
    const grades = [...new Set(data.lessons.map(l => l.grade))].sort();
    if (!grades.includes(grade)) {
      const count = g => data.students.filter(s => gradeOf(s.class) === g).length;
      grade = grades.slice().sort((a, b) => count(b) - count(a))[0];
    }
    const lesson = key && data.lessons.find(l => l.key === key);
    if (lesson && lesson.grade !== grade) grade = lesson.grade;
    const inG = data.students.filter(inGrade);
    const classes = [...new Set(inG.map(s => s.class).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "ar"));
    if (cls && !classes.includes(cls)) cls = "";
    const list = inG.filter(s => !cls || s.class === cls);
    const chip = (attr, v, label, on) => `<button type="button" ${attr}="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
    const bar = `<div class="toolbar lr-bar">
        ${grades.length > 1 ? `<span class="note">الصف</span><div class="al-chips">${grades.map(g => chip("data-lr-grade", g, Report.GRADES[g - 1], g === grade)).join("")}</div>` : `<b>${esc(Report.GRADES[grade - 1])}</b>`}
        ${classes.length > 1 ? `<span class="note lr-gap">الفصل</span><div class="al-chips">${chip("data-lr-cls", "", "كل الفصول", !cls)}${classes.map(c => chip("data-lr-cls", c, Report.classLabel(c), c === cls)).join("")}</div>` : ""}
        <div class="grow"></div>${lib}</div>`;

    let body;
    if (!lesson) {
      key = null; sid = null;
      const mine = data.lessons.filter(l => l.grade === grade);
      body = `<div class="lr-note note">درجة <b>أول محاولة</b> في اختبار آخر كل درس، للمتابعة فقط وما تدخل في بطاقة النتيجة. اضغطي على درس لتشوفين إجابات كل طالبة.</div>
        <div class="lr-cards">${mine.map(l => {
          const rs = list.map(s => s.results[l.key]).filter(Boolean);
          const avg = rs.length ? Math.round(rs.reduce((a, r) => a + pct(r), 0) / rs.length) : null;
          const h = hardest(l, list), share = list.length ? Math.round((100 * rs.length) / list.length) : 0;
          return `<button type="button" class="lr-card" data-lr-open="${esc(l.key)}">
            <span class="lr-title">${esc(l.name)}</span>
            <span class="note">الدرس <bdi dir="ltr">${esc(l.ref)}</bdi> · ${esc(l.title)} · ${l.total} ${l.total > 10 ? "سؤالًا" : "أسئلة"}</span>
            <span class="lr-prog"><b style="width:${share}%"></b></span>
            <span class="lr-row"><span>حلّت <b>${rs.length} من ${list.length}</b></span>${avg != null ? `<span>المتوسط ${levelPill(avg)}</span>` : ""}</span>
            <span class="lr-hint ${h ? "low" : ""}">${h ? `أصعب سؤال: س${h.q + 1} (صحّحته ${h.ok} من ${h.n})` : rs.length ? (list.length - rs.length ? `${list.length - rs.length} ما حلّت بعد` : "حلّت الكل ✓") : "ما حلّت أي طالبة بعد"}</span>
          </button>`;
        }).join("") || '<div class="note" style="padding:8px 4px">ما فيه دروس لهذا الصف.</div>'}</div>`;
    } else body = lessonPage(lesson, list);
    host().innerHTML = `<div class="card">${bar}${body}</div>`;
    bind();
  }

  function lessonPage(lesson, list) {
    const d = detail.get(lesson.key);
    if (!d) return '<div class="note" style="padding:20px">جاري التحميل…</div>';
    const ids = new Set(list.map(s => s.id));
    const rows = d.students.filter(s => ids.has(s.id));
    const done = rows.filter(s => s.result), notDone = rows.filter(s => !s.result);
    const qs = analyse(lesson, rows), withAns = done.filter(s => s.result.answers).length;
    const worst = qs.filter(q => q.pct != null && q.pct < 100).sort((a, b) => a.pct - b.pct)[0];
    const avg = done.length ? Math.round(done.reduce((a, s) => a + pct(s.result), 0) / done.length) : null;
    const shown = missing ? notDone : [...done, ...notDone];
    if (sid && !rows.some(s => s.id === sid && s.result)) sid = null;
    const showCls = !cls;
    const row = s => {
      const r = s.result;
      return `<tr class="${s.id === sid ? "sel" : ""}"><td class="name">${esc(s.name)}</td>${showCls ? `<td>${esc(Report.shortClass(s.class))}</td>` : ""}
        <td class="num">${r ? `${r.score} من ${r.total} ${levelPill(pct(r))}` : '<span class="pill none">لم تحل</span>'}</td>
        <td>${dots(lesson, r)}</td>
        <td class="num" title="${r ? esc(`أول محاولة ${when(r.at)}`) : ""}">${r ? (r.attempts > 1 ? `${r.attempts} · أفضلها ${r.best}` : "1") : "—"}</td>
        <td>${r ? `<button type="button" class="btn sm ${s.id === sid ? "" : "quiet"}" data-lr-sheet="${esc(s.id)}">الإجابات</button>` : ""}</td></tr>`;
    };
    const strip = withAns ? `<div class="note" style="margin-top:4px">نسبة الإجابات الصحيحة في كل سؤال (${withAns} ${withAns === 1 ? "طالبة" : "طالبات"}):</div>
      <div class="lr-qs">${qs.map(q => `<div class="lr-q ${tone(q.pct)}" title="${esc(q.text.replace(/[⁦-⁩]/g, ""))}">س${q.q + 1}<b>${q.pct == null ? "—" : q.pct + "%"}</b><span>${tileText(q.text)}</span></div>`).join("")}</div>
      ${worst ? `<div class="lr-tip">س${worst.q + 1} أصعب سؤال: صحّحته ${worst.pct}% بس.${worst.top && worst.top.n > 1 ? ` أكثر إجابة غلط: <b>«${rich(worst.top.p)}»</b> (${worst.top.n} طالبات)${worst.right ? ` بدل <b>«${rich(worst.right)}»</b>` : ""}.` : ""} ممكن يحتاج إعادة شرح.</div>` : ""}`
      : done.length ? '<div class="lr-tip">اللي حلّوا هذا الدرس حلّوه قبل ما نبدأ نحفظ الإجابات، فعندهن الدرجة بس. الإجابات تظهر من أول طالبة تحل من الحين وطالع.</div>' : "";
    const student = sid && rows.find(s => s.id === sid);
    return `<div class="lr-detail">
      <div class="lr-head"><button type="button" class="btn sm quiet" data-lr-back>→ كل الدروس</button>
        <div class="grow"><b class="lr-title">${esc(lesson.name)}</b> <span class="note">· الدرس <bdi dir="ltr">${esc(lesson.ref)}</bdi> · ${esc(cls ? Report.classLabel(cls) : "كل الفصول")} · حلّت ${done.length} من ${rows.length}${avg != null ? ` · المتوسط ${avg}%` : ""}</span></div>
        <div class="lr-acts">${notDone.length ? `<button type="button" class="btn sm ${missing ? "" : "quiet"}" data-lr-missing aria-pressed="${missing}">اللي ما حلّت (${notDone.length})</button>` : ""}
          <a class="btn sm quiet" href="${withT(`/api/admin/lessons/${encodeURIComponent(lesson.key)}/export${cls ? `?class=${encodeURIComponent(cls)}` : ""}`)}">تنزيل إكسل</a>
          <button type="button" class="btn sm quiet" data-lr-print>طباعة / PDF</button></div></div>
      ${strip}
      <div class="lr-split${student ? " open" : ""}">
        <div class="table-wrap"><table>
          <thead><tr><th>الطالبة</th>${showCls ? "<th>الفصل</th>" : ""}<th class="num">الدرجة</th><th>الأسئلة ${lesson.total > 1 ? `<span class="note">(س1 ← س${lesson.total})</span>` : ""}</th><th class="num">المحاولات</th><th></th></tr></thead>
          <tbody>${shown.map(row).join("") || `<tr><td colspan="6" class="note">${missing ? "كل الطالبات حلّت ✓" : "ما فيه طالبات."}</td></tr>`}</tbody>
        </table></div>
        ${student ? sheetHTML(lesson, student) : ""}
      </div></div>`;
  }

  function answerRows(r) {
    return r.answers.map(a => `<div class="lr-ans ${a.ok ? "ok" : "no"}"><div class="lr-ans-h"><span>س${a.q + 1} · ${rich(a.t)}</span><span class="pill ${a.ok ? "good" : "low"}">${a.ok ? "صح" : "خطأ"}</span></div>
      <div>إجابتها: <b class="${a.ok ? "lr-ok" : "lr-no"}">${rich(a.p) || "—"}</b></div>${a.ok ? "" : `<div>الصحيحة: <b class="lr-ok">${rich(a.r) || "—"}</b></div>`}</div>`).join("");
  }
  function sheetHTML(lesson, s) {
    const r = s.result;
    return `<aside class="lr-sheet" aria-label="ورقة إجابة ${esc(s.name)}">
      <div class="lr-head"><div class="grow"><b>${esc(s.name)}</b><div class="note">${esc(Report.classLabel(s.class))} · أول محاولة ${esc(when(r.at))} · ${r.score} من ${r.total} ${levelPill(pct(r))}${r.attempts > 1 ? ` · ${r.attempts} محاولات، أفضلها ${r.best}` : ""}</div></div>
        <button type="button" class="btn sm quiet" data-lr-sheet-print>طباعة</button><button type="button" class="btn sm quiet" data-lr-close aria-label="إغلاق">✕</button></div>
      ${r.answers ? answerRows(r) + '<div class="note" style="margin-top:8px">الأسئلة مرتبة حسب الكتاب، حتى لو طلعت لها بترتيب مختلف.</div>'
        : '<div class="lr-tip">حلّت الاختبار قبل ما نبدأ نحفظ الإجابات، فعندها الدرجة بس.</div>'}
    </aside>`;
  }

  // A printable page; the browser saves it as PDF.
  function printPage(title, sub, html) {
    const w = window.open("", "_blank");
    if (!w) return toast("المتصفح منع النافذة. اسمحي بالنوافذ المنبثقة وجربي.");
    w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap">
      <style>body{font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;margin:24px;color:#10242c;font-size:13px}h1{font-size:18px;margin:0}.sub{color:#55707a;margin-bottom:12px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #cddcdc;padding:4px 6px;text-align:start;vertical-align:top}th{background:#eef3f3}
      td.c{text-align:center}.ok{color:#0a7c78;font-weight:700}.no{color:#c0265e;font-weight:700}
      .a{border:1px solid #cddcdc;border-radius:8px;padding:6px 10px;margin:6px 0;break-inside:avoid}.a .h{display:flex;justify-content:space-between;font-weight:600}
      @page{size:A4;margin:12mm}@media print{body{margin:0}button{display:none}}</style></head><body>
      <button onclick="print()" style="float:left;font:inherit;padding:6px 14px">طباعة / حفظ PDF</button>
      <h1>${esc(title)}</h1><div class="sub">${sub}</div>${html}</body></html>`);
    w.document.close();
  }
  function printLesson(lesson) {
    const d = detail.get(lesson.key), ids = new Set(data.students.filter(inGrade).filter(s => !cls || s.class === cls).map(s => s.id));
    const rows = d.students.filter(s => ids.has(s.id)), qs = analyse(lesson, rows), n = lesson.total;
    const body = rows.map(s => { const r = s.result; return `<tr><td>${esc(s.name)}</td><td>${esc(Report.shortClass(s.class))}</td><td class="c">${r ? `${r.score} / ${r.total}` : "لم تحل"}</td>
      ${Array.from({ length: n }, (_, q) => { const m = r?.marks?.[q]; return `<td class="c ${m === "1" ? "ok" : m === "0" ? "no" : ""}">${m === "1" ? "✓" : m === "0" ? "✗" : ""}</td>`; }).join("")}</tr>`; }).join("");
    printPage(`${lesson.name}: نتائج الاختبار`, `${esc(Report.GRADES[lesson.grade - 1])} · ${esc(cls ? Report.classLabel(cls) : "كل الفصول")} · الدرس <bdi dir="ltr">${esc(lesson.ref)}</bdi> · أول محاولة`,
      `<table><thead><tr><th>الطالبة</th><th>الفصل</th><th>الدرجة</th>${Array.from({ length: n }, (_, q) => `<th class="c">س${q + 1}</th>`).join("")}</tr></thead><tbody>${body}
      <tr><th colspan="3">نسبة الصح</th>${qs.map(q => `<th class="c">${q.pct == null ? "" : q.pct + "%"}</th>`).join("")}</tr></tbody></table>`);
  }
  function printSheet(lesson, s) {
    const r = s.result;
    printPage(`ورقة إجابة ${s.name}`, `${esc(lesson.name)} · الدرس <bdi dir="ltr">${esc(lesson.ref)}</bdi> · ${esc(Report.classLabel(s.class))} · أول محاولة ${esc(when(r.at))} · <b>${r.score} من ${r.total}</b>`,
      (r.answers || []).map(a => `<div class="a"><div class="h"><span>س${a.q + 1} · ${rich(a.t)}</span><span class="${a.ok ? "ok" : "no"}">${a.ok ? "✓ صح" : "✗ خطأ"}</span></div>
        <div>إجابتها: <b class="${a.ok ? "ok" : "no"}">${rich(a.p) || "—"}</b>${a.ok ? "" : ` · الصحيحة: <b class="ok">${rich(a.r) || "—"}</b>`}</div></div>`).join("") || "<p>عندها الدرجة بس.</p>");
  }

  function bind() {
    const h = host();
    h.querySelectorAll("[data-lr-grade]").forEach(b => b.onclick = () => { grade = +b.dataset.lrGrade; cls = ""; key = null; sid = null; render(); });
    h.querySelectorAll("[data-lr-cls]").forEach(b => b.onclick = () => { cls = b.dataset.lrCls; sid = null; render(); });
    h.querySelectorAll("[data-lr-open]").forEach(b => b.onclick = () => { sid = null; missing = false; loadLesson(b.dataset.lrOpen); });
    h.querySelector("[data-lr-back]")?.addEventListener("click", () => { key = null; sid = null; missing = false; render(); });
    h.querySelector("[data-lr-missing]")?.addEventListener("click", () => { missing = !missing; render(); });
    const lesson = key && data.lessons.find(l => l.key === key);
    h.querySelector("[data-lr-print]")?.addEventListener("click", () => printLesson(lesson));
    h.querySelectorAll("[data-lr-sheet]").forEach(b => b.onclick = () => {
      sid = sid === b.dataset.lrSheet ? null : b.dataset.lrSheet; render();
      h.querySelector(".lr-sheet")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    h.querySelector("[data-lr-close]")?.addEventListener("click", () => { sid = null; render(); });
    h.querySelector("[data-lr-sheet-print]")?.addEventListener("click", () => printSheet(lesson, detail.get(key).students.find(s => s.id === sid)));
  }

  // A different teacher's panel (the principal switching) starts from a fresh read.
  const reset = () => { data = null; grade = null; cls = ""; key = null; sid = null; missing = false; detail.clear(); };
  return { load, reset };
})();
