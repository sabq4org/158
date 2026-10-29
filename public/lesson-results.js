// The panel's "الدروس" tab: each student's score in the quiz at the end of every interactive lesson. The first attempt
// counts; the best one and the number of attempts show on hover. For following up only, never part of the result card.
// Runs inside admin.html and uses its helpers ($, esc, api, levelPill, Report).
const LessonResults = (() => {
  let data = null, cls = "";
  const host = () => $("#lessonsPanel");
  const pct = r => Math.round((100 * r.score) / r.total);
  const when = at => new Date(at).toLocaleDateString("ar-SA-u-nu-latn", { day: "numeric", month: "long" });

  async function load() {
    if (!data) host().innerHTML = '<div class="card note" style="padding:20px">جاري التحميل…</div>';
    try { data = await api("/lessons"); }
    catch { host().innerHTML = '<div class="card note" style="padding:20px">تعذّر تحميل نتائج الدروس. حاولي مرة ثانية.</div>'; return; }
    render();
  }

  function render() {
    const lib = '<a class="btn sm quiet" href="/lessons" target="_blank" rel="noopener">فتح مكتبة الدروس</a>';
    if (!data.lessons.length) {
      host().innerHTML = `<div class="card"><div class="toolbar"><div class="grow note">الدروس التفاعلية الحالية لمادة الرياضيات. أول ما تحل طالباتك اختبار درس، تظهر درجاتهن هنا.</div>${lib}</div></div>`;
      return;
    }
    const classes = [...new Set(data.students.map(s => s.class).filter(Boolean))];
    if (cls && !classes.includes(cls)) cls = "";
    const list = data.students.filter(s => !cls || s.class === cls);
    // Per lesson: how many of the listed students took it, and their average.
    const stats = data.lessons.map(l => {
      const rs = list.map(s => s.results[l.key]).filter(Boolean);
      return { n: rs.length, avg: rs.length ? Math.round(rs.reduce((a, r) => a + pct(r), 0) / rs.length) : null };
    });
    const cell = (s, l) => {
      const r = s.results[l.key];
      if (!r) return '<td class="num"><span class="pill none">لم تحل</span></td>';
      const tip = `أول محاولة ${when(r.at)}${r.attempts > 1 ? ` · ${r.attempts} محاولات، أفضلها ${r.best} من ${r.total}` : ""}`;
      return `<td class="num" title="${esc(tip)}">${r.score} من ${r.total} ${levelPill(pct(r))}</td>`;
    };
    host().innerHTML = `<div class="card">
      <div class="toolbar">
        <div class="grow note">درجة <b>أول محاولة</b> في اختبار آخر كل درس، للمتابعة فقط وما تدخل في بطاقة النتيجة. مرّري على الدرجة لتشوفين المحاولات.</div>
        ${classes.length > 1 ? `<select class="in" id="lrClass" aria-label="الفصل"><option value="">كل الفصول</option>${classes.map(c => `<option value="${esc(c)}"${c === cls ? " selected" : ""}>${esc(Report.classLabel(c))}</option>`).join("")}</select>` : ""}
        ${lib}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>الطالبة</th><th>الفصل</th>${data.lessons.map((l, k) => `<th class="num">${esc(l.name)}<br><span class="note">الدرس <bdi dir="ltr">${esc(l.ref)}</bdi> · حلّت ${stats[k].n} من ${list.length}${stats[k].avg != null ? ` · المتوسط ${stats[k].avg}%` : ""}</span></th>`).join("")}</tr></thead>
          <tbody>${list.map(s => `<tr><td class="name">${esc(s.name)}</td><td>${esc(Report.classLabel(s.class))}</td>${data.lessons.map(l => cell(s, l)).join("")}</tr>`).join("")
            || `<tr><td colspan="${data.lessons.length + 2}" class="note">ما فيه طالبات.</td></tr>`}</tbody>
        </table>
      </div></div>`;
    $("#lrClass")?.addEventListener("change", e => { cls = e.target.value; render(); });
  }

  // A different teacher's panel (the principal switching) starts from a fresh read.
  const reset = () => { data = null; cls = ""; };
  return { load, reset };
})();
