/* Teaching by learning style: the teacher picks a class and a lesson, and the panel groups her students by learning style
   with ready activities for each group, each linked to the station of the interactive lesson it uses. Same groups print as
   an A4 "differentiated lesson plan". Needs report.js (Report) loaded first. */
const Teach = (() => {
  const { esc, classLabel, shortClass } = Report;
  const KEYS = ["بصري", "سمعي", "حركي", "كتابي"];
  const NONE = "لم يُحدَّد";
  const GENERAL = "general";

  // a: [title, what the group does, station anchor in the lesson page, station name]
  const A = (t, d, at, st) => ({ t, d, at, st });

  // The interactive lessons on the site. grade: 1 = الأول الثانوي, 2 = الثاني الثانوي. Anchors are the pages' own:
  // section ids, except the slide lesson 3-5, which opens on the station number after "#".
  const LESSONS = [
    {
      id: "polynomials", code: "3-3", title: "العمليات على كثيرات الحدود", book: "رياضيات 2", grade: 2, url: "/lessons/polynomials",
      styles: {
        "بصري": [
          A("مختبر القوى", "اعرضي المختبر على السبورة، وخلّي المجموعة تتوقع الناتج قبل ما تتحرك المتغيرات، ثم تلوّن كل أس في دفترها بلون ثابت.", "#powers", "ضرب وحيدات الحد وقسمتها"),
          A("ألوان الحدود المتشابهة", "قبل الجمع تلوّن كل طالبة الحدود المتشابهة بلون واحد مثل ألوان المختبر، ثم تجمع كل لون لحاله.", "#addsub", "جمع كثيرات الحدود وطرحها"),
          A("طريقة الصندوق", "ترسم جدول الضرب وتعبّي خاناته، وتقارنه بنموذج المساحة بالبلاطات الجبرية.", "#multiply", "ضرب كثيرات الحدود"),
        ],
        "سمعي": [
          A("نقاش «لماذا؟»", "وحدة تقرأ مسألة ضوء الشمس بصوت، والمجموعة تتناقش: وش العملية اللي نحتاجها، وليش؟", "#why", "لماذا نحتاج هذا الدرس؟"),
          A("قواعد الأسس بإيقاع", "تحوّل المجموعة خصائص الأسس إلى جمل قصيرة مسموعة («نضرب؟ نجمع الأسس. نقسم؟ نطرحها») وتسمّعها لبعض.", "#powers", "ملخص خصائص الأسس"),
          A("اشرحي لزميلتك", "في أزواج: وحدة تشرح خطوة التبسيط بصوت قبل «الخطوة التالية»، والثانية تحكم هل صح، ثم تتبادلن.", "#simplify", "تبسيط العبارات"),
        ],
        "حركي": [
          A("بطاقات الحدود", "بطاقات ورق عليها حدود مختلفة، تجمع الطالبات المتشابه منها على الطاولة ثم يكتبن الناتج.", "#addsub", "مختبر الجمع والطرح"),
          A("البلاطات الجبرية", "تكوّن المجموعة المستطيل بالبلاطات (ورق أو على الجهاز) لتشوف حاصل الضرب كمساحة.", "#multiply", "نموذج المساحة"),
          A("قومي إذا كانت كثيرة حدود", "تعرضين عبارة، واللي تشوفها كثيرة حدود توقف، ثم تبرر وحدة من الواقفات واحدة من الجالسات.", "#degree", "كثيرة حدود أم لا؟"),
        ],
        "كتابي": [
          A("بطاقة القواعد", "تكتب كل طالبة خصائص الأسس بأسلوبها مع مثال محلول لكل خاصية.", "#powers", "ملخص خصائص الأسس"),
          A("مسألة من الواقع", "تكتب مسألة تشبه مسألة الشاحنة وتحلها كتابةً، ثم تتبادلها مع زميلتها.", "#life", "من واقع الحياة"),
          A("اختبري نفسك كتابةً", "تحل الأسئلة في الدفتر أولًا ثم تتحقق في الصفحة، وتكتب سبب كل خطأ وقعت فيه.", "#quiz", "اختبري نفسك"),
        ],
      },
    },
    {
      id: "polynomial-division", code: "3-4", title: "قسمة كثيرات الحدود", book: "رياضيات 2", grade: 2, url: "/lessons/polynomial-division",
      styles: {
        "بصري": [
          A("صندوق المساحة", "تشاهد المجموعة الصندوق وترسمه في الدفتر، وتلوّن الضلع المجهول اللي هو ناتج القسمة.", "#s2", "الصندوق"),
          A("ألوان القسمة الطويلة", "شغّلي العرض المتحرك، وتلوّن كل طالبة الحركات الأربع (اقسمي، اضربي، اطرحي، أنزلي) بلون ثابت لكل حركة.", "#s3", "الطويلة"),
          A("خريطة الطرق الثلاث", "ترسم خريطة ذهنية تجمع: القسمة على وحيدة حد، والطويلة، والتركيبية، ومتى تستعمل كل وحدة.", "#s8", "الخلاصة"),
        ],
        "سمعي": [
          A("قصة سلمى", "وحدة تقرأ مسألة غلاف الكتاب بصوت، والمجموعة تتناقش ليش احتجنا نقسم المساحة على الطول.", "#s0", "الغلاف"),
          A("إيقاع التركيبية", "تردد المجموعة «أنزلي، اضربي، اجمعي» مع كل عمود وهي تحل على آلة القسمة التركيبية.", "#s5", "التركيبية"),
          A("المعلمة الصغيرة", "وحدة تملي خطوات القسمة الطويلة بصوت والباقيات ينفذن، ثم تتبادلن الدور.", "#s3", "الطويلة"),
        ],
        "حركي": [
          A("مقص الكسر", "تقص الطالبة ورقة مكتوب عليها الكسر إلى قطع، كل حد لحاله، وتبسّط كل قطعة.", "#s1", "المقص"),
          A("آلة بشرية", "ثلاث طالبات يمثلن خطوات القسمة التركيبية: وحدة تنزل، ووحدة تضرب في r، ووحدة تجمع، والباقيات يتحققن.", "#s5", "التركيبية"),
          A("سباق الأختام", "في أزواج، تحل المجموعة مسائل طاولة التدريب وتجمع أكبر عدد من الأختام في الجواز.", "#s6", "التدريب"),
        ],
        "كتابي": [
          A("الخوارزمية بأسلوبك", "تكتب خطوات القسمة الطويلة مرقمة بأسلوبها، وتطبقها على مسألة من اختيارها.", "#s3", "الطويلة"),
          A("ليش تنفع حيلة التعويض؟", "تكتب تفسيرًا لحيلة مثال 3: ليش التعويض بقيمة واحدة يكشف البدائل الخاطئة.", "#s4", "الباقي"),
          A("اختبري نفسك كتابةً", "تحل تمارين «تأكد» في الدفتر قبل ما تختار الإجابة في الصفحة.", "#s7", "الاختبار"),
        ],
      },
    },
    {
      id: "polynomial-functions", code: "3-5", title: "دوال كثيرات الحدود", book: "رياضيات 2", grade: 2, url: "/lessons/polynomial-functions",
      styles: {
        "بصري": [
          A("أشكال المنحنيات", "تحرك المجموعة شريط الدرجة وترسم في الدفتر شكل المنحنى لكل درجة من 0 إلى 5.", "#5", "أشكال المنحنيات"),
          A("جدول سلوك الطرفين", "ترسم جدولًا من أربع خانات (زوجية أو فردية، موجب أو سالب) بأسهم توضح اتجاه الذراعين.", "#6", "سلوك الطرفين"),
          A("تشريح بالألوان", "تلوّن المعامل الرئيس والدرجة والحد الثابت في كل دالة بنفس ألوان الصفحة.", "#2", "تشريح كثيرة الحدود"),
        ],
        "سمعي": [
          A("نَفَس واحد", "تتنفس المجموعة مع المنحنى، وتصف بصوت متى يزيد حجم الهواء ومتى ينقص.", "#1", "لماذا؟ نَفَس واحد"),
          A("نقاش الفرز", "قبل كل إجابة في تحدي الفرز تقول الطالبة بصوت: ليش هذه العبارة كثيرة حدود أو لا؟", "#3", "فرز العبارات"),
          A("محققات المنحنيات", "تحل المجموعة القضايا الخمس معًا، وكل وحدة تبرر جوابها بصوت قبل الضغط.", "#8", "تحدي المحققة"),
        ],
        "حركي": [
          A("الذراعان بالجسم", "تقولين دالة، والطالبات يرفعن أو ينزلن أيديهن حسب سلوك طرفي منحناها.", "#6", "سلوك الطرفين"),
          A("آلة الدالة والمربعات", "تدخل الطالبة أعدادًا في آلة الدالة، وتنقل النقاط على ورق مربعات وتوصلها بيدها.", "#4", "آلة الدالة"),
          A("حرّكي المنحنى", "تزيح المنحنى للأعلى والأسفل، وتسجل عدد الأصفار الحقيقية في كل وضع.", "#7", "الأصفار الحقيقية"),
        ],
        "كتابي": [
          A("بطاقة تعريف الدالة", "تكتب لكل دالة: الدرجة، والمعامل الرئيس، وسلوك الطرفين، وأقصى عدد للأصفار.", "#3", "فرز العبارات"),
          A("التعويض بعبارة", "تكتب حل مثال 3 خطوة بخطوة، ثم تحل مسألة مشابهة.", "#4", "آلة الدالة"),
          A("خلاصة بكلماتك", "تعيد كتابة خلاصة المرصد بأسلوبها مع مثال لكل قاعدة.", "#9", "الخلاصة"),
        ],
      },
    },
    {
      id: "perpendicular-distance", code: "2-6", title: "الأعمدة والمسافة", book: "رياضيات 1", grade: 1, url: "/lessons/perpendicular-distance",
      styles: {
        "بصري": [
          A("أي طريق أقصر؟", "تسحب المجموعة النقطة X وتراقب الطول والزاوية، وترسم في الدفتر رسمًا يبين أن العمودي هو الأقصر.", "#s1", "أقصر مسافة"),
          A("الإنشاء خطوة بخطوة", "تشاهد خطوات الفرجار في الصفحة، ثم تعيد الرسم في دفترها.", "#s3", "الفرجار"),
          A("مخطط الخطوات الأربع", "ترسم مخططًا مصورًا لخطوات إيجاد البعد في المستوى الإحداثي.", "#s4", "نقطة ومستقيم"),
        ],
        "سمعي": [
          A("سر الشاقول", "تسألين: ليش يستعمل البنّاء الشاقول؟ والمجموعة تتناقش وتربطها بأقصر مسافة.", "#s0", "الشاقول"),
          A("المسلّمة بكلماتك", "تصيغ كل طالبة مسلّمة 2.6 بكلماتها وتشرحها لزميلتها بصوت.", "#s2", "المسلّمة"),
          A("هل البعد ثابت؟", "بعد تجربة السكة، تبرر كل طالبة بصوت ليش البعد بين المتوازيين ما يتغير.", "#s5", "المتوازيان"),
        ],
        "حركي": [
          A("شاقول حقيقي", "خيط في طرفه ثقل (مثل المفاتيح) في الفصل، وتقيس المجموعة طول الخيط المائل والساكن بالمسطرة.", "#s0", "الشاقول"),
          A("فرجار ومسطرة", "تنشئ كل طالبة العمود من نقطة إلى مستقيم بأدواتها على الورق.", "#s3", "الفرجار"),
          A("عين المهندسة", "مسابقة الجولات الخمس: من تجمع نجومًا أكثر في تقدير قدم العمود؟", "#s6", "التحدي"),
        ],
        "كتابي": [
          A("الخطوات الأربع كتابةً", "تكتب خطوات الكتاب الأربع وتطبقها على مسألة من الصفحة.", "#s4", "نقطة ومستقيم"),
          A("تعريفان بأسلوبك", "تكتب تعريف البعد بين نقطة ومستقيم، والبعد بين مستقيمين متوازيين، مع رسم صغير.", "#s8", "الخلاصة"),
          A("اختبري نفسك كتابةً", "تحل أسئلة «تأكد» و«تدرّب» في الدفتر قبل ما تجاوب في الصفحة.", "#s7", "الاختبار"),
        ],
      },
    },
  ];

  // For any lesson, in any subject.
  const GENERAL_STYLES = {
    "بصري": [
      A("خريطة ذهنية ملونة", "تجمع الطالبة أفكار الدرس في خريطة واحدة بألوان ثابتة: لون للتعريف ولون للمثال ولون للقاعدة."),
      A("منظم تخطيطي", "جدول مقارنة أو مخطط سهمي بدل الفقرات الطويلة."),
      A("صورة أو مقطع قصير", "تعرضين صورة أو مقطعًا عن الفكرة، والمجموعة تصف ما شافته وتربطه بالدرس."),
    ],
    "سمعي": [
      A("فكّري، زاوجي، شاركي", "سؤال مفتوح: تفكر الطالبة لحالها، ثم تناقش زميلتها، ثم تشارك الفصل."),
      A("اشرحي لزميلتك", "كل طالبة تشرح جزءًا من الدرس بصوت لزميلتها، ثم تتبادلن."),
      A("ملخص مسموع", "تسجّل المجموعة ملخص الدرس بأصواتهن في دقيقة واحدة."),
    ],
    "حركي": [
      A("بطاقات ترتيب ومطابقة", "بطاقات ترتبها الطالبات أو يطابقنها بأيديهن على الطاولة."),
      A("محطات تعلم", "ثلاث محطات في الفصل تتنقل بينها المجموعة، في كل محطة مهمة قصيرة."),
      A("لعب أدوار", "تمثل المجموعة الفكرة أو الخطوات بحركة أو مشهد قصير."),
    ],
    "كتابي": [
      A("ملخص في خمسة أسطر", "تلخص الطالبة الدرس بأسلوبها في خمسة أسطر فقط."),
      A("بطاقة خروج", "قبل نهاية الحصة تكتب: شي تعلمته، وسؤال عندها."),
      A("أسئلة من صنعها", "تكتب ثلاثة أسئلة على الدرس وتجاوب عليها، ثم تتبادلها مع زميلتها."),
    ],
  };

  const NONE_TIP = "ضمّيهن لأقرب مجموعة اليوم وراقبي أي نشاط يشدّهن، ثم حدّدي نمطهن من تبويب الطالبات.";
  const isMath = subject => !subject || /رياضيات/.test(subject);
  const lessonById = id => LESSONS.find(l => l.id === id) || null;
  // Lessons that fit the class's grade (all of them when the class has no grade, or for all classes).
  const lessonsFor = (subject, grades) => (isMath(subject) ? LESSONS.filter(l => !grades.length || grades.includes(l.grade)) : []);
  const linkOf = (lesson, a) => (lesson && a.at ? lesson.url + a.at : "");
  const activitiesOf = (lesson, k) => (lesson ? lesson.styles[k] : GENERAL_STYLES[k]);

  // Students of one class (or all), grouped by learning style, names sorted.
  function groups(students, cls) {
    const list = students.filter(s => !cls || s.class === cls).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
    return [...KEYS.map(k => ({ k, list: list.filter(s => s.learning_style === k) })), { k: NONE, none: true, list: list.filter(s => !KEYS.includes(s.learning_style)) }];
  }
  const girls = n => (n === 1 ? "طالبة واحدة" : n === 2 ? "طالبتان" : n >= 3 && n <= 10 ? `${n} طالبات` : `${n} طالبة`);
  // First name and family name: short enough for the sheet, and two girls rarely share both.
  const shortName = name => { const w = String(name || "").trim().split(/\s+/); return w.length > 2 ? `${w[0]} ${w[w.length - 1]}` : w.join(" "); };

  // ---------- The panel ----------
  let host = null, ctx = null, pick = { cls: "", lesson: "" };
  const storeKey = () => "teach:" + (ctx?.teacher ?? "");
  const loadPick = () => { try { return JSON.parse(localStorage.getItem(storeKey())) || {}; } catch { return {}; } };
  const savePick = () => { try { localStorage.setItem(storeKey(), JSON.stringify(pick)); } catch {} };

  // ctx: { students, classes, subject, teacher, site() } from the admin panel.
  function render(el, c) {
    host = el; ctx = c;
    const saved = loadPick();
    if (!ctx.classes.some(x => x.name === pick.cls)) pick.cls = ctx.classes.some(x => x.name === saved.cls) ? saved.cls : "";
    draw(saved.lesson);
  }

  function draw(wantLesson) {
    const { students, classes, subject } = ctx;
    const cls = classes.find(c => c.name === pick.cls);
    const grades = cls ? (cls.grade ? [cls.grade] : []) : [...new Set(classes.map(c => c.grade).filter(Boolean))];
    const lessons = lessonsFor(subject, grades);
    const want = wantLesson ?? pick.lesson;
    pick.lesson = want === GENERAL || lessons.some(l => l.id === want) ? want : lessons[0]?.id || GENERAL;
    const lesson = lessonById(pick.lesson);
    const gs = groups(students, pick.cls);
    const total = gs.reduce((a, g) => a + g.list.length, 0);
    const ld = gs.some(g => g.list.some(s => s.learning_difficulty));

    host.innerHTML = `
      <div class="toolbar">
        <label class="f tc-pick">الفصل<select class="in" id="tcClass"><option value="">كل الفصول</option>${classes.map(c => `<option value="${esc(c.name)}">${esc(classLabel(c.name))}</option>`).join("")}</select></label>
        <label class="f tc-pick grow">الدرس<select class="in" id="tcLesson">${lessons.map(l => `<option value="${l.id}">${esc(`${l.code} ${l.title} · ${l.book}`)}</option>`).join("")}<option value="${GENERAL}">أنشطة عامة تناسب أي درس</option></select></label>
        <div class="tc-acts">
          ${lesson ? `<a class="btn quiet" href="${lesson.url}" target="_blank" rel="noopener">فتح الدرس</a>` : ""}
          <button class="btn" type="button" id="tcPdf" ${total ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>خطة الحصة PDF</button>
        </div>
      </div>
      <p class="note tc-intro">${lesson
        ? `مجموعات ${pick.cls ? esc(classLabel(pick.cls)) : "كل الفصول"} حسب نمط التعلم، ولكل مجموعة أنشطة من درس ${esc(lesson.code)} «${esc(lesson.title)}». زر «افتحيه في الدرس» يفتح المحطة نفسها في الدرس التفاعلي.`
        : `مجموعات ${pick.cls ? esc(classLabel(pick.cls)) : "كل الفصول"} حسب نمط التعلم، مع أنشطة عامة تناسب أي درس${isMath(subject) ? "" : ` في ${esc(subject)}`}.`}</p>
      <p class="note" id="tcProgress" hidden></p>
      <div class="tc-sum">${gs.map(g => `<div class="tc-n${g.none ? " none" : ""}" style="--k:var(--st-${KEYS.indexOf(g.k) + 1}, var(--viz-muted))"><b>${g.list.length}</b><span>${g.k}</span></div>`).join("")}</div>
      ${total ? `<div class="tc-groups">${gs.filter(g => !g.none).map(g => groupCard(g, lesson)).join("")}</div>
      ${gs[4].list.length ? `<div class="tc-group none"><div class="tc-gh"><h3>${NONE}</h3><span class="note">${girls(gs[4].list.length)}</span></div>
        <div class="tc-names">${names(gs[4].list)}</div><p class="note" style="margin:8px 0 0">${NONE_TIP}</p></div>` : ""}
      ${ld ? `<p class="note">* صعوبات تعلم.</p>` : ""}`
      : `<div class="empty">ما فيه طالبات ${pick.cls ? "في هذا الفصل" : ""} بعد.</div>`}`;

    host.querySelector("#tcClass").value = pick.cls;
    host.querySelector("#tcLesson").value = pick.lesson;
    host.querySelector("#tcClass").onchange = e => { pick.cls = e.target.value; savePick(); draw(); };
    host.querySelector("#tcLesson").onchange = e => { pick.lesson = e.target.value; savePick(); draw(); };
    host.querySelector("#tcPdf").onclick = makePdf;
  }

  const names = list => list.map(s => `<span>${esc(s.name)}${s.learning_difficulty ? " *" : ""}${pick.cls ? "" : ` <small>${esc(shortClass(s.class))}</small>`}</span>`).join("");

  function groupCard(g, lesson) {
    const i = KEYS.indexOf(g.k) + 1;
    return `<section class="tc-group" style="--k:var(--st-${i})">
      <div class="tc-gh"><span class="tc-ic">${Report.STYLES[g.k].icon}</span><h3>${g.k}</h3><span class="note">${g.list.length ? girls(g.list.length) : "ما فيه طالبات"}</span></div>
      ${g.list.length ? `<div class="tc-names">${names(g.list)}</div>` : ""}
      <ol class="tc-acts-list">${activitiesOf(lesson, g.k).map(a => `<li><b>${esc(a.t)}</b><span>${esc(a.d)}</span>
        ${linkOf(lesson, a) ? `<a href="${linkOf(lesson, a)}" target="_blank" rel="noopener">افتحيه في الدرس: ${esc(a.st)}</a>` : ""}</li>`).join("")}</ol>
    </section>`;
  }

  // ---------- The printed plan: one A4 sheet per class ----------
  function planSheet(cls, lesson, gs, site) {
    const total = gs.reduce((a, g) => a + g.list.length, 0);
    const sub = [lesson ? `الدرس ${lesson.code} ${lesson.title} · ${lesson.book}` : "أنشطة عامة", Report.gradeLine(site)].filter(Boolean).join(" · ");
    const ld = gs.some(g => g.list.some(s => s.learning_difficulty));
    const nm = list => list.map(s => esc(shortName(s.name)) + (s.learning_difficulty ? "*" : "")).join("، ");
    const none = gs[4];
    return `
<div class="rp-sheet rp-plan">
  ${Report.sheetHead(`خطة حصة حسب أنماط التعلم · ${classLabel(cls)}`, sub)}
  <div class="rp-body">
    <div class="rp-stats">
      <div><span>عدد الطالبات</span><b>${total}</b></div>
      ${gs.map(g => `<div><span>${g.k}</span><b>${g.list.length}</b></div>`).join("")}
    </div>
    <div class="rp-pgrid">
      ${gs.slice(0, 4).map((g, i) => `<div class="rp-pg rp-st${i + 1}">
        <h3>${Report.STYLES[g.k].icon}<span>المجموعة ${["الأولى", "الثانية", "الثالثة", "الرابعة"][i]}: ${g.k}</span><small>${g.list.length}</small></h3>
        <p class="rp-pn">${g.list.length ? nm(g.list) : "لا توجد طالبات بهذا النمط."}</p>
        ${activitiesOf(lesson, g.k).map((a, j) => `<p class="rp-pa"><span>${j + 1}</span><span><b>${esc(a.t)}:</b> ${esc(a.d)}${lesson && a.st ? ` <em>(${esc(a.st)})</em>` : ""}</span></p>`).join("")}
      </div>`).join("")}
    </div>
    ${none.list.length ? `<div class="rp-pg rp-pnone"><h3><span>${NONE}</span><small>${none.list.length}</small></h3><p class="rp-pn">${nm(none.list)}</p><p class="rp-pt">${NONE_TIP}</p></div>` : ""}
    <div class="rp-pnote"><b>ملاحظات المعلمة:</b><i></i><i></i></div>
  </div>
  ${Report.sheetSigns(site)}
  ${Report.sheetFoot(ld ? "* صعوبات تعلم" : lesson ? `الدرس التفاعلي: 158.school${lesson.url}` : "صادرة من نظام استعلام النتائج")}
</div>`;
  }

  async function makePdf() {
    const btn = host.querySelector("#tcPdf"), note = host.querySelector("#tcProgress");
    const lesson = lessonById(pick.lesson);
    const list = pick.cls ? [pick.cls] : ctx.classes.map(c => c.name).filter(n => ctx.students.some(s => s.class === n));
    btn.disabled = true; note.hidden = false; note.textContent = "جارٍ تجهيز الملف…";
    try {
      const site = ctx.site();
      const sheets = list.map(cls => planSheet(cls, lesson, groups(ctx.students, cls), site));
      const blob = await Report.toPdf(sheets, { onProgress: (i, n) => { note.textContent = `جارٍ تجهيز صفحة ${i} من ${n}…`; } });
      const what = pick.cls ? classLabel(pick.cls).replace(/\//g, "-") : "كل الفصول";
      Report.save(blob, `خطة حصة حسب الأنماط ${lesson ? lesson.code + " " : ""}${what}.pdf`);
      note.textContent = "تم تجهيز الملف.";
    } catch (err) {
      console.error(err);
      note.textContent = "تعذّر تجهيز الملف. حاولي مرة أخرى.";
    } finally { btn.disabled = false; }
  }

  return { KEYS, LESSONS, GENERAL_STYLES, lessonsFor, groups, planSheet, render };
})();

if (typeof module === "object" && module.exports) module.exports = Teach;
