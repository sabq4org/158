// The principal's reports tab: classes and subjects compared across the school, the semester week by week, and an
// A4 report to print. Runs inside admin.html and uses its helpers ($, esc, api, toast, role, switchTeacher).
const SchoolReports = (() => {
  const LEVELS = [["excellent", "ممتاز", "90 فأكثر"], ["vgood", "جيد جدًا", "75 إلى 89"], ["good", "جيد", "60 إلى 74"], ["support", "يحتاج دعم", "أقل من 60"]];
  const STEPS = [["t1", "الاختبار الأول"], ["t2", "الاختبار الثاني"], ["participation", "المشاركة"], ["projects", "المشاريع"], ["homework", "الواجبات"], ["final", "النهائي"]];
  // A class keeps its colour whatever the filters leave on screen: the slot follows its grade and section.
  const slotOf = name => { const p = Report.classParts(name); return p ? ((p.grade - 1) * 3 + p.section - 1) % 8 + 1 : 8; };
  const pct = v => (v == null ? "—" : v + "٪");
  const shortName = name => Report.classParts(name) ? name.replace(" الثانوي /", "") : Report.classLabel(name);
  let data = null, busy = 0;
  const filters = { period: "current", grade: "", subject: "", teacher: "" };

  const host = () => $("#reports");
  const query = () => "?" + new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();

  async function load() {
    const turn = ++busy;
    if (!data) host().innerHTML = '<div class="card rpx-empty">جاري تجهيز التقارير…</div>';
    let next;
    try { next = await api("/school/reports" + query()); }
    catch { if (turn === busy) host().innerHTML = '<div class="card rpx-empty">تعذّر تحميل التقارير. حاولي مرة ثانية.</div>'; return; }
    if (turn !== busy) return;
    data = next; filters.period = data.period;
    render();
  }

  const select = (key, label, options) => `<label class="rpx-sel"><span>${label}</span><select class="in" data-filter="${key}">${options
    .map(([v, t]) => `<option value="${esc(v)}"${String(filters[key]) === String(v) ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;

  function render() {
    const d = data, k = d.kpis, o = d.options;
    const filtersHtml = `<div class="card rpx-filters">
      ${select("period", "الفترة", d.periods.map(p => [p.key, p.title]))}
      ${select("grade", "الصف", [["", "كل الصفوف"], ...o.grades.map(g => [g.value, g.name])])}
      ${select("subject", "المادة", [["", "كل المواد"], ...o.subjects.map(s => [s, s])])}
      ${select("teacher", "المعلمة", [["", "الكل"], ...o.teachers.map(t => [t.id, t.subject ? `${t.name} · ${t.subject}` : t.name])])}
      <button class="btn" type="button" id="rpxPdf"${k.graded ? "" : " disabled"}>تقرير PDF</button>
    </div>`;
    if (!k.students) {
      host().innerHTML = filtersHtml + '<div class="card rpx-empty">ما فيه طالبات بهذي الاختيارات. جربي فترة أو مادة ثانية.</div>';
      return;
    }
    const change = k.change == null ? "" : `<span class="rpx-delta ${k.change >= 0 ? "up" : "down"}">${k.change >= 0 ? "▲" : "▼"} ${Math.abs(k.change)} من الاختبار الأول للثاني</span>`;
    host().innerHTML = filtersHtml + `
    <div class="stats">
      <div class="card stat"><div class="k">متوسط المدرسة</div><div class="v">${pct(k.avg)}</div>${change}</div>
      <div class="card stat"><div class="k">متفوقات (90٪ فأكثر)</div><div class="v">${k.top}<small> من ${k.graded}</small></div></div>
      <div class="card stat"><div class="k">يحتجن دعم (أقل من 60٪)</div><div class="v">${k.support}<small> من ${k.graded}</small></div></div>
      <div class="card stat"><div class="k">نسبة الرصد</div><div class="v">${pct(k.coverage)}<small> من الدرجات</small></div></div>
    </div>
    <div class="rpx-grid">
      <div class="card rpx-card"><h3>مقارنة الفصول</h3><p class="note">متوسط كل فصل، وتوزيع طالباته على المستويات.</p>${classBars(d.classes)}</div>
      <div class="card rpx-card"><h3>مقارنة المواد</h3><p class="note">متوسط كل مادة على مستوى المدرسة.</p>${subjectBars(d.subjects)}</div>
    </div>
    <div class="rpx-grid">
      <div class="card rpx-card"><h3>تطور المستوى خلال الفصل الدراسي</h3>${weeksChart(d.weeks, d.period)}</div>
      <div class="card rpx-card"><h3>من اختبار لاختبار</h3><p class="note">متوسط كل تقييم بالنسبة لدرجته العظمى. الفصل اللي نزل من الاختبار الأول للثاني يطلع عليه "يحتاج متابعة".</p>${stepsTable(d.steps)}</div>
    </div>
    <div class="card rpx-card"><h3>خريطة الفصول والمواد</h3><p class="note">كل خانة متوسط مادة في فصل، واللون الأغمق أعلى. الأحمر أقل من 60٪.${role === "viewer" ? " اضغطي الخانة تفتح لوحة المعلمة." : ""}</p>${matrixTable(d.matrix)}</div>
    <p class="note rpx-foot">المتوسطات بدون صعوبات التعلم. أي مجموعة فيها أقل من ${Report.MIN_CLASS} طالبات مرصودات ما يطلع لها متوسط، عشان ما تنعرف درجة طالبة بعينها.</p>`;
  }

  const legend = `<div class="rpx-legend">${LEVELS.map(([c, t, r]) => `<span><i class="lv-${c}"></i>${t} <small>${r}</small></span>`).join("")}</div>`;
  function classBars(list) {
    if (!list.length) return '<p class="rpx-none">ما فيه فصول.</p>';
    return list.map(c => {
      const title = c.dist ? LEVELS.map(([k, t]) => `${t}: ${c.dist[k]}`).join("، ") : `${c.n} مرصودات من ${c.students}`;
      const bar = c.dist ? LEVELS.filter(([k]) => c.dist[k]).map(([k, t]) => `<i class="lv-${k}" style="flex:${c.dist[k]}" title="${t}: ${c.dist[k]}"></i>`).join("")
        : `<span class="rpx-few">أقل من ${Report.MIN_CLASS} مرصودات</span>`;
      return `<div class="rpx-row" title="${esc(Report.classLabel(c.name))} · ${esc(title)}"><span class="n">${esc(Report.classLabel(c.name))}</span><div class="rpx-stack">${bar}</div><b>${pct(c.avg)}</b></div>`;
    }).join("") + legend;
  }
  function subjectBars(list) {
    if (!list.length) return '<p class="rpx-none">ما فيه مواد.</p>';
    return list.map(s => `<div class="rpx-row" title="${esc(s.name)}: ${s.avg == null ? `أقل من ${Report.MIN_CLASS} مرصودات` : s.avg + "٪ · " + s.n + " درجة"}"><span class="n">${esc(s.name)}</span>
      <div class="rpx-track">${s.avg == null ? `<span class="rpx-few">أقل من ${Report.MIN_CLASS} مرصودات</span>` : `<i style="width:${s.avg}%"></i>`}</div><b>${pct(s.avg)}</b></div>`).join("")
      + (list.length < 2 ? '<p class="note">تظهر المقارنة لما تبدأ معلمات المواد الثانية يرصدن درجاتهن.</p>' : "");
  }

  // Lines over the study weeks. Labels are HTML over the plot, so the PDF keeps the Arabic font.
  function weeksChart(w, period) {
    if (period !== "current") return '<p class="rpx-none">التطور الأسبوعي للفترة الحالية فقط. الأرشيف يحفظ آخر درجات الفترة.</p>';
    const note = w ? `<p class="note">${esc(w.title)}${w.week ? ` · الأسبوع ${w.week} من ${w.weeks}` : ""}. المنصة تحفظ المتوسطات كل أسبوع دراسي تلقائيًا.</p>` : "";
    if (!w || !w.at.length) return note + '<p class="rpx-none">أول لقطة تنحفظ في أول أسبوع دراسي فيه درجات، والرسم يكبر أسبوع بعد أسبوع.</p>';
    const lines = [{ name: "المدرسة", points: w.all, all: true }, ...w.series];
    const vals = lines.flatMap(l => l.points).filter(v => v != null);
    const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10), hi = Math.min(100, Math.ceil((Math.max(...vals) + 5) / 10) * 10);
    const n = w.at.length, x = i => (n === 1 ? 50 : 4 + (i * 92) / (n - 1)), y = v => 100 - ((v - lo) / (hi - lo || 1)) * 100;
    const ticks = [lo, (lo + hi) / 2, hi].map(Math.round);
    const path = l => l.points.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
    return note + `<div class="rpx-chart">
      <div class="rpx-yaxis">${ticks.map(t => `<span style="top:${y(t)}%">${t}٪</span>`).join("")}</div>
      <div class="rpx-plot">
        ${ticks.map(t => `<i class="rpx-gl" style="top:${y(t)}%"></i>`).join("")}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines.map(l => `<polyline class="${l.all ? "rpx-all" : `rpx-s${slotOf(l.name)}`}" points="${path(l)}"/>`).join("")}</svg>
        ${lines.flatMap(l => l.points.map((v, i) => v == null ? "" : `<b class="rpx-pt ${l.all ? "rpx-all" : `rpx-s${slotOf(l.name)}`}" style="left:${x(i)}%;top:${y(v)}%" title="${esc(l.all ? "المدرسة" : Report.classLabel(l.name))} · الأسبوع ${w.at[i]}: ${v}٪"></b>`)).join("")}
      </div>
      <div class="rpx-xaxis">${w.at.map((wk, i) => `<span style="left:${x(i)}%">${wk}</span>`).join("")}</div>
    </div>
    <div class="rpx-keys">${lines.map(l => `<span><i class="${l.all ? "rpx-all" : `rpx-s${slotOf(l.name)}`}"></i>${esc(l.all ? "كل الفصول" : shortName(l.name))} <b>${pct(l.points.filter(v => v != null).pop())}</b></span>`).join("")}</div>
    <p class="note rpx-xnote">الأسبوع الدراسي (أسابيع الإجازات ما تنحسب)</p>`;
  }

  function stepsTable(steps) {
    const cols = STEPS.filter(([k]) => steps.some(s => s[k] != null));
    if (!steps.length || !cols.length) return `<p class="rpx-none">ما فيه فصل فيه ${Report.MIN_CLASS} طالبات مرصودات أو أكثر.</p>`;
    return `<div class="table-wrap"><table class="rpx-tbl"><tr><th>الفصل</th>${cols.map(([, t]) => `<th class="num">${t}</th>`).join("")}<th class="num">التغيّر</th></tr>
      ${steps.map(s => `<tr><td class="name">${esc(Report.classLabel(s.name))}${s.change != null && s.change <= -3 ? ' <span class="pill warn">يحتاج متابعة</span>' : ""}</td>
        ${cols.map(([k]) => `<td class="num">${pct(s[k])}</td>`).join("")}
        <td class="num">${s.change == null ? "—" : `<span class="rpx-delta ${s.change >= 0 ? "up" : "down"}">${s.change >= 0 ? "▲" : "▼"} ${Math.abs(s.change)}</span>`}</td></tr>`).join("")}</table></div>`;
  }

  // Sequential: one teal, lighter to darker as the average rises; under 60% it turns to the "needs support" red.
  const heat = v => (v == null ? "" : v < 60 ? "lowc" : `h${Math.min(4, Math.max(0, Math.floor((v - 60) / 10)))}`);
  function matrixTable(m) {
    if (!m.rows.length) return '<p class="rpx-none">ما فيه فصول.</p>';
    return `<div class="table-wrap"><table class="rpx-tbl rpx-heat"><tr><th>الفصل</th>${m.subjects.map(s => `<th class="num">${esc(s)}</th>`).join("")}<th class="num">المتوسط</th></tr>
      ${m.rows.map(r => `<tr><td class="name">${esc(Report.classLabel(r.name))}</td>${m.subjects.map(s => {
        const c = r.cells[s];
        if (!c) return '<td class="num"><span class="note">—</span></td>';
        const open = role === "viewer" && c.teacher ? ` data-rpx-open="${c.teacher}" tabindex="0" role="button"` : "";
        return `<td class="num"><span class="rpx-cell ${heat(c.avg)}${open ? " go" : ""}"${open} title="${esc(Report.classLabel(r.name))} · ${esc(s)}: ${c.avg == null ? `أقل من ${Report.MIN_CLASS} مرصودات` : c.avg + "٪"}">${pct(c.avg)}</span></td>`;
      }).join("")}<td class="num"><b>${pct(r.avg)}</b></td></tr>`).join("")}</table></div>`;
  }

  // ---------- The A4 report ----------
  // Page one: the numbers, the comparisons and the weeks. The class and subject map, when there are subjects to map, gets
  // a page of its own, so a school with many classes still fits; the principal signs the last page.
  function sheets() {
    const d = data, k = d.kpis;
    const period = d.periods.find(p => p.key === d.period)?.title || "";
    const picked = [d.options.grades.find(g => String(g.value) === String(filters.grade))?.name, filters.subject,
      d.options.teachers.find(t => String(t.id) === String(filters.teacher))?.name].filter(Boolean).join(" · ");
    const sub = [schoolInfo.stage, period, picked].filter(Boolean).join(" · ");
    const block = (title, body) => `<div class="rpx-sec"><h2>${title}</h2>${body}</div>`;
    const page = (title, body, last) => `<div class="rp-sheet rpx-sheet">
      ${Report.sheetHead(title, sub)}
      <div class="rp-body rpx">${body}</div>
      ${last ? `<div class="rp-signs"><div class="rp-sign"><div class="rp-k">مديرة المدرسة</div><div class="rp-n">${esc(d.principal || schoolSettings?.principal_name || "")}</div><div class="rp-line"></div></div></div>` : ""}
      ${Report.sheetFoot(`المتوسطات بدون صعوبات التعلم، ولمجموعات من ${Report.MIN_CLASS} طالبات فأكثر`)}
    </div>`;
    const map = d.matrix.subjects.length > 1;
    const first = `<div class="rp-stats">
          <div><span>الطالبات</span><b>${k.students}</b></div>
          <div><span>متوسط المدرسة</span><b>${pct(k.avg)}</b></div>
          <div><span>متفوقات</span><b>${k.top}</b></div>
          <div><span>يحتجن دعم</span><b>${k.support}</b></div>
          <div><span>التغيّر بين الاختبارين</span><b>${k.change == null ? "—" : (k.change > 0 ? "+" : "") + k.change}</b></div>
          <div><span>نسبة الرصد</span><b>${pct(k.coverage)}</b></div>
        </div>
        <div class="rpx-two">${block("مقارنة الفصول", classBars(d.classes))}${block("مقارنة المواد", subjectBars(d.subjects))}</div>
        ${d.period === "current" && d.weeks?.at.length ? block("تطور المستوى خلال الفصل الدراسي", weeksChart(d.weeks, d.period)) : ""}
        ${block("من اختبار لاختبار", stepsTable(d.steps))}`;
    return map ? [page("تقرير مستوى المدرسة", first, false), page("تقرير مستوى المدرسة (تابع)", block("خريطة الفصول والمواد", matrixTable(d.matrix)), true)]
      : [page("تقرير مستوى المدرسة", first, true)];
  }

  async function pdf(btn) {
    btn.disabled = true; const label = btn.textContent; btn.textContent = "جاري التجهيز…";
    try { Report.save(await Report.toPdf(sheets()), "تقرير مستوى المدرسة.pdf"); }
    catch { toast("تعذّر تجهيز التقرير"); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  document.addEventListener("change", e => {
    const key = e.target.closest("#reports [data-filter]")?.dataset.filter; if (!key) return;
    filters[key] = e.target.value;
    load();
  });
  document.addEventListener("click", async e => {
    if (e.target.closest("#rpxPdf")) return pdf(e.target.closest("#rpxPdf"));
    const id = e.target.closest("#reports [data-rpx-open]")?.dataset.rpxOpen; if (!id) return;
    try { if (Number(id) !== T) await switchTeacher(id); } catch { return toast("تعذّر فتح لوحة المعلمة"); }
    $("#tab-overview").click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches?.("#reports [data-rpx-open]")) e.target.click(); });

  return { load, sheets };
})();
