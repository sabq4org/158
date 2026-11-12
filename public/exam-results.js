// The panel's «الاختبارات» tab: the teacher opens and closes an interactive exam, follows who is taking it, reads the
// marks and the hardest items, prints a student's answer sheet, and approves marks into الاختبار الأول or الثاني.
// Runs inside admin.html and uses its helpers ($, esc, api, toast, confirmBox, levelPill, Report, students).
const ExamResults = (() => {
  let data = null, cls = "", field = "test1", view = "students", timer = null, pick = "";
  const host = () => $("#examsPanel");
  const fmt = n => (n == null ? "—" : String(Math.round(Number(n) * 100) / 100));
  const when = at => new Date(at).toLocaleString("ar-SA-u-nu-latn", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  const mins = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));
  const FIELD = { test1: "الاختبار الأول", test2: "الاختبار الثاني" };
  const LETTERS = ["أ", "ب", "ج", "د"];
  // The exam's maths marks, as the student's page shows them.
  const rich = s => esc(s)
    .replace(/\{p:(-?[\d.]+),(-?[\d.]+)\}/g, (_, x, y) => `<bdi dir="ltr">(${x}, ${y})</bdi>`)
    .replace(/\{f:(-?)([^/}]+)\/([^}]+)\}/g, (_, n, a, b) => `<bdi dir="ltr">${n ? "−" : ""}${a}/${b}</bdi>`)
    .replace(/\{d:(\d+)\}/g, (_, d) => `<bdi dir="ltr">${d}°</bdi>`)
    .replace(/\{e:([^}]+)\}/g, (_, e) => `<bdi dir="ltr">${e}</bdi>`);

  async function load() {
    if (!data) host().innerHTML = '<div class="card note" style="padding:20px">جاري التحميل…</div>';
    try { data = await api("/exams"); }
    catch { host().innerHTML = '<div class="card note" style="padding:20px">تعذّر تحميل الاختبارات. حاولي مرة ثانية.</div>'; return; }
    render();
    // While students are taking it, the table follows them.
    clearTimeout(timer);
    if (data.exams.some(e => e.open || e.students.some(s => s.status === "in_progress")))
      timer = setTimeout(() => { if (!host().hidden) load(); }, 30000);
  }

  const items = ex => ex.sections.flatMap(s => s.items.map((it, i) => ({ ...it, type: s.type, sec: s, n: i + 1 })));
  const answerText = (it, v) => v === undefined ? "—" : it.type === "mcq" ? `${LETTERS[v]}) ${rich(it.options[v])}` : it.type === "tf" ? (v ? "✓ صح" : "✗ خطأ") : esc(v);

  function render() {
    if (!data.exams.length) { host().innerHTML = '<div class="card note" style="padding:20px">ما عندك اختبارات تفاعلية حاليًا.</div>'; return; }
    // One exam at a time (with its صعوبات التعلم model): the teacher picks it from the row on top. It opens on the
    // exam that is open now, or the newest.
    const mains = data.exams.filter(e => !e.parent);
    if (!mains.some(e => e.key === pick)) pick = (mains.find(e => e.open) || mains[0]).key;
    const shown = data.exams.filter(e => e.key === pick || e.parent === pick);
    const tabs = mains.length > 1 ? `<div class="toolbar" role="tablist" aria-label="الاختبار" style="flex-wrap:wrap;gap:8px;padding:0 0 12px">
      ${mains.map(e => `<button class="btn sm ${e.key === pick ? "" : "quiet"}" role="tab" aria-selected="${e.key === pick}" data-ex-pick="${esc(e.key)}">
        ${esc(e.title.replace(/^.+?:\s*/, ""))} <span style="opacity:.8;font-weight:400">· ${esc(e.gradeLabel)}</span>${e.open ? " 🟢" : ""}</button>`).join("")}</div>` : "";
    host().innerHTML = tabs + shown.map(examCard).join("");
    host().querySelectorAll("[data-ex-pick]").forEach(b => b.onclick = () => { pick = b.dataset.exPick; cls = ""; render(); });
    shown.forEach(bind);
  }

  function examCard(ex) {
    const url = `${location.origin}/exams/${ex.key}`;
    const classes = [...new Set(ex.students.map(s => s.class).filter(Boolean))];
    if (cls && !classes.includes(cls)) cls = "";
    const list = ex.students.filter(s => !cls || s.class === cls);
    const done = list.filter(s => s.status === "submitted"), going = list.filter(s => s.status === "in_progress");
    const avg = done.length ? done.reduce((a, s) => a + s.score, 0) / done.length : null;
    const pending = done.filter(s => !s.approved || s.approved.field !== field || s[field] !== s.approved.value);
    const max = data.max;
    const head = `<div class="toolbar" style="border-bottom:1px solid var(--line)">
        <div class="grow"><b style="font-size:17px">${esc(ex.title)}</b>${ex.model ? ` <span class="pill warn">${esc(ex.model)}</span>` : ""}<div class="note">${esc(ex.subject)} · ${esc(ex.gradeLabel)} · ${ex.total} درجة · ${ex.minutes} دقيقة · ${ex.count} فقرة</div></div>
        <span class="pill ${ex.open ? "good" : "none"}">${ex.open ? "مفتوح للطالبات" : "مقفل"}</span>
        ${ex.parent ? "" : `<button class="btn sm ${ex.open ? "quiet" : ""}" data-ex-open="${ex.open ? 0 : 1}">${ex.open ? "قفل الاختبار" : "فتح الاختبار"}</button>`}
        <span class="pill ${ex.published ? "good" : "none"}" title="${ex.published ? "الطالبة تشوف درجتها وإجاباتها برقم هويتها" : "الطالبة تشوف «تم استلام اختبارك» بدون درجة"}">${ex.published ? "النتائج منشورة" : "النتائج مخفية"}</span>
        ${ex.parent ? "" : `<button class="btn sm ${ex.published ? "quiet" : ""}" data-ex-publish="${ex.published ? 0 : 1}">${ex.published ? "إخفاء النتائج" : "نشر النتائج"}</button>`}
      </div>
      ${ex.parent ? `<div class="toolbar"><div class="grow note">طالبات «صعوبات التعلم» يفتح لهن هذا النموذج تلقائيًا من رابط الاختبار نفسه، ويفتح ويقفل معه.
        للتجربة: رقم الهوية <bdi dir="ltr"><b>0000000001</b></bdi>.</div></div>` : `<div class="toolbar">
        <div class="grow note">رابط الطالبات: <bdi dir="ltr"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ""))}</a></bdi>
          · الطالبة تدخل برقم هويتها، ولها محاولة وحدة. للتجربة: رقم الهوية <bdi dir="ltr"><b>0000000000</b></bdi> (يشتغل حتى والاختبار مقفل، وما تنحفظ درجته).</div>
        <button class="btn sm quiet" data-ex-copy>نسخ الرابط</button>
      </div>`}
      <div class="toolbar" style="padding-top:0">
        <span class="pill none">سلّمت ${done.length} من ${list.length}</span>
        ${going.length ? `<span class="pill warn">تختبر الحين ${going.length}</span>` : ""}
        ${avg != null ? `<span class="pill good">المتوسط ${fmt(avg)} من ${ex.total}</span>` : ""}
        <span class="grow"></span>
        ${classes.length > 1 ? `<select class="in" data-ex-cls aria-label="الفصل"><option value="">كل الفصول</option>${classes.map(c => `<option value="${esc(c)}"${c === cls ? " selected" : ""}>${esc(Report.classLabel(c))}</option>`).join("")}</select>` : ""}
        <select class="in" data-ex-view aria-label="العرض"><option value="students"${view === "students" ? " selected" : ""}>الطالبات</option><option value="items"${view === "items" ? " selected" : ""}>تحليل الفقرات</option></select>
      </div>`;
    const approveBar = done.length ? `<div class="toolbar" style="background:var(--surface-2);border-block:1px solid var(--line)">
        <div class="grow note">الاعتماد ينقل الدرجة لبطاقة النتيجة محوّلة من ${ex.total} إلى ${max} (درجة الاختبار عندك)، وينكتب في السجل وتقدرين تتراجعين عنه.</div>
        <label class="note">اعتماد في <select class="in" data-ex-field>${Object.entries(FIELD).map(([k, v]) => `<option value="${k}"${k === field ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <button class="btn sm" data-ex-approve-all ${pending.length ? "" : "disabled"}>اعتماد ${pending.length ? `${pending.length} درجة` : "الكل"}</button>
      </div>` : "";
    const body = view === "items" ? itemsTable(ex, done) : studentsTable(ex, list, max);
    return `<div class="card" data-exam="${esc(ex.key)}" style="margin-bottom:16px">${head}${approveBar}${body}</div>`;
  }

  function studentsTable(ex, list, max) {
    const row = s => {
      let status, score = "—", act = "";
      if (s.status === "none") status = '<span class="pill none">ما بدأت</span>';
      else if (s.status === "in_progress") status = `<span class="pill warn" title="بدأت ${esc(when(s.startedAt))}">تختبر · جاوبت ${s.answered} من ${ex.count}</span>`;
      else {
        status = `<span class="pill good" title="سلّمت ${esc(when(s.submittedAt))}">${s.auto ? "سُلّم عند نهاية الوقت" : "سلّمت"} · ${mins(s.startedAt, s.submittedAt)} د</span>`;
        score = `<b>${fmt(s.score)}</b> من ${ex.total} ${levelPill(Math.round((100 * s.score) / ex.total))}<div class="note">${s.parts.map(fmt).join(" · ")}</div>`;
        const scaled = Math.round(((s.score * max) / ex.total) * 100) / 100;
        // An approval still stands while the card holds the mark it wrote (an undo or a later edit changes it).
        const live = s.approved && s[s.approved.field] === s.approved.value;
        const mark = !s.approved ? "" : live ? `<div class="note">معتمدة في ${FIELD[s.approved.field]}: ${fmt(s.approved.value)}</div>`
          : `<div class="note">اعتمدتيها في ${FIELD[s.approved.field]} ثم تغيّرت في البطاقة</div>`;
        act = `${mark}<button class="btn sm" data-ex-approve="${esc(s.id)}" title="${esc(`${FIELD[field]} = ${fmt(scaled)} من ${max}`)}">${live && s.approved.field === field ? "اعتماد مرة ثانية" : `اعتماد ${fmt(scaled)}`}</button>
          <button class="btn sm quiet" data-ex-sheet="${esc(s.id)}">ورقة الإجابة</button>`;
      }
      if (s.status !== "none") act += ` <button class="btn sm quiet" data-ex-reset="${esc(s.id)}" title="تحذف محاولتها وتقدر تختبر من جديد">إعادة</button>`;
      return `<tr><td class="name">${esc(s.name)}</td><td>${esc(Report.classLabel(s.class))}</td><td>${status}</td><td class="num">${score}</td><td>${act}</td></tr>`;
    };
    const order = { in_progress: 0, submitted: 1, none: 2 };
    const sorted = list.slice().sort((a, b) => order[a.status] - order[b.status]);
    return `<div class="table-wrap"><table>
      <thead><tr><th>الطالبة</th><th>الفصل</th><th>الحالة</th><th class="num">الدرجة<br><span class="note">${ex.sections.map(s => esc(s.title.replace(/^.+?:\s*/, ""))).join(" · ")}</span></th><th></th></tr></thead>
      <tbody>${sorted.map(row).join("") || '<tr><td colspan="5" class="note">ما فيه طالبات في هذا الصف.</td></tr>'}</tbody></table></div>`;
  }

  // Which items the class got wrong most, and the wrong answer chosen most often.
  function itemsTable(ex, done) {
    if (!done.length) return '<div class="note" style="padding:16px">التحليل يظهر بعد ما تسلّم أول طالبة.</div>';
    const rows = items(ex).map(it => {
      const right = done.filter(s => s.right[it.id]).length;
      const wrong = {};
      for (const s of done) { const v = s.answers?.[it.id]; if (!s.right[it.id] && v !== undefined) wrong[JSON.stringify(v)] = (wrong[JSON.stringify(v)] || 0) + 1; }
      const top = Object.entries(wrong).sort((a, b) => b[1] - a[1])[0];
      return { it, pct: Math.round((100 * right) / done.length), top: top ? { v: JSON.parse(top[0]), n: top[1] } : null };
    }).sort((a, b) => a.pct - b.pct);
    return `<div class="table-wrap"><table>
      <thead><tr><th>الفقرة</th><th class="num">أجابت صح</th><th>الإجابة الصحيحة</th><th>أكثر إجابة خاطئة</th></tr></thead>
      <tbody>${rows.map(({ it, pct, top }) => `<tr><td><span class="note">${esc(it.sec.title.replace(/^.+?:\s*/, ""))} ${it.n}</span><br>${rich(it.q)}</td>
        <td class="num">${pct}% ${levelPill(pct)}</td><td>${answerText(it, it.answer)}</td><td>${top ? `${answerText(it, top.v)} <span class="note">(${top.n})</span>` : "—"}</td></tr>`).join("")}</tbody>
    </table></div>`;
  }

  // A printable sheet of one student's answers; the browser saves it as PDF.
  function sheet(ex, s) {
    const all = items(ex), w = window.open("", "_blank");
    if (!w) return toast("المتصفح منع النافذة. اسمحي بالنوافذ المنبثقة وجربي.");
    const secs = ex.sections.map(sec => {
      const list = all.filter(it => it.sec === sec);
      return `<h2>${esc(sec.title)} <small>(${s.parts[ex.sections.indexOf(sec)]} من ${sec.marks})</small></h2>
        <table><thead><tr><th>#</th><th>الفقرة</th><th>إجابتها</th><th>الصحيحة</th><th></th></tr></thead><tbody>
        ${list.map(it => `<tr class="${s.right[it.id] ? "ok" : "no"}"><td>${it.n}</td><td>${rich(it.q)}</td><td>${answerText(it, s.answers?.[it.id])}</td><td>${answerText(it, it.answer)}</td><td>${s.right[it.id] ? "✓" : "✗"}</td></tr>`).join("")}
        </tbody></table>`;
    }).join("");
    w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ورقة إجابة ${esc(s.name)}</title>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap">
      <style>body{font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;margin:24px;color:#10242c;font-size:13px}h1{font-size:18px;margin:0}h2{font-size:15px;margin:18px 0 6px}
      h2 small{font-weight:400;color:#55707a}.info{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;margin:10px 0;padding:10px;border:1px solid #cddcdc;border-radius:10px}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #cddcdc;padding:4px 6px;text-align:start;vertical-align:top}th{background:#eef3f3}
      tr.no td:last-child{color:#c0265e;font-weight:700}tr.ok td:last-child{color:#0a7c78;font-weight:700}.score{font-size:22px;font-weight:700;color:#0a7c78}
      @page{size:A4;margin:12mm}@media print{body{margin:0}button{display:none}}</style></head><body>
      <button onclick="print()" style="float:left;font:inherit;padding:6px 14px">طباعة / حفظ PDF</button>
      <h1>${esc(ex.title)}</h1><div style="color:#55707a">${esc(ex.subject)} · ${esc(ex.gradeLabel)} · ${esc(ex.semester)}</div>
      <div class="info"><div>الاسم: <b>${esc(s.name)}</b></div><div>الصف: <b>${esc(Report.classLabel(s.class))}</b></div><div>رقم الهوية: <b dir="ltr">${esc(s.id)}</b></div>
      <div>سلّمت: ${esc(when(s.submittedAt))}${s.auto ? " (عند نهاية الوقت)" : ""}</div><div>المدة: ${mins(s.startedAt, s.submittedAt)} دقيقة</div><div>الدرجة: <span class="score">${fmt(s.score)} / ${ex.total}</span></div></div>
      ${secs}</body></html>`);
    w.document.close();
  }

  function bind(ex) {
    const card = host().querySelector(`[data-exam="${CSS.escape(ex.key)}"]`);
    const q = s => card.querySelector(s);
    if (q("[data-ex-open]")) q("[data-ex-open]").onclick = async e => {
      const open = e.target.dataset.exOpen === "1";
      if (!open && !(await confirmBox("قفل الاختبار؟", "ما تقدر طالبة جديدة تبدأ. اللي بدأت تكمل لين يخلص وقتها.", "قفل"))) return;
      try { await api(`/exams/${ex.key}/open`, { method: "PUT", body: { open } }); toast(open ? "فتحتي الاختبار للطالبات" : "قفلتي الاختبار"); }
      catch (x) { toast((x.data?.errors || ["تعذّر الحفظ"])[0]); }
      load();
    };
    if (q("[data-ex-publish]")) q("[data-ex-publish]").onclick = async e => {
      const published = e.target.dataset.exPublish === "1";
      const ok = published
        ? await confirmBox("نشر النتائج؟", "كل طالبة سلّمت تشوف درجتها، وإجابتها في كل فقرة مع الإجابة الصحيحة، لما تدخل برقم هويتها. يشمل نموذج صعوبات التعلم.", "نشر")
        : await confirmBox("إخفاء النتائج؟", "الطالبات يشوفن «تم استلام اختبارك» بدون الدرجة والإجابات.", "إخفاء");
      if (!ok) return;
      try { await api(`/exams/${ex.key}/publish`, { method: "PUT", body: { published } }); toast(published ? "نشرتي النتائج للطالبات" : "أخفيتي النتائج"); }
      catch (x) { toast((x.data?.errors || ["تعذّر الحفظ"])[0]); }
      load();
    };
    if (q("[data-ex-copy]")) q("[data-ex-copy]").onclick = async () => {
      try { await navigator.clipboard.writeText(`${location.origin}/exams/${ex.key}`); toast("تم نسخ الرابط"); } catch { toast("ما قدرنا ننسخ، انسخيه من السطر"); }
    };
    q("[data-ex-cls]")?.addEventListener("change", e => { cls = e.target.value; render(); });
    q("[data-ex-view]").onchange = e => { view = e.target.value; render(); };
    q("[data-ex-field]")?.addEventListener("change", e => { field = e.target.value; render(); });
    const approve = async ids => {
      try {
        const d = await api(`/exams/${ex.key}/approve`, { method: "POST", body: { ids, field } });
        toast(`اعتمدتي ${d.done.length} درجة في ${FIELD[field]}`);
        try { students = await api("/students"); renderStats(); renderRows(); renderOverview(); } catch {}
      } catch (x) { toast((x.data?.errors || ["تعذّر الاعتماد"])[0]); }
      load();
    };
    q("[data-ex-approve-all]")?.addEventListener("click", async () => {
      const list = ex.students.filter(s => s.status === "submitted" && (!cls || s.class === cls) && (!s.approved || s.approved.field !== field || s[field] !== s.approved.value));
      const over = list.filter(s => { const st = students.find(x => x.national_id === s.id); return st && st[field] != null; }).length;
      const ok = await confirmBox(`اعتماد ${list.length} درجة في ${FIELD[field]}؟`,
        `تنكتب الدرجات في بطاقات الطالبات محوّلة إلى ${data.max}.${over ? ` ${over} منهن عندهن درجة مكتوبة في ${FIELD[field]} وبتنستبدل.` : ""} تقدرين تتراجعين من السجل.`, "اعتماد");
      if (ok) approve(list.map(s => s.id));
    });
    card.querySelectorAll("[data-ex-approve]").forEach(b => b.onclick = async () => {
      const s = ex.students.find(x => x.id === b.dataset.exApprove), st = students.find(x => x.national_id === s.id);
      if (st && st[field] != null && !(await confirmBox(`استبدال ${FIELD[field]}؟`, `${s.name} عندها ${fmt(st[field])} في ${FIELD[field]}، وبتنستبدل بدرجة هذا الاختبار.`, "استبدال"))) return;
      approve([s.id]);
    });
    card.querySelectorAll("[data-ex-sheet]").forEach(b => b.onclick = () => sheet(ex, ex.students.find(x => x.id === b.dataset.exSheet)));
    card.querySelectorAll("[data-ex-reset]").forEach(b => b.onclick = async () => {
      const s = ex.students.find(x => x.id === b.dataset.exReset);
      if (!(await confirmBox(`إعادة الاختبار لـ ${s.name}؟`, "تنحذف محاولتها وإجاباتها، وتقدر تبدأ من جديد. الدرجة المعتمدة في البطاقة ما تتغير.", "إعادة"))) return;
      try { await api(`/exams/${ex.key}/attempts/${encodeURIComponent(s.id)}`, { method: "DELETE" }); toast("تقدر تختبر من جديد"); }
      catch (x) { toast((x.data?.errors || ["تعذّر"])[0]); }
      load();
    });
  }

  const reset = () => { data = null; cls = ""; pick = ""; clearTimeout(timer); };
  return { load, reset };
})();
