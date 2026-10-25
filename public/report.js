// Shared by the lookup page, the teacher panel and the server: grade math, study tips and the printable A4 sheets.
// Nothing at the top level touches the DOM, so server.js can require it for the same numbers the pages show.
const Report = (() => {
  // A class average is shown only when this many classmates have grades, so no single score can be inferred.
  const MIN_CLASS = 5;

  const num = v => (v == null || v === "" ? null : Number(v));
  const round1 = v => Math.round(v * 10) / 10;
  const fmt = v => (v == null ? "—" : (Math.round(v * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // html2canvas drops the joining of "هـ" written straight after digits (1447هـ); a space keeps it intact on the sheets.
  const tx = s => esc(s).replace(/(\d)\u0647\u0640/g, "$1 \u0647\u0640");

  // Homework and the final exam show, and count toward the total, once the teacher sets their maximum. For each student
  // they count once graded, so a final exam not sat yet does not pull her percentage down.
  const EXTRAS = { homework: "الواجبات", final: "الاختبار النهائي" };
  const extrasOf = max => Object.keys(EXTRAS).filter(k => max[k] > 0);

  // One student's numbers (API or panel row). A missing participation or projects score counts as zero, as in the panel.
  function scores(r, max) {
    const t1 = num(r.test1), t2 = num(r.test2);
    let test = num(r.testAvg !== undefined ? r.testAvg : r.test_avg);
    if (test == null && t1 != null && t2 != null) test = (t1 + t2) / 2;
    const part = num(r.participation), proj = num(r.projects);
    const extra = { homework: num(r.homework), final: num(r.finalExam !== undefined ? r.finalExam : r.final_exam) };
    const shown = extrasOf(max), counted = shown.filter(k => extra[k] != null);
    const maxTotal = counted.reduce((a, k) => a + max[k], max.test + max.participation + max.projects);
    const total = test == null ? null : counted.reduce((a, k) => a + extra[k], test + (part || 0) + (proj || 0));
    const pct = total == null ? null : Math.round((total / maxTotal) * 100);
    const any = [t1, t2, test, part, proj, ...shown.map(k => extra[k])].some(v => v != null);
    return { t1, t2, test, part, proj, ...extra, total, maxTotal, pct, has: pct != null, any };
  }

  function classStats(list, max) {
    const graded = list.map(r => scores(r, max)).filter(s => s.has);
    if (graded.length < MIN_CLASS) return null;
    // Each part's average needs as many classmates as the whole, or a single score could be read from it.
    const mean = vals => { const v = vals.filter(x => x != null); return v.length >= MIN_CLASS ? round1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    return {
      n: graded.length,
      test: mean(graded.map(s => s.test)),
      participation: mean(graded.map(s => s.part)),
      projects: mean(graded.map(s => s.proj)),
      homework: mean(graded.map(s => s.homework)),
      final: mean(graded.map(s => s.final)),
      pct: Math.round((graded.reduce((a, s) => a + s.total / s.maxTotal, 0) / graded.length) * 100),
    };
  }

  const level = p => (p >= 0.9 ? ["good", "ممتاز"] : p >= 0.75 ? ["good", "جيد جداً"] : p >= 0.6 ? ["warn", "جيد"] : ["low", "يحتاج دعم"]);

  // ---------- Class names: "الثاني الثانوي / 1" is the second grade, section 1 ----------
  const GRADES = ["الأول الثانوي", "الثاني الثانوي", "الثالث الثانوي"];
  const className = (grade, section) => `${GRADES[grade - 1]} / ${section}`;
  // Grade and section of a name in that form; null for any other name, such as an old "1".
  const classParts = name => {
    const m = /^(.+) \/ (\d{1,2})$/.exec(name || ""), grade = m ? GRADES.indexOf(m[1]) + 1 : 0;
    return grade ? { grade, section: Number(m[2]) } : null;
  };
  const classLabel = name => (!name ? "" : classParts(name) ? name : `الفصل ${name}`);
  const shortClass = name => { const p = classParts(name); return p ? `${GRADES[p.grade - 1].split(" ")[0]} / ${p.section}` : classLabel(name); };

  const STAR = '<svg class="star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';
  const SPROUT = '<svg class="star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22V11"/><path d="M12 11C12 6 8 4 3 4c0 5 3 7 9 7z"/><path d="M12 14c0-4 3-6 9-6 0 4-3 6-9 6z"/></svg>';

  function praiseFor(pct, first) {
    if (pct >= 95) return { cls: "", icon: STAR, title: `ما شاء الله يا ${first}! أداء متميز`, text: "نتيجتك تدل على اجتهاد وإصرار. أنتِ قدوة لزميلاتك، فاستمري على هذا التألق." };
    if (pct >= 90) return { cls: "", icon: STAR, title: `أحسنتِ يا ${first}، نتيجة ممتازة`, text: "جهدك واضح ومثمر. خطوة صغيرة بعد وتصلين للقمة." };
    if (pct >= 80) return { cls: "", icon: STAR, title: `رائعة يا ${first}، أنتِ على الطريق الصحيح`, text: "مستواك جميل جداً، ومع قليل من المراجعة ستكونين من المتفوقات." };
    if (pct >= 65) return { cls: "calm", icon: SPROUT, title: `بداية طيبة يا ${first}`, text: "عندك قدرات جميلة، وبالمراجعة المنتظمة ستلاحظين الفرق بسرعة." };
    return { cls: "calm", icon: SPROUT, title: `نثق بكِ يا ${first}`, text: "كل خطوة تقدّم تُحسب لك. معلمتك بجانبك، وبالتدريب المستمر تتحسن النتائج." };
  }

  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const STYLES = {
    "بصري": {
      tip: "تتعلمين أفضل بالصور والخرائط الذهنية والألوان والمخططات.",
      icon: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
      tips: [
        "حوّلي كل درس إلى خريطة ذهنية ملوّنة تجمع أفكاره في صفحة واحدة.",
        "ظلّلي بألوان ثابتة: لون للتعريفات، ولون للأمثلة، ولون للقواعد.",
        "ارسمي جداول مقارنة ومخططات بدل الفقرات الطويلة.",
        "شاهدي صوراً أو مقاطع قصيرة تشرح الدرس قبل مذاكرته.",
        "ضعي بطاقات ملخّصة أمام مكتبك وراجعيها بنظرة كل يوم.",
      ],
    },
    "سمعي": {
      tip: "تتعلمين أفضل بالاستماع والنقاش والشرح الصوتي والتكرار بصوت مسموع.",
      icon: svg('<path d="M6 8.5a6 6 0 1 1 12 0c0 3.5-3 4.5-3 7.5a3 3 0 0 1-6 0"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0"/>'),
      tips: [
        "اشرحي الدرس بصوت مسموع كأنكِ المعلمة.",
        "سجّلي ملخص الدرس بصوتك واستمعي إليه في أوقات الانتظار.",
        "ذاكري مع زميلة بالنقاش وتبادل الأسئلة.",
        "حوّلي القواعد والتعريفات إلى جمل قصيرة لها إيقاع يسهل تذكّره.",
        "اقرئي السؤال بصوت منخفض قبل حلّه لتفهمي المطلوب بدقة.",
      ],
    },
    "حركي": {
      tip: "تتعلمين أفضل بالتجربة والأنشطة العملية والحركة ولعب الأدوار.",
      icon: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>'),
      tips: [
        "ذاكري على فترات قصيرة، وخذي استراحة حركية بينها.",
        "استخدمي بطاقات تقلبينها وترتّبينها بيدك للمراجعة.",
        "طبّقي ما تتعلمينه بتجربة أو نموذج أو نشاط عملي.",
        "امشي وأنتِ تسمّعين المعلومات لنفسك.",
        "حلّي التمارين بيدك، ولا تكتفي بالقراءة.",
      ],
    },
    "كتابي": {
      tip: "تتعلمين أفضل بالقراءة وتدوين الملاحظات والتلخيص والكتابة.",
      icon: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
      tips: [
        "لخّصي كل درس بأسلوبك في صفحة واحدة بعد شرحه.",
        "أعيدي كتابة التعريفات والقواعد حتى تثبت.",
        "اكتبي أسئلة على الدرس وأجيبي عنها كتابةً كاختبار ذاتي.",
        "رتّبي الأفكار في قوائم ونقاط مرقّمة.",
        "اقرئي الدرس ثم اكتبي ما فهمتِه دون النظر إلى الكتاب.",
      ],
    },
  };
  const NO_STYLE = {
    tip: "سيُحدَّد نمط تعلّمك بعد استكمال المعلمة للتقييم، وهذه نصائح تناسب الجميع.",
    icon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2"/>'),
    tips: [
      "نظّمي وقت المذاكرة بجدول أسبوعي ثابت.",
      "راجعي الدرس في يومه ولو لربع ساعة.",
      "حلّي أسئلة الاختبارات السابقة لتتعرفي على طريقة الأسئلة.",
      "اسألي معلمتك عن أي نقطة غير واضحة أولاً بأول.",
    ],
  };
  const styleOf = name => STYLES[name] || NO_STYLE;

  const STEPS = {
    none: "ستظهر درجاتك هنا بعد رصدها، فابدئي من الآن بتنظيم وقت مذاكرتك.",
    keep: "حافظي على تميّزك: راجعي دروسك أولاً بأول، وساعدي زميلاتك، فالشرح لغيرك يثبّت معلومتك.",
    test: "ركّزي على الاختبارات: خصّصي وقتاً ثابتاً كل يوم لحل أسئلة تدريبية، وراجعي أخطاءك في الاختبار السابق.",
    part: "ارفعي درجة المشاركة: جهّزي سؤالاً أو إجابة واحدة على الأقل في كل حصة.",
    proj: "اهتمي بالمشاريع والمهام: سلّمي كل مهمة في موعدها، واسألي معلمتك عن المطلوب قبل أن تبدئي.",
    homework: "اهتمي بالواجبات: حلّي واجب كل درس في يومه، وراجعي تصحيحه لتتعلمي من أخطائك.",
  };

  // The weakest area decides the advice (a weak final exam gets the tests' advice); a student at 90% or more everywhere
  // is told to keep going.
  function nextSteps(sc, max) {
    if (!sc.has) return [STEPS.none];
    const of = (v, m) => (v == null ? null : v / m);
    const areas = [["test", of(sc.test, max.test)], ["part", of(sc.part, max.participation)], ["proj", of(sc.proj, max.projects)],
      ...extrasOf(max).map(k => [k === "final" ? "test" : k, of(sc[k], max[k])])].filter(a => a[1] != null);
    const weakest = areas.reduce((a, b) => (b[1] < a[1] ? b : a));
    return [weakest[1] >= 0.9 ? STEPS.keep : STEPS[weakest[0]]];
  }

  // ---------- Comparison with the class average, drawn as columns, rings or a table ----------
  // The teacher picks the default in the settings; on the lookup page the student can switch, and her PDF follows.
  const CHARTS = { bars: "أعمدة", pie: "دائري", table: "جدول" };
  const isChart = v => Object.prototype.hasOwnProperty.call(CHARTS, v);
  const chartOf = v => (isChart(v) ? v : "bars");
  // Each part as a percentage of its own maximum, so a part out of 10 and one out of 40 share a scale. A part with no
  // score on either side yet (a final exam not sat) is left out; the overall percentage comes last.
  function compareItems(sc, cs, max) {
    const pc = (v, m) => (v == null ? null : Math.round(Math.min(1, Math.max(0, v / m)) * 100));
    const parts = [["الاختبارات", sc.test, cs.test, max.test], ["المشاركة", sc.part, cs.participation, max.participation],
      ["المشاريع والمهام", sc.proj, cs.projects, max.projects], ...extrasOf(max).map(k => [EXTRAS[k], sc[k], cs[k], max[k]])]
      .filter(([, mine, avg]) => mine != null || avg != null)
      .map(([name, mine, avg, m]) => ({ name, mine, avg, max: m, mineP: pc(mine, m), avgP: pc(avg, m) }));
    return [...parts, { name: "النسبة الكلية", total: true, mine: sc.pct, avg: cs.pct, max: 100, mineP: pc(sc.pct, 100), avgP: pc(cs.pct, 100) }];
  }

  function versusClass(sc, cs) {
    const d = sc.pct - cs.pct;
    const both = `نسبتك ${sc.pct}% ومتوسط فصلك ${cs.pct}%.`;
    if (d >= 3) return { kind: "up", title: "أعلى من متوسط فصلك", text: `${both} أداء يستحق الفخر، استمري.` };
    if (d > -3) return { kind: "near", title: "قريبة من متوسط فصلك", text: `${both} بخطوة إضافية تتقدمين على المتوسط.` };
    return { kind: "down", title: "فرصتك للتقدّم", text: `${both} بالمراجعة المنتظمة تستطيعين تجاوز المتوسط.` };
  }

  // Archived terms first, then this term when it has grades. A change under 2 points reads as holding steady.
  function progress(history, sc, currentTitle) {
    const rows = (history || []).filter(h => h.pct != null).map(h => ({ title: h.title, pct: h.pct, now: false }));
    if (sc.has) rows.push({ title: currentTitle || "الفترة الحالية", pct: sc.pct, now: true });
    const prev = rows.filter(r => !r.now).pop();
    const delta = sc.has && prev ? sc.pct - prev.pct : null;
    const trend = delta == null ? null : delta >= 2 ? { kind: "good", text: `تقدّمتِ ${delta}% عن الفترة السابقة` }
      : delta <= -2 ? { kind: "warn", text: `أقل بـ ${-delta}% من الفترة السابقة` } : { kind: "good", text: "حافظتِ على مستواك" };
    return { rows, delta, trend };
  }

  // ---------- Printable sheets (A4, rendered to images by html2canvas) ----------
  const LOGOS = { moe: "/img/moe.webp", school: "/img/school.webp" };
  const gradeLine = site => site.gradeLabel + (site.termTitle ? " · " + site.termTitle : "");
  // Hijri first, Gregorian in brackets. Intl keeps a space before "هـ", which html2canvas needs.
  const issued = () => {
    const d = new Date(), on = cal => d.toLocaleDateString(`ar-SA-u-ca-${cal}-nu-latn`, { day: "numeric", month: "long", year: "numeric" });
    return `${on("islamic-umalqura")} (${on("gregory")})`;
  };

  const head = (title, sub) => `
  <div class="rp-band"><i></i><i></i></div>
  <div class="rp-head">
    <div class="rp-gov">المملكة العربية السعودية<span>وزارة التعليم</span><span>الإدارة العامة للتعليم بمنطقة الرياض</span><span>الثانوية الثامنة والخمسون بعد المائة</span></div>
    <img class="rp-moe" src="${LOGOS.moe}" alt="">
    <img class="rp-school" src="${LOGOS.school}" alt="">
  </div>
  <div class="rp-title"><h1>${tx(title)}</h1><p>${tx(sub)}</p></div>`;
  const signs = site => `
  <div class="rp-signs">
    <div class="rp-sign"><div class="rp-k">معلمة المادة</div><div class="rp-n">${esc(site.teacherName)}</div><div class="rp-line"></div></div>
    <div class="rp-sign"><div class="rp-k">مديرة المدرسة</div><div class="rp-n">${esc(site.principalName)}</div><div class="rp-line"></div></div>
  </div>`;
  const foot = right => `<div class="rp-foot"><span>تاريخ الإصدار: ${issued()}</span><span>${esc(right)}</span></div><div class="rp-band"><i></i><i></i></div>`;
  const lvTag = p => { const [c, t] = level(p); return `<span class="rp-lvl rp-${c}">${t}</span>`; };
  const score = (v, m) => `<b>${fmt(v)}</b>${v == null ? "" : ` <small>/ ${m}</small>`}`;
  const scoreCell = (v, m, cls) => `<td${cls ? ` class="${cls}"` : ""}>${score(v, m)}${v == null ? "" : "<br>" + lvTag(v / m)}</td>`;

  // The card's comparison in its three forms. Paper has no hover, so every column and ring carries its number.
  const cols = n => `grid-template-columns:repeat(${n}, minmax(0, 1fr))`;
  const cmpColumns = items => `
        <div class="rp-plot" style="${cols(items.length)}">
          <div class="rp-gl" style="bottom:100%"><span>100%</span></div><div class="rp-gl" style="bottom:50%"><span>50%</span></div><div class="rp-gl rp-base"></div>
          ${items.map(x => `<div class="rp-cg">${[[x.mineP, "rp-you"], [x.avgP, "rp-avg"]].map(([p, c]) => `<i class="${c}" style="height:${p || 0}%"><b>${p == null ? "—" : p}</b></i>`).join("")}</div>`).join("")}
        </div>
        <div class="rp-xs" style="${cols(items.length)}">${items.map(x => `<span${x.total ? ' class="rp-tot"' : ""}>${x.name}</span>`).join("")}</div>`;
  // Rings: the student outside, the class average inside. show() paints them; html2canvas copies canvases as they are.
  const cmpRings = (items, half) => `
        <div class="rp-rings" style="${cols(half && items.length > 4 ? 3 : items.length)}">
          ${items.map(x => `<div class="rp-ring${x.total ? " rp-tot" : ""}"><canvas class="rp-donut" width="200" height="200" data-a="${x.mineP ?? ""}" data-b="${x.avgP ?? ""}"></canvas><span class="rp-rn">${x.name}</span><span class="rp-rv">الفصل ${x.avgP == null ? "—" : x.avgP + "%"}</span></div>`).join("")}
        </div>`;
  const cmpTable = items => `
        <table class="rp-mini"><tr><th></th><th>درجتك</th><th>متوسط الفصل</th></tr>
        ${items.map(x => (x.total ? `<tr class="rp-sum"><td>${x.name}</td><td>${x.mine}%</td><td>${x.avg}%</td></tr>`
          : `<tr><td>${x.name}</td><td>${fmt(x.mine)} <small>/ ${x.max}</small></td><td>${fmt(x.avg)}</td></tr>`)).join("")}</table>`;

  // r: the lookup API shape (camelCase) plus optional classStats and history.
  function cardSheet(r, ctx) {
    const { max, site } = ctx;
    const sc = scores(r, max);
    const st = styleOf(r.learningStyle);
    const cs = sc.has ? r.classStats : null;
    const pg = progress(r.history, sc, site.termTitle);
    const showProgress = (r.history || []).length > 0 && pg.rows.length > 0;
    const pr = sc.has ? praiseFor(sc.pct, String(r.name).split(" ")[0]) : null;
    const ex = extrasOf(max), hw = ex.includes("homework"), fin = ex.includes("final");
    const results = sc.any ? `
    <table class="rp-grades">
      <tr><th colspan="3">الاختبارات</th><th colspan="${hw ? 3 : 2}">التقييم المستمر</th>${fin ? '<th rowspan="2">الاختبار النهائي</th>' : ""}</tr>
      <tr class="rp-sub"><th>الاختبار الأول</th><th>الاختبار الثاني</th><th>متوسط الاختبارين</th><th>المشاركة</th><th>المشاريع والمهام</th>${hw ? "<th>الواجبات</th>" : ""}</tr>
      <tr><td>${score(sc.t1, max.test)}</td><td>${score(sc.t2, max.test)}</td>${scoreCell(sc.test, max.test, "rp-key")}
      ${scoreCell(sc.part, max.participation)}${scoreCell(sc.proj, max.projects)}${hw ? scoreCell(sc.homework, max.homework) : ""}${fin ? scoreCell(sc.final, max.final) : ""}</tr>
    </table>` : `<div class="rp-empty">لم تُرصد درجات هذه الفترة بعد.</div>`;
    // Beside the progress box the comparison has half the width, so its rings wrap to three a row.
    const form = chartOf(ctx.chart), half = !!cs && showProgress;
    const cmp = cs ? `
      <div class="rp-box rp-cmp">
        <div class="rp-cmp-head"><h3>مقارنة بمتوسط الفصل</h3>${form === "table" ? "" : '<span class="rp-key"><span><i class="rp-you"></i>درجتك</span><span><i class="rp-avg"></i>متوسط الفصل</span></span>'}</div>
        ${(form === "table" ? cmpTable : form === "pie" ? cmpRings : cmpColumns)(compareItems(sc, cs, max), half)}
      </div>` : "";
    // Room on the page for the last four periods; the lookup page lists them all.
    const prog = showProgress ? `
      <div class="rp-box">
        <h3>التقدم عبر الفترات</h3>
        <table class="rp-mini"><tr><th>الفترة</th><th>النسبة</th></tr>
        ${pg.rows.slice(-4).map(x => `<tr${x.now ? ' class="rp-sum"' : ""}><td>${tx(x.title)}</td><td>${x.pct}%</td></tr>`).join("")}</table>
        ${pg.trend ? `<div class="rp-t">${pg.trend.text}</div>` : ""}
      </div>` : "";
    const extras = cmp || prog ? `<div class="${cmp && prog ? "rp-row2" : "rp-row1"}">${cmp}${prog}</div>` : "";
    return `
<div class="rp-sheet">
  ${head("بطاقة نتيجة الطالبة", gradeLine(site))}
  <div class="rp-body">
    <div class="rp-info">
      <dl>
        <dt>اسم الطالبة</dt><dd class="rp-name">${esc(r.name)}</dd>
        <dt>رقم الهوية</dt><dd class="rp-mono">${esc(r.id)}</dd><dt>الفصل</dt><dd>${esc(r.classLabel || classLabel(r.class))}${r.track ? `<span class="rp-track">${esc(r.track)}</span>` : ""}</dd>
        <dt>الإيميل الوزاري</dt><dd class="rp-mono rp-wide">${esc(r.email || "")}</dd>
      </dl>
      ${sc.has ? `<canvas class="rp-score" width="340" height="340" data-pct="${sc.pct}" data-sub="${fmt(sc.total)} من ${sc.maxTotal}"></canvas>` : ""}
    </div>
    ${results}
    ${extras}
    <div class="rp-box rp-study">
      <div class="rp-study-head"><span class="rp-k">نمط التعلم</span><span class="rp-v">${esc(r.learningStyle || "لم يُحدَّد بعد")}</span><span class="rp-t">${esc(st.tip)}</span></div>
      <div class="rp-tips"><b>نصائح مذاكرة تناسبك</b>${st.tips.slice(0, 3).map(t => `<div class="rp-li">${esc(t)}</div>`).join("")}</div>
      <div class="rp-next"><b>خطوتك القادمة</b>${nextSteps(sc, max).map(t => `<span>${esc(t)}</span>`).join("")}</div>
    </div>
    ${pr ? `<div class="rp-praise">${STAR}<div><b>${esc(pr.title)}</b><span>${esc(pr.text)}</span></div></div>` : ""}
  </div>
  ${signs(site)}
  ${foot("صادرة من نظام استعلام النتائج")}
</div>`;
  }

  // Whole-class grade sheet. Rows have a fixed height, so page capacity is known: up to ROWS_ONE students fit
  // on one page with the signatures; bigger classes split evenly over pages of at most ROWS_PAGE, signatures on the last.
  const ROWS_ONE = 30, ROWS_PAGE = 34;
  const sheetPages = n => (n <= ROWS_ONE ? 1 : Math.max(2, Math.ceil(n / ROWS_PAGE)));
  // A student with learning difficulties is marked with an asterisk and left out of the class average.
  function classSheets(cls, list, ctx) {
    const { max, site, track } = ctx;
    const ex = extrasOf(max);
    const rows = list.map(r => ({ r, sc: scores(r, max) })).sort((a, b) => String(a.r.name).localeCompare(String(b.r.name), "ar"));
    const graded = rows.filter(x => x.sc.has), counted = graded.filter(x => !x.r.learningDifficulty);
    // A student not graded yet in homework or the final has a smaller total. The header names the total most of the
    // class is out of, and a total out of another one says so in its cell.
    const outOf = graded.map(x => x.sc.maxTotal);
    const top = outOf.length ? outOf.reduce((a, b) => (outOf.filter(v => v === b).length > outOf.filter(v => v === a).length ? b : a))
      : ex.reduce((a, k) => a + max[k], max.test + max.participation + max.projects);
    // With homework and the final the score columns narrow a little (all but "المشاريع", the widest heading), to leave the names room.
    const w = ex.length ? 11 : 12, widths = [6, 0, w, w, w, w, 12, ...ex.map(() => w), 13, 12, ex.length ? 18 : 20];
    const avg = counted.length ? Math.round(counted.reduce((a, x) => a + x.sc.pct, 0) / counted.length) : null;
    const count = test => graded.filter(x => test(x.sc.pct)).length;
    const per = Math.max(1, Math.ceil(rows.length / sheetPages(rows.length)));
    const pages = [];
    for (let i = 0; i < rows.length || !pages.length; i += per) pages.push(rows.slice(i, i + per));
    const title = `كشف درجات ${classLabel(cls)}`, sub = [track, gradeLine(site)].filter(Boolean).join(" · ");
    const footText = (chunk, p) => [chunk.some(x => x.r.learningDifficulty) ? "* صعوبات تعلم، خارج متوسط الفصل" : "",
      pages.length > 1 ? `صفحة ${p + 1} من ${pages.length}` : ""].filter(Boolean).join(" · ") || "صادرة من نظام استعلام النتائج";
    return pages.map((chunk, p) => `
<div class="rp-sheet rp-class">
  ${head(p ? `${title} (تابع)` : title, sub)}
  <div class="rp-body">
    ${p ? "" : `<div class="rp-stats">
      <div><span>عدد الطالبات</span><b>${rows.length}</b></div>
      <div><span>متوسط الفصل</span><b>${avg == null ? "—" : avg + "%"}</b></div>
      <div><span>ممتاز</span><b>${count(v => v >= 90)}</b></div>
      <div><span>جيد جداً</span><b>${count(v => v >= 75 && v < 90)}</b></div>
      <div><span>جيد</span><b>${count(v => v >= 60 && v < 75)}</b></div>
      <div><span>يحتاج دعم</span><b>${count(v => v < 60)}</b></div>
    </div>`}
    <table class="rp-list">
      <colgroup>${widths.map(w => (w ? `<col style="width:${w}mm">` : "<col>")).join("")}</colgroup>
      <tr><th>م</th><th class="rp-nm">اسم الطالبة</th><th>الاختبار الأول<small>/ ${max.test}</small></th><th>الاختبار الثاني<small>/ ${max.test}</small></th><th>المتوسط<small>/ ${max.test}</small></th><th>المشاركة<small>/ ${max.participation}</small></th><th>المشاريع<small>/ ${max.projects}</small></th>${ex.map(k => `<th>${k === "final" ? "النهائي" : EXTRAS[k]}<small>/ ${max[k]}</small></th>`).join("")}<th>المجموع<small>/ ${top}</small></th><th>النسبة</th><th>المستوى</th></tr>
      ${chunk.map((x, i) => `<tr><td>${p * per + i + 1}</td><td class="rp-nm">${esc(x.r.name)}${x.r.learningDifficulty ? " *" : ""}</td><td>${fmt(x.sc.t1)}</td><td>${fmt(x.sc.t2)}</td><td>${fmt(x.sc.test)}</td><td>${fmt(x.sc.part)}</td><td>${fmt(x.sc.proj)}</td>${ex.map(k => `<td>${fmt(x.sc[k])}</td>`).join("")}<td>${fmt(x.sc.total)}${x.sc.has && x.sc.maxTotal !== top ? `<small>/${x.sc.maxTotal}</small>` : ""}</td><td><b>${x.sc.has ? x.sc.pct + "%" : "—"}</b></td><td>${x.sc.has ? lvTag(x.sc.pct / 100) : "—"}</td></tr>`).join("")}
    </table>
  </div>
  ${p === pages.length - 1 ? signs(site) : ""}
  ${foot(footText(chunk, p))}
</div>`);
  }

  function drawRing(canvas, pct) {
    const c = canvas.getContext("2d"), s = canvas.width, r = s / 2 - 18;
    c.lineWidth = 30; c.lineCap = "butt";
    c.strokeStyle = "#e6efed"; c.beginPath(); c.arc(s / 2, s / 2, r, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = "#0d6e6a"; c.beginPath(); c.arc(s / 2, s / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(pct, 100) / 100); c.stroke();
    c.textAlign = "center"; c.direction = "rtl";
    c.fillStyle = "#1d2433"; c.font = '700 76px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    c.fillText(pct + "%", s / 2, s / 2 + 18);
    c.fillStyle = "#667085"; c.font = '500 30px "IBM Plex Sans Arabic", Tahoma, sans-serif';
    c.fillText(canvas.dataset.sub, s / 2, s / 2 + 66);
  }

  // A comparison ring on the card: her percentage around the outside, the class average inside, her number in the middle.
  function drawDonut(canvas) {
    const c = canvas.getContext("2d"), s = canvas.width, mid = s / 2;
    const val = k => (canvas.dataset[k] === "" ? null : Number(canvas.dataset[k]));
    const arc = (r, w, color, p) => {
      c.lineWidth = w; c.strokeStyle = color;
      c.beginPath(); c.arc(mid, mid, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p / 100); c.stroke();
    };
    const a = val("a"), b = val("b");
    c.lineCap = "butt";
    arc(s * 0.42, s * 0.11, "#e3ebe9", 100);
    if (a) arc(s * 0.42, s * 0.11, "#008a80", a);
    arc(s * 0.28, s * 0.075, "#eef2f1", 100);
    if (b) arc(s * 0.28, s * 0.075, "#94a6a9", b);
    c.textAlign = "center"; c.textBaseline = "middle"; c.direction = "ltr";
    const t = a == null ? "—" : a + "%";
    c.fillStyle = "#1d2433"; c.font = `700 ${Math.round(s * (t.length > 3 ? 0.15 : 0.18))}px "IBM Plex Sans Arabic", Tahoma, sans-serif`;
    c.fillText(t, mid, mid + s * 0.01);
  }

  function loadScript(src) {
    return new Promise((ok, fail) => {
      if (document.querySelector(`script[src="${src}"]`)) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error("load_failed"));
      document.head.appendChild(s);
    });
  }

  // Puts sheets into `host` exactly as they print, score ring included: off-screen for a PDF, or on screen to look at.
  function show(host, sheets) {
    host.innerHTML = `<div class="rpt">${sheets.join("")}</div>`;
    host.querySelectorAll("canvas.rp-score").forEach(c => drawRing(c, Number(c.dataset.pct)));
    host.querySelectorAll("canvas.rp-donut").forEach(drawDonut);
  }

  // Renders each sheet off-screen and stacks them into one A4 PDF. Big batches use a lighter image setting.
  async function toPdf(sheets, { onProgress } = {}) {
    await Promise.all([loadScript("/vendor/html2canvas.min.js"), loadScript("/vendor/jspdf.umd.min.js")]);
    await document.fonts.ready;
    const many = sheets.length > 3;
    const pdf = new jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    const host = document.createElement("div");
    host.className = "rpt-host";
    document.body.appendChild(host);
    try {
      for (let i = 0; i < sheets.length; i++) {
        onProgress?.(i + 1, sheets.length);
        show(host, [sheets[i]]);
        await Promise.all([...host.querySelectorAll("img")].map(img => (img.complete ? 0 : new Promise(ok => { img.onload = img.onerror = ok; }))));
        const canvas = await html2canvas(host.querySelector(".rp-sheet"), { scale: many ? 2 : 2.5, backgroundColor: "#ffffff", useCORS: true, logging: false });
        if (i) pdf.addPage();
        pdf.addImage(canvas.toDataURL("image/jpeg", many ? 0.85 : 0.95), "JPEG", 0, 0, 210, 297);
        canvas.width = canvas.height = 0;
      }
      return pdf.output("blob");
    } finally {
      host.remove();
    }
  }

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  return { MIN_CLASS, STAR, SPROUT, fmt, esc, EXTRAS, extrasOf, scores, classStats, level, GRADES, className, classParts, classLabel, shortClass, praiseFor, styleOf, STYLES, nextSteps, CHARTS, isChart, chartOf, compareItems, versusClass, progress, gradeLine, cardSheet, classSheets, sheetPages, show, toPdf, save };
})();

if (typeof module === "object" && module.exports) module.exports = Report;
