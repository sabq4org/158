// The operational plan portal: tabs defined below, each a list (add, edit, delete, reorder) and/or a few single fields.
// Everything is read once from /api/admin/plan and kept in `S`; each change goes to the server and updates `S` in place.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const API = "/api/admin";

  // ---------- The tabs ----------
  const QUAL = ["بكالوريوس", "ماجستير", "دكتوراه", "دبلوم", "ثانوي"];
  const STATUS = ["على رأس العمل", "إجازة", "تكليف خارجي", "منقولة"];
  const SEMS = ["الأول", "الثاني", "الفصلان"];
  const LEVELS = ["منخفض", "متوسط", "مرتفع"];
  const DONE = { "نُفّذ": "ok", "جارٍ التنفيذ": "mid", "لم يُنفّذ": "no" };
  const DOMAINS = ["القيادة والإدارة المدرسية", "التعليم والتعلم", "نواتج التعلم", "الاتجاهات والسلوك", "الصحة واللياقة العامة", "الشراكة الأسرية والمجتمعية", "البيئة المدرسية"];
  const STRAT = ["التعليم والتعلم", "القيادة والإدارة", "دمج التقنية", "دعم الطالبات", "الشراكة المجتمعية", "ضمان الجودة", "المناخ المدرسي", "التنمية المهنية", "التخطيط والتحسين المستمر", "البيئة المدرسية", "نواتج التعلم"];
  const SWOT = [["قوة", "نقاط القوة", "البيئة الداخلية · إيجابي", "#0d8a5f"], ["ضعف", "نقاط الضعف", "البيئة الداخلية · سلبي", "#c2414b"],
    ["فرصة", "الفرص", "البيئة الخارجية · إيجابي", "#1f6fb7"], ["تهديد", "التهديدات", "البيئة الخارجية · سلبي", "#b7791f"]];

  const committee = title => ({
    title, desc: "عضوات اللجنة وأدوارهن، ومهام اللجنة.", noun: "عضوة",
    fields: [{ k: "name", l: "اسم العضوة", req: true }, { k: "title", l: "المسمى الوظيفي", list: ["مديرة", "وكيلة", "معلمة", "موجهة طلابية", "إدارية", "رائدة نشاط"] },
      { k: "role", l: "الدور في اللجنة", list: ["رئيسة اللجنة", "نائبة الرئيسة", "مقررة اللجنة", "عضوة"] }],
    meta: [{ k: "tasks", l: "مهام اللجنة (كل مهمة في سطر)", t: "lines" }],
  });

  const SECTIONS = {
    info: { title: "بيانات الخطة", desc: "البطاقة التعريفية للمدرسة والرؤية والرسالة، وتظهر في غلاف ملف PDF ومقدمته.", meta: [
      { k: "school", l: "اسم المدرسة" }, { k: "code", l: "رمز المدرسة" }, { k: "stage", l: "المرحلة" }, { k: "year", l: "العام الدراسي (هـ)" },
      { k: "office", l: "إدارة التعليم" }, { k: "building", l: "نوع المبنى", opts: ["حكومي", "مستأجر", "خاص"] },
      { k: "principal", l: "مديرة المدرسة" }, { k: "planHead", l: "رئيسة لجنة التخطيط" },
      { k: "students", l: "عدد الطالبات", t: "number" }, { k: "teachers", l: "عدد المعلمات", t: "number" }, { k: "admins", l: "عدد الإداريات", t: "number" },
      { k: "support", l: "الكادر المساند", t: "number" }, { k: "classes", l: "عدد الفصول", t: "number" },
      { k: "vision", l: "الرؤية", t: "textarea" }, { k: "mission", l: "الرسالة", t: "textarea" }, { k: "intro", l: "المقدمة", t: "textarea" },
    ] },
    committee_plan: committee("لجنة إعداد الخطة"),
    committee_excellence: committee("لجنة التميز"),
    committee_guidance: committee("لجنة التوجيه"),
    teachers: { title: "الهيئة التعليمية", desc: "المعلمات ومؤهلاتهن وتخصصاتهن ونصابهن.", noun: "معلمة", fields: [
      { k: "name", l: "الاسم الرباعي", req: true }, { k: "qualification", l: "المؤهل", opts: QUAL }, { k: "specialty", l: "التخصص" },
      { k: "load", l: "النصاب", t: "number" }, { k: "status", l: "الحالة الوظيفية", opts: STATUS }, { k: "nid", l: "السجل المدني", opt: true, hideCol: true }] },
    admins: { title: "الهيئة الإدارية", desc: "الإداريات ومسمياتهن الوظيفية.", noun: "إدارية", fields: [
      { k: "name", l: "الاسم الرباعي", req: true }, { k: "qualification", l: "المؤهل", opts: QUAL }, { k: "title", l: "المسمى الوظيفي", list: ["إدارية", "كاتبة", "وكيلة", "مساعدة إدارية", "مسجلة معلومات"] },
      { k: "phone", l: "رقم الجوال", opt: true }, { k: "status", l: "الحالة الوظيفية", opts: STATUS }] },
    beneficiaries: { title: "المستفيدات", desc: "الفئات المستفيدة من الخطة وكيف تستفيد كل فئة.", noun: "فئة", fields: [
      { k: "category", l: "الفئة", req: true, list: ["الطالبات", "المعلمات", "الهيئة الإدارية", "الموجهة الطلابية", "الموجهة الصحية", "رائدة النشاط", "أولياء الأمور", "المجتمع المحلي"] },
      { k: "description", l: "أوجه الاستفادة", t: "textarea" }] },
    aspects: { title: "الجوانب المدرسية", desc: "مجالات التطوير مرتبة حسب الأولوية، ولكل جانب مؤشراته ومقترحاته.", noun: "جانب", fields: [
      { k: "domain", l: "المجال", req: true, list: DOMAINS }, { k: "sub", l: "الجانب الفرعي", req: true }, { k: "indicators", l: "المؤشرات", t: "textarea" }, { k: "proposals", l: "المقترحات", t: "textarea" }] },
    swot: { title: "التحليل الرباعي", desc: "البيئة الداخلية (القوة والضعف) والخارجية (الفرص والتهديدات).", noun: "بند", view: "swot", fields: [
      { k: "type", l: "النوع", opts: SWOT.map(s => s[0]), req: true }, { k: "text", l: "البند", t: "textarea", req: true }] },
    edu_goals: { title: "أهداف التعليم", desc: "الأهداف العامة للتعليم وأهداف المرحلة الثانوية واستراتيجيات التنفيذ.", noun: "هدف", view: "grouped", groupBy: "kind", fields: [
      { k: "kind", l: "التصنيف", opts: ["الأهداف العامة للتعليم", "أهداف المرحلة الثانوية", "استراتيجيات التنفيذ"], req: true }, { k: "text", l: "النص", t: "textarea", req: true }] },
    strategic_goals: { title: "الأهداف الاستراتيجية", desc: "لكل مجال هدفه التفصيلي ومؤشر قياسه والمستهدف والموارد.", noun: "هدف", fields: [
      { k: "domain", l: "المجال", list: STRAT, req: true }, { k: "goal", l: "الهدف من المجال", req: true }, { k: "title", l: "الهدف التفصيلي" },
      { k: "indicator", l: "مؤشر القياس" }, { k: "target", l: "المستهدف", half: true }, { k: "resources", l: "الموارد المطلوبة", half: true }] },
    programs: { title: "البرامج والمبادرات", desc: "البرامج الرئيسية والفرعية بأهدافها واستراتيجياتها وفترتها والمنفذات والمشاركات، مع صور الشواهد.", noun: "برنامج", view: "programs", photos: true, fields: [
      { k: "kind", l: "النوع", opts: ["برنامج", "مبادرة"], half: true }, { k: "semester", l: "الفصل الدراسي", opts: SEMS, half: true },
      { k: "main", l: "البرنامج الرئيسي", req: true, list: () => uniq(items("programs").map(i => i.data.main)) },
      { k: "sub", l: "البرنامج الفرعي / المبادرة", req: true },
      { k: "period", l: "الفترة الزمنية", ph: "مثال: الأسبوع 9 – 17", half: true }, { k: "target", l: "الفئة المستهدفة", half: true, opt: true },
      { k: "executor", l: "المسؤولة المنفذة", t: "textarea" }, { k: "participants", l: "الفئة المشاركة", opt: true },
      { k: "goals", l: "أهداف البرنامج", t: "textarea", opt: true }, { k: "strategies", l: "الاستراتيجيات وآليات التنفيذ", t: "textarea", opt: true },
      { k: "link", l: "رابط الشواهد (يظهر له رمز QR)", ph: "https://drive.google.com/…", opt: true, dir: "ltr" }] },
    values: { title: "جدول القيم", desc: "قيم برنامج «قيمنا حياة» وفترتها والمسؤولات عنها.", noun: "قيمة", fields: [
      { k: "value", l: "القيمة", req: true }, { k: "period", l: "الفترة الزمنية" }, { k: "executor", l: "المسؤولة المنفذة", t: "textarea" }] },
    timeline: { title: "الجدول الزمني", desc: "أسابيع تنفيذ البرامج في الفصلين، محسوبة من تبويب البرامج والمبادرات.", view: "timeline" },
    followup: { title: "متابعة التنفيذ", desc: "حالة تنفيذ كل برنامج في كل فصل دراسي، وملاحظاتها.", noun: "متابعة", view: "followup", fields: [
      { k: "program", l: "البرنامج", t: "program", req: true }, { k: "semester", l: "الفصل الدراسي", opts: ["الأول", "الثاني"], half: true },
      { k: "status", l: "حالة التنفيذ", opts: Object.keys(DONE), half: true, opt: true }, { k: "notes", l: "الملاحظات", t: "textarea", opt: true }] },
    accountability: { title: "المتابعة والمساءلة", desc: "لكل برنامج: الشواهد والمخرجات والصعوبات وخطة التحسين.", noun: "متابعة", fields: [
      { k: "program", l: "البرنامج", t: "program", req: true }, { k: "evidence", l: "الشواهد", t: "textarea" }, { k: "outputs", l: "المخرجات", t: "textarea" },
      { k: "difficulties", l: "الصعوبات", t: "textarea" }, { k: "improvement", l: "خطة التحسين", t: "textarea" }] },
    risks: { title: "إدارة المخاطر", desc: "المخاطر والتحديات المتوقعة وخطط الاستجابة لها.", noun: "خطر", fields: [
      { k: "risk", l: "الخطر / التحدي", req: true, t: "textarea" }, { k: "likelihood", l: "الاحتمال", opts: LEVELS, half: true }, { k: "impact", l: "الأثر", opts: LEVELS, half: true },
      { k: "response", l: "خطة الاستجابة", t: "textarea" }, { k: "owner", l: "المسؤولة" }] },
    reports: { title: "تقارير البرامج", desc: "تقرير تنفيذ لكل برنامج أو مبادرة مع صور الشواهد.", noun: "تقرير", view: "reports", photos: true, fields: [
      { k: "program", l: "البرنامج", t: "program", req: true }, { k: "executor", l: "المنفذة / الجهة المنفذة" },
      { k: "place", l: "مكان التنفيذ", half: true }, { k: "date", l: "تاريخ التنفيذ", half: true, ph: "مثال: 12 / 4 / 1448هـ" },
      { k: "title", l: "اسم البرنامج في التقرير", opt: true },
      { k: "target", l: "الفئة المستهدفة", half: true }, { k: "count", l: "عدد المستفيدات", half: true },
      { k: "duration", l: "مدة التنفيذ", half: true, opt: true },
      { k: "description", l: "وصف البرنامج", t: "textarea", opt: true },
      { k: "outcomes", l: "أهداف البرنامج", t: "textarea" },
      { k: "impact", l: "قياس الأثر ونتائجه", t: "textarea", opt: true },
      { k: "link", l: "رابط التقرير والشواهد (يظهر له رمز QR)", ph: "https://drive.google.com/…", opt: true, dir: "ltr" }] },
    evaluation: { title: "التقويم والمتابعة", desc: "مؤشرات إنجاز الخطة محسوبة من التبويبات، والتوصيات.", view: "evaluation", meta: [{ k: "notes", l: "التوصيات والملاحظات", t: "textarea" }] },
  };
  for (const [k, s] of Object.entries(SECTIONS)) s.key = k;

  const GROUPS = [
    ["البيانات العامة", ["info"]],
    ["اللجان والفرق", ["committee_plan", "committee_excellence", "committee_guidance", "teachers", "admins"]],
    ["التشخيص والتحليل", ["beneficiaries", "aspects", "swot"]],
    ["الأهداف", ["edu_goals", "strategic_goals"]],
    ["البرامج والمبادرات", ["programs", "values", "timeline"]],
    ["المتابعة والتقويم", ["followup", "accountability", "risks", "reports", "evaluation"]],
  ];
  const groupOf = key => GROUPS.find(g => g[1].includes(key))?.[0] || "";

  // ---------- State ----------
  const S = { meta: {}, items: [], files: [], role: null };
  let current = "info";
  const uniq = a => [...new Set(a.filter(Boolean))];
  const items = sec => S.items.filter(i => i.section === sec).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const filesOf = id => S.files.filter(f => f.item_id === id);
  const meta = sec => S.meta[sec] || {};
  const prog = id => S.items.find(i => i.id === Number(id) && i.section === "programs");
  const progName = id => { const p = prog(id); return p ? `${p.data.sub}${p.data.period ? " · " + p.data.period : ""}` : "برنامج محذوف"; };
  const progMain = id => prog(id)?.data.main || "";
  const fileUrl = id => `${API}/plan/files/${id}`;
  // An evidence link shows as a QR code (made by the server) and, for a Drive file, as a preview of its first page.
  const qrUrl = u => `${API}/plan/qr?u=${encodeURIComponent(u)}`;
  const isLink = u => /^https:\/\/\S+$/.test(String(u || "").trim());
  const driveFile = u => (String(u || "").match(/drive\.google\.com\/file\/d\/([\w-]{10,})/) || [])[1];
  const thumbUrl = id => `https://drive.google.com/thumbnail?id=${id}&sz=w800`;
  const evidence = (u, label) => (isLink(u) ? `<a class="evid" href="${esc(u.trim())}" target="_blank" rel="noopener">
      ${driveFile(u) ? `<img class="thumb" src="${thumbUrl(driveFile(u))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <img class="qr" src="${qrUrl(u.trim())}" alt="رمز QR"><span>${label}</span></a>` : "");

  async function api(path, opts = {}) {
    const r = await fetch(API + path, { credentials: "same-origin", ...opts, headers: { ...(opts.body && typeof opts.body === "string" ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
    if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.errors?.[0] || "تعذّر الحفظ، حاولي مرة ثانية"); e.status = r.status; throw e; }
    return j;
  }
  const json = (method, body) => ({ method, body: JSON.stringify(body) });

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2400);
  }

  // ---------- Sign in ----------
  let loginAs = "teacher";
  function showLogin(msg) {
    $("#app").hidden = true; $("#login").hidden = false; $("#loginErr").textContent = msg || "";
    $("#user").hidden = loginAs !== "teacher";
    (loginAs === "teacher" ? $("#user") : $("#pw")).focus();
  }
  $$(".seg button").forEach(b => b.addEventListener("click", () => {
    loginAs = b.dataset.as;
    $$(".seg button").forEach(x => x.setAttribute("aria-checked", x === b));
    $("#user").hidden = loginAs !== "teacher";
    (loginAs === "teacher" ? $("#user") : $("#pw")).focus();
  }));
  $("#login").addEventListener("submit", async e => {
    e.preventDefault();
    $("#loginErr").textContent = "";
    const user = $("#user").value.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).trim().toLowerCase();
    const r = await fetch(API + "/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ as: loginAs, user: loginAs === "teacher" ? user : undefined, password: $("#pw").value }) });
    if (!r.ok) {
      $("#loginErr").textContent = r.status === 429 ? "محاولات كثيرة، انتظري قليلًا" : r.status === 503 ? "هذا الحساب غير مفعّل بعد" : "بيانات الدخول غير صحيحة";
      return;
    }
    $("#pw").value = "";
    load();
  });
  $("#logoutBtn").addEventListener("click", async () => {
    await fetch(API + "/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  async function load() {
    const r = await fetch(API + "/plan", { cache: "no-store" });
    if (r.status === 401) return showLogin();
    if (r.status === 403) return showLogin("الخطة التشغيلية لإدارة المدرسة ورئيسة لجنة التخطيط");
    if (!r.ok) return showLogin("تعذّر فتح الخطة، حاولي بعد قليل");
    Object.assign(S, await r.json());
    $("#login").hidden = true; $("#app").hidden = false;
    const want = location.hash.slice(1);
    if (SECTIONS[want]) current = want;
    renderHeader(); renderSide(); render();
    if (matchMedia("(max-width: 900px)").matches) $("#side [aria-current]")?.scrollIntoView({ inline: "center", block: "nearest" });
  }

  function renderHeader() {
    const m = meta("info");
    $("#yearTag").textContent = `${m.year || "1448"}هـ`;
    $("#schoolLine").textContent = [m.school, m.principal && `المديرة: ${m.principal}`].filter(Boolean).join(" · ") || "الثانوية الثامنة والخمسون بعد المائة";
  }

  // ---------- Navigation ----------
  function countOf(key) {
    const s = SECTIONS[key];
    if (key === "timeline") return items("programs").length;
    if (key === "evaluation" || !s.fields) return "";
    return items(key).length;
  }
  // Each group of tabs is its own coloured block with an icon, so the six parts of the plan read apart at a glance.
  const GROUP_LOOK = [
    ["#0d6e6a", "#e1f2ef", '<svg viewBox="0 0 24 24"><path d="M4 21V5l8-3 8 3v16"/><path d="M9 21v-5h6v5M9 9h.01M15 9h.01M9 13h.01M15 13h.01"/></svg>'],
    ["#2563a8", "#e5eef9", '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.4.2 4 1.9 4.5 4.9"/></svg>'],
    ["#7a4bb8", "#f0e9fa", '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4M8.5 11h5M11 8.5v5"/></svg>'],
    ["#b7791f", "#fdf2dc", '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>'],
    ["#c2414b", "#fbe6e8", '<svg viewBox="0 0 24 24"><path d="M12 3c1.5 3.5 5 5 5 9.5a5 5 0 0 1-10 0c0-2 1-3.4 2-4.5.5 1.6 1.4 2.5 2.5 2.8C11 8.5 11 5.5 12 3z"/></svg>'],
    ["#0d8a5f", "#dff3ea", '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'],
  ];
  const groupIx = key => Math.max(0, GROUPS.findIndex(g => g[1].includes(key)));
  const crumbStyle = key => { const [c, soft] = GROUP_LOOK[groupIx(key)]; return `--c:${c};--cs:${soft}`; };
  const groupIcon = key => GROUP_LOOK[groupIx(key)][2];
  function renderSide() {
    $("#side").innerHTML = GROUPS.map(([g, keys], i) => {
      const [c, soft, icon] = GROUP_LOOK[i % GROUP_LOOK.length];
      const open = keys.includes(current);
      return `<section class="sg${open ? " open" : ""}" style="--c:${c};--cs:${soft}"><h3><span class="gi">${icon}</span><span class="gt">${esc(g)}</span></h3>` +
        keys.map(k => `<button type="button" data-sec="${k}" ${k === current ? 'aria-current="page"' : ""}><span class="dot"></span><span class="lbl">${esc(SECTIONS[k].title)}</span>${countOf(k) !== "" ? `<span class="n">${countOf(k)}</span>` : ""}</button>`).join("") + `</section>`;
    }).join("");
  }
  $("#side").addEventListener("click", e => {
    const b = e.target.closest("button[data-sec]");
    if (!b) return;
    current = b.dataset.sec;
    history.replaceState(null, "", "#" + current);
    renderSide(); render();
    if (matchMedia("(max-width: 900px)").matches) b.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    $("#main").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // ---------- Rendering a tab ----------
  const ICON = {
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    print: '<svg viewBox="0 0 24 24"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/></svg>',
  };
  const rowActs = (id, move = true) => `<span class="row-acts">${move ? `<button class="icon" data-act="up" data-id="${id}" aria-label="تحريك لأعلى">${ICON.up}</button><button class="icon" data-act="down" data-id="${id}" aria-label="تحريك لأسفل">${ICON.down}</button>` : ""}<button class="icon" data-act="edit" data-id="${id}" aria-label="تعديل">${ICON.edit}</button><button class="icon del" data-act="del" data-id="${id}" aria-label="حذف">${ICON.del}</button></span>`;
  const cell = (f, v) => {
    if (f.t === "program") return esc(progName(v));
    if (f.k === "status" && DONE[v]) return `<span class="pill ${DONE[v]}">${esc(v)}</span>`;
    if (f.t === "textarea") return `<div class="clip">${esc(v)}</div>`;
    return esc(v);
  };

  function head(s, { add = true } = {}) {
    return `<div class="sec-head"><div class="t"><div class="crumb" style="${crumbStyle(s.key)}">${groupIcon(s.key)}${esc(groupOf(s.key))}</div><h1>${esc(s.title)}</h1><p>${esc(s.desc)}</p></div>
      <div class="acts">${add && s.fields ? `<button class="btn primary" data-act="add">${ICON.plus}إضافة ${esc(s.noun)}</button>` : ""}
      <button class="btn" data-act="print-sec">${ICON.print}طباعة القسم</button></div></div>`;
  }

  function render() {
    const s = SECTIONS[current];
    let html = head(s);
    if (s.meta && s.key !== "evaluation") html += metaForm(s);
    const view = s.view || (s.fields ? "table" : null);
    if (view) html += VIEWS[view](s);
    if (s.key === "evaluation") html += metaForm(s);
    $("#main").innerHTML = html;
  }

  function metaForm(s) {
    const m = meta(s.key);
    if (s.key.startsWith("committee_")) {
      const tasks = String(m.tasks || "").split("\n").filter(Boolean);
      return `<section class="card box tasks"><div class="sec-head"><div class="t"><h2 style="margin:0;font-size:16px">مهام اللجنة</h2></div>
        <button class="btn small" data-act="meta-edit">${ICON.edit}تعديل المهام</button></div>
        ${tasks.length ? `<ol>${tasks.map(t => `<li>${esc(t)}</li>`).join("")}</ol>` : '<p class="muted">لا توجد مهام بعد.</p>'}</section>`;
    }
    return `<form class="card box" data-meta="${s.key}"><div class="form">${s.meta.map(f => input(f, m[f.k], f.t === "textarea" ? "full" : "")).join("")}</div>
      <div class="form-foot"><button class="btn primary">حفظ</button><span class="saved" aria-live="polite"></span></div></form>`;
  }

  function input(f, v, cls = "") {
    const id = `f_${f.k}`;
    const val = v ?? "";
    const opts = typeof f.list === "function" ? f.list() : f.list;
    let el;
    if (f.t === "textarea" || f.t === "lines") el = `<textarea id="${id}" name="${f.k}" rows="${f.t === "lines" ? 8 : 4}" ${f.req ? "required" : ""}>${esc(val)}</textarea>`;
    else if (f.t === "program") {
      const ps = items("programs");
      el = `<select id="${id}" name="${f.k}" required><option value="">اختاري البرنامج…</option>${uniq(ps.map(p => p.data.main)).map(main =>
        `<optgroup label="${esc(main)}">${ps.filter(p => p.data.main === main).map(p => `<option value="${p.id}" ${String(p.id) === String(val) ? "selected" : ""}>${esc(progName(p.id))}</option>`).join("")}</optgroup>`).join("")}</select>`;
    } else if (f.opts) el = `<select id="${id}" name="${f.k}"><option value="">—</option>${f.opts.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    else el = `<input id="${id}" name="${f.k}" type="${f.t === "number" ? "number" : "text"}" ${f.t === "number" ? 'inputmode="numeric" min="0"' : ""} value="${esc(val)}" ${f.ph ? `placeholder="${esc(f.ph)}"` : ""} ${f.dir ? `dir="${f.dir}"` : ""} ${opts ? `list="${id}_l"` : ""} ${f.req ? "required" : ""}>`
      + (opts ? `<datalist id="${id}_l">${opts.map(o => `<option value="${esc(o)}">`).join("")}</datalist>` : "");
    return `<label class="f ${cls} ${f.half ? "half" : ""}" for="${id}">${esc(f.l)}${f.req ? " *" : ""}${el}</label>`;
  }

  const VIEWS = {
    table(s) {
      const list = items(s.key);
      if (!list.length) return `<div class="card empty">ما فيه ${esc(s.noun)} مضافة بعد.</div>`;
      const cols = s.fields.filter(f => !f.hideCol);
      return `<div class="card tbl-wrap"><table class="grid"><thead><tr><th>م</th>${cols.map(f => `<th>${esc(f.l)}</th>`).join("")}<th></th></tr></thead><tbody>
        ${list.map((it, i) => `<tr><td class="num">${i + 1}</td>${cols.map(f => `<td class="${f.t === "textarea" ? "long" : ""}">${cell(f, it.data[f.k])}</td>`).join("")}<td class="acts">${rowActs(it.id)}</td></tr>`).join("")}
      </tbody></table></div>`;
    },
    grouped(s) {
      const list = items(s.key), kinds = s.fields.find(f => f.k === s.groupBy).opts;
      return kinds.map(k => {
        const rows = list.filter(i => i.data[s.groupBy] === k);
        return `<section class="card box list"><h2>${esc(k)}</h2>${rows.length ? `<ol>${rows.map(it => `<li><span>${esc(it.data.text)}</span>${rowActs(it.id)}</li>`).join("")}</ol>` : '<p class="muted" style="margin:0">لا يوجد بعد.</p>'}</section>`;
      }).join("");
    },
    swot(s) {
      const list = items("swot");
      return `<div class="swot">${SWOT.map(([type, title, sub, c]) => {
        const rows = list.filter(i => i.data.type === type);
        return `<section class="card q" style="--c:${c}"><h2>${esc(title)}<small>${esc(sub)}</small><button class="icon" data-act="add" data-preset='${esc(JSON.stringify({ type }))}' aria-label="إضافة إلى ${esc(title)}">${ICON.plus}</button></h2>
          ${rows.length ? `<ol>${rows.map(it => `<li><span>${esc(it.data.text)}</span>${rowActs(it.id)}</li>`).join("")}</ol>` : '<p class="muted" style="margin:0">لا يوجد بعد.</p>'}</section>`;
      }).join("")}</div>`;
    },
    programs(s) {
      const list = items("programs");
      if (!list.length) return '<div class="card empty">ما فيه برامج مضافة بعد.</div>';
      return uniq(list.map(p => p.data.main)).map(main => {
        const rows = list.filter(p => p.data.main === main);
        return `<section class="card prog-group"><header><h2>${esc(main)}</h2><span class="pill">${rows.length}</span>
          <button class="btn small" data-act="add" data-preset='${esc(JSON.stringify({ main }))}'>${ICON.plus}فرعي</button></header>
          <div class="prog-list">${rows.map(p => progCard(p)).join("")}</div></section>`;
      }).join("");
    },
    reports(s) {
      const list = items("reports");
      if (!list.length) return '<div class="card empty">ما فيه تقارير بعد. أضيفي تقرير لكل برنامج بعد تنفيذه.</div>';
      return `<div class="prog-list" style="padding:0">${list.map(r => {
        const d = r.data;
        return `<article class="prog card"><div class="h"><b>${esc(d.title || progName(d.program))}</b>${rowActs(r.id)}</div>
          <div class="meta"><span class="pill blue">${esc(progMain(d.program))}</span>${d.title ? `<span class="pill">${esc(progName(d.program))}</span>` : ""}${d.date ? `<span class="pill">${esc(d.date)}</span>` : ""}</div>
          <dl>${[["المنفذة", d.executor], ["المكان", d.place], ["المستهدفة", d.target], ["المستفيدات", d.count], ["المدة", d.duration], ["الوصف", d.description], ["الأهداف", d.outcomes], ["قياس الأثر", d.impact]].filter(x => x[1] !== "" && x[1] != null)
            .map(([a, b]) => `<dt>${a}</dt><dd><div class="clip">${esc(b)}</div></dd>`).join("")}</dl>${evidence(d.link, "التقرير والشواهد")}${photoStrip(r.id)}</article>`;
      }).join("")}</div>`;
    },
    timeline() {
      const list = items("programs");
      const weeks = Array.from({ length: 17 }, (_, i) => i + 1);
      const rows = list.flatMap(p => {
        const sems = p.data.semester === "الفصلان" ? [1, 2] : p.data.semester === "الثاني" ? [2] : [1];
        return sems.map(sem => ({ p, sem, w: weeksOf(p.data.period, sem, p.data.semester) }));
      });
      const table = sem => `<section class="card box"><h2>الفصل الدراسي ${sem === 1 ? "الأول" : "الثاني"}</h2><div class="tl"><table>
        <thead><tr><th class="name">البرنامج</th>${weeks.map(w => `<th>${w}</th>`).join("")}</tr></thead><tbody>
        ${rows.filter(r => r.sem === sem).map(({ p, w }) => `<tr><td class="name"><b>${esc(p.data.sub)}</b><br><small class="muted">${esc(p.data.main)} · ${esc(p.data.period || "")}</small></td>
          ${weeks.map(n => `<td class="w ${w.has(n) ? `on ${sem === 2 ? "s2" : ""}` : ""}" title="الأسبوع ${n}"></td>`).join("")}</tr>`).join("") || `<tr><td class="name muted" colspan="18">لا برامج في هذا الفصل.</td></tr>`}
        </tbody></table></div></section>`;
      return `<p class="legend"><span><i style="background:var(--accent-2)"></i>الفصل الأول</span><span><i style="background:var(--navy)"></i>الفصل الثاني</span><span>تتغير الأسابيع من حقل «الفترة الزمنية» في البرامج والمبادرات.</span></p>` + table(1) + table(2);
    },
    followup(s) {
      const list = items("followup");
      const done = list.filter(i => i.data.status === "نُفّذ").length;
      const sem = sel => list.filter(i => i.data.semester === sel);
      const stats = `<div class="stats"><div class="card stat"><b>${list.length ? Math.round(done / list.length * 100) : 0}%</b><span>نسبة التنفيذ</span></div>
        ${Object.entries(DONE).map(([k, c]) => `<div class="card stat"><b style="color:var(--${c === "ok" ? "green" : c === "mid" ? "gold" : "red"})">${list.filter(i => i.data.status === k).length}</b><span>${k}</span></div>`).join("")}
        <div class="card stat"><b style="color:var(--muted)">${list.filter(i => !i.data.status).length}</b><span>لم تُرصد بعد</span></div></div>`;
      const table = name => {
        const rows = sem(name);
        return `<section class="card"><div class="box" style="padding-bottom:4px"><h2 style="margin:0">الفصل الدراسي ${name}</h2></div><div class="tbl-wrap"><table class="grid"><thead><tr><th>م</th><th>البرنامج الرئيسي</th><th>البرنامج الفرعي</th><th>المسؤولة</th><th>حالة التنفيذ</th><th>الملاحظات</th><th></th></tr></thead><tbody>
          ${rows.map((it, i) => `<tr><td class="num">${i + 1}</td><td>${esc(progMain(it.data.program))}</td><td>${esc(progName(it.data.program))}</td><td class="long"><div class="clip">${esc(prog(it.data.program)?.data.executor)}</div></td>
            <td><select class="status" data-status="${it.id}" aria-label="حالة التنفيذ"><option value="">لم تُرصد</option>${Object.keys(DONE).map(k => `<option ${it.data.status === k ? "selected" : ""}>${k}</option>`).join("")}</select></td>
            <td class="long"><div class="clip">${esc(it.data.notes)}</div></td><td class="acts">${rowActs(it.id, false)}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">لا يوجد.</td></tr>'}
        </tbody></table></div></section>`;
      };
      return stats + table("الأول") + table("الثاني");
    },
    evaluation() {
      const f = items("followup"), done = f.filter(i => i.data.status === "نُفّذ").length;
      const progs = items("programs"), reported = new Set(items("reports").map(r => r.data.program));
      const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
      const execPct = pct(done, f.length), repPct = pct(progs.filter(p => reported.has(String(p.id))).length, progs.length);
      const overall = Math.round((execPct + repPct) / 2);
      const level = overall >= 90 ? ["متميز", "ok"] : overall >= 75 ? ["جيد جدًا", "ok"] : overall >= 60 ? ["جيد", "mid"] : ["يحتاج تحسين", "no"];
      const photos = S.files.length;
      return `<div class="stats">
        <div class="card stat"><b>${overall}%</b><span>التقييم العام <span class="pill ${level[1]}">${level[0]}</span></span></div>
        <div class="card stat"><b>${execPct}%</b><span>تنفيذ البرامج (${done} من ${f.length})</span></div>
        <div class="card stat"><b>${repPct}%</b><span>برامج لها تقرير</span></div>
        <div class="card stat"><b>${progs.length}</b><span>برنامج ومبادرة</span></div>
        <div class="card stat"><b>${items("risks").length}</b><span>خطر بخطة استجابة</span></div>
        <div class="card stat"><b>${photos}</b><span>صورة شاهد</span></div></div>
        <section class="card box"><h2>البرامج حسب الحالة</h2>${uniq(progs.map(p => p.data.main)).map(main => {
          const ids = progs.filter(p => p.data.main === main).map(p => String(p.id));
          const rows = f.filter(i => ids.includes(i.data.program)), d = rows.filter(i => i.data.status === "نُفّذ").length;
          return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line)"><span style="flex:1">${esc(main)}</span>
            <span style="flex:2;height:10px;background:var(--surface-2);border-radius:99px;overflow:hidden"><i style="display:block;height:100%;width:${pct(d, rows.length)}%;background:var(--accent-2)"></i></span>
            <b style="width:48px;text-align:left">${pct(d, rows.length)}%</b></div>`;
        }).join("")}</section>`;
    },
  };

  // "الأسبوع 9 – 17" → weeks 9..17; "الفصل الثاني" or no numbers → the whole semester.
  function weeksOf(period, sem, semester) {
    const n = String(period || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).match(/\d+/g)?.map(Number) || [];
    const all = new Set(Array.from({ length: 17 }, (_, i) => i + 1));
    if (!n.length) return all;
    const [a, b = a] = n.length > 1 ? [Math.min(n[0], n[1]), Math.max(n[0], n[1])] : [n[0]];
    return new Set(Array.from({ length: Math.max(0, Math.min(b, 17) - a + 1) }, (_, i) => a + i));
  }

  function progCard(p) {
    const d = p.data;
    const rows = [["الفترة", d.period], ["المنفذة", d.executor], ["المشاركة", d.participants], ["المستهدفة", d.target], ["الأهداف", d.goals], ["الاستراتيجيات", d.strategies]].filter(x => x[1]);
    const reps = items("reports").filter(r => r.data.program === String(p.id)).length;
    return `<article class="prog"><div class="h"><b>${esc(d.sub)}</b>${rowActs(p.id)}</div>
      <div class="meta"><span class="pill blue">${esc(d.kind || "برنامج")}</span>${d.semester ? `<span class="pill">الفصل ${esc(d.semester)}</span>` : ""}${reps ? `<span class="pill ok">${reps} تقرير</span>` : ""}</div>
      <dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd><div class="clip">${esc(b)}</div></dd>`).join("")}</dl>${evidence(d.link, "مجلد الشواهد")}${photoStrip(p.id)}</article>`;
  }
  const photoStrip = id => `<div class="photos">${filesOf(id).map(f => `<span class="photo"><img src="${fileUrl(f.id)}" alt="صورة شاهد" loading="lazy" data-view="${f.id}"><button type="button" data-act="rmphoto" data-file="${f.id}" aria-label="حذف الصورة">×</button></span>`).join("")}
    ${filesOf(id).length < 6 ? `<button type="button" class="addphoto" data-act="photo" data-id="${id}">+ شاهد</button>` : ""}</div>`;

  // ---------- Actions ----------
  $("#main").addEventListener("click", async e => {
    const img = e.target.closest("img[data-view]");
    if (img) return viewPhoto(img.src);
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    const s = SECTIONS[current];
    try {
      if (act === "add") return openItem(s, null, b.dataset.preset ? JSON.parse(b.dataset.preset) : {});
      if (act === "edit") return openItem(s, S.items.find(i => i.id === id));
      if (act === "meta-edit") return openMeta(s);
      if (act === "print-sec") return printPlan([current], true);
      if (act === "del") return confirmDelete(S.items.find(i => i.id === id));
      if (act === "up" || act === "down") {
        const r = await api(`/plan/items/${id}/move`, json("POST", { dir: act }));
        (r.order || []).forEach((iid, k) => { const it = S.items.find(i => i.id === iid); if (it) it.sort = k; });
        return render();
      }
      if (act === "photo") { photoTarget = id; return $("#fileIn").click(); }
      if (act === "rmphoto") {
        if (!(await ask("حذف هذه الصورة؟"))) return;
        await api(`/plan/files/${b.dataset.file}`, { method: "DELETE" });
        S.files = S.files.filter(f => f.id !== Number(b.dataset.file));
        render(); toast("انحذفت الصورة");
      }
    } catch (err) { if (err.message !== "unauthorized") toast(err.message); }
  });

  $("#main").addEventListener("change", async e => {
    const sel = e.target.closest("select[data-status]");
    if (!sel) return;
    const it = S.items.find(i => i.id === Number(sel.dataset.status));
    try {
      const r = await api(`/plan/items/${it.id}`, json("PUT", { data: { ...it.data, status: sel.value } }));
      Object.assign(it, r); render(); toast("انحفظت الحالة");
    } catch (err) { toast(err.message); }
  });

  $("#main").addEventListener("submit", async e => {
    const form = e.target.closest("form[data-meta]");
    if (!form) return;
    e.preventDefault();
    const sec = form.dataset.meta, data = { ...meta(sec) };
    for (const f of SECTIONS[sec].meta) data[f.k] = readField(f, form);
    try {
      const r = await api(`/plan/meta/${sec}`, json("PUT", { data }));
      S.meta[sec] = r.data;
      if (sec === "info") renderHeader();
      $(".saved", form).textContent = "انحفظ ✓";
      setTimeout(() => { const el = $(".saved", form); if (el) el.textContent = ""; }, 2500);
    } catch (err) { toast(err.message); }
  });

  function readField(f, root) {
    const el = root.querySelector(`[name="${f.k}"]`);
    if (!el) return "";
    const v = el.value.trim();
    if (f.t === "number") return v === "" ? "" : Number(v);
    return v;
  }

  // The add/edit dialog, built from the tab's fields.
  let dlgDone = null;
  function openDialog(title, bodyHtml, onSave) {
    $("#dlgTitle").textContent = title;
    $("#dlgBody").innerHTML = bodyHtml;
    $("#dlgErr").textContent = "";
    $("#dlgSave").hidden = !onSave;
    dlgDone = onSave;
    $("#dlg").showModal();
    $("#dlgBody").querySelector("input, select, textarea")?.focus();
  }
  $("#dlgForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!dlgDone) return $("#dlg").close();
    const btn = $("#dlgSave");
    btn.disabled = true;
    try {
      const msg = await dlgDone();
      if (msg) { $("#dlgErr").textContent = msg; return; }
      $("#dlg").close();
    } catch (err) { $("#dlgErr").textContent = err.message; } finally { btn.disabled = false; }
  });
  $$("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

  function openItem(s, item, preset = {}) {
    const data = item ? item.data : preset;
    openDialog(`${item ? "تعديل" : "إضافة"} ${s.noun} · ${s.title}`, s.fields.map(f => input(f, data[f.k])).join(""), async () => {
      const next = { ...(item?.data || {}) };
      for (const f of s.fields) next[f.k] = readField(f, $("#dlgBody"));
      const missing = s.fields.find(f => f.req && (next[f.k] === "" || next[f.k] == null));
      if (missing) return `«${missing.l}» مطلوب`;
      if (item) {
        const r = await api(`/plan/items/${item.id}`, json("PUT", { data: next }));
        Object.assign(item, r);
        if (s.key === "programs") await syncFollowup(item);
        toast("انحفظ التعديل");
      } else {
        const r = await api("/plan/items", json("POST", { section: s.key, data: next }));
        S.items.push(r);
        if (s.key === "programs") await syncFollowup(r);
        toast("انضاف ✓");
      }
      renderSide(); render();
    });
  }

  // A program has one follow-up row per semester it runs in: added when it gains a semester, and an unrecorded row
  // removed when it loses one (a row with a status or notes is kept).
  async function syncFollowup(p) {
    const want = p.data.semester === "الفصلان" ? ["الأول", "الثاني"] : [p.data.semester || "الأول"];
    const rows = S.items.filter(i => i.section === "followup" && i.data.program === String(p.id));
    for (const semester of want)
      if (!rows.some(i => i.data.semester === semester))
        S.items.push(await api("/plan/items", json("POST", { section: "followup", data: { program: String(p.id), semester, status: "" } })));
    for (const i of rows.filter(i => !want.includes(i.data.semester) && !i.data.status && !i.data.notes)) {
      await api(`/plan/items/${i.id}`, { method: "DELETE" });
      S.items = S.items.filter(x => x.id !== i.id);
    }
  }

  function openMeta(s) {
    const m = meta(s.key);
    openDialog(`${s.title} · المهام`, s.meta.map(f => input(f, m[f.k])).join(""), async () => {
      const data = { ...m };
      for (const f of s.meta) data[f.k] = readField(f, $("#dlgBody"));
      const r = await api(`/plan/meta/${s.key}`, json("PUT", { data }));
      S.meta[s.key] = r.data; render(); toast("انحفظت المهام");
    });
  }

  // A small yes/no dialog (no browser confirm(), so the page never freezes).
  function ask(question, yes = "نعم، احذفي") {
    return new Promise(resolve => {
      const d = document.createElement("dialog");
      d.innerHTML = `<form method="dialog"><header><h2>${esc(question)}</h2></header><footer><button class="btn primary" value="y" style="background:var(--red);border-color:var(--red)">${esc(yes)}</button><button class="btn ghost" value="n">إلغاء</button></footer></form>`;
      document.body.appendChild(d);
      d.addEventListener("close", () => { resolve(d.returnValue === "y"); d.remove(); });
      d.showModal();
    });
  }

  async function confirmDelete(item) {
    if (!item) return;
    const s = SECTIONS[item.section];
    const label = item.data.name || item.data.sub || item.data.value || item.data.category || item.data.text || item.data.risk || (item.data.program ? progName(item.data.program) : s.noun);
    const linked = item.section === "programs" ? S.items.filter(i => i.data.program === String(item.id)).length : 0;
    if (!(await ask(`حذف «${String(label).slice(0, 60)}»؟${linked ? ` ومعه ${linked} من سجلات المتابعة والتقارير المرتبطة به.` : ""}`))) return;
    const r = await api(`/plan/items/${item.id}`, { method: "DELETE" });
    const gone = new Set([item.id, ...(r.linked || [])]);
    S.items = S.items.filter(i => !gone.has(i.id));
    S.files = S.files.filter(f => !gone.has(f.item_id));
    renderSide(); render(); toast("انحذف");
  }

  // Evidence photos: shrunk in the browser to at most 1600px, JPEG.
  let photoTarget = null;
  $("#fileIn").addEventListener("change", async e => {
    const list = [...e.target.files];
    e.target.value = "";
    if (!photoTarget || !list.length) return;
    let ok = 0;
    for (const file of list) {
      if (filesOf(photoTarget).length >= 6) { toast("الحد 6 صور لكل عنصر"); break; }
      try {
        const blob = await shrink(file);
        const r = await fetch(`${API}/plan/items/${photoTarget}/files`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.errors?.[0] || "تعذّر رفع الصورة");
        S.files.push(j); ok++;
        render();
      } catch (err) { toast(err.message); }
    }
    if (ok) toast(ok > 1 ? `انرفعت ${ok} صور` : "انرفعت الصورة");
  });
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => (b ? resolve(b) : reject(new Error("تعذّر قراءة الصورة"))), "image/jpeg", 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("الملف مو صورة")); };
      img.src = url;
    });
  }
  function viewPhoto(src) {
    const d = document.createElement("dialog");
    d.className = "viewer";
    d.innerHTML = `<form method="dialog"><button style="all:unset;cursor:zoom-out"><img src="${esc(src)}" alt="صورة شاهد"></button></form>`;
    document.body.appendChild(d);
    d.addEventListener("close", () => d.remove());
    d.addEventListener("click", e => { if (e.target === d) d.close(); });
    d.showModal();
  }

  // ---------- The PDF (printed from the browser) ----------
  const ORDER = GROUPS.flatMap(g => g[1]);
  $("#pdfBtn").addEventListener("click", () => {
    $("#pdfChecks").innerHTML = GROUPS.map(([g, keys]) => keys.map(k => `<label class="check"><input type="checkbox" value="${k}" checked> ${esc(SECTIONS[k].title)}</label>`).join("")).join("");
    $("#pdfDlg").showModal();
  });
  $("#pdfAll").addEventListener("click", () => {
    const boxes = $$("#pdfChecks input"), all = boxes.every(b => b.checked);
    boxes.forEach(b => { b.checked = !all; });
  });
  $("#pdfForm").addEventListener("submit", e => {
    e.preventDefault();
    const keys = $$("#pdfChecks input:checked").map(b => b.value);
    if (!keys.length) return toast("اختاري قسمًا واحدًا على الأقل");
    $("#pdfDlg").close();
    printPlan(keys, false, $("#pdfPhotos").checked);
  });

  function printPlan(keys, single, photos = true) {
    const m = meta("info");
    const year = m.year || "1448";
    let group = "";
    const pageHead = title => `<div class="p-head"><img src="/img/moe.webp" alt=""><div>${group && !single ? `<i class="p-grp">${esc(group)}</i>` : ""}<b>${esc(title)}</b><span>${esc(m.school || "")} · الخطة التشغيلية لعام ${esc(year)}هـ</span></div><img src="/img/school.webp" alt=""></div>`;
    const tbl = (cols, rows) => `<table class="p-t"><thead><tr><th style="width:8mm">م</th>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) =>
      `<tr><td class="c">${i + 1}</td>${r.map(v => `<td>${esc(v)}</td>`).join("")}</tr>`).join("") || `<tr><td class="c" colspan="${cols.length + 1}">—</td></tr>`}</tbody></table>`;
    const signs = `<div class="p-signs"><div>رئيسة لجنة التخطيط<br><b>${esc(m.planHead || "")}</b></div><div>مديرة المدرسة<br><b>${esc(m.principal || "")}</b></div></div>`;
    const pics = id => (photos && filesOf(id).length ? `<div class="p-photos">${filesOf(id).map(f => `<img src="${fileUrl(f.id)}" alt="">`).join("")}</div>` : "");
    const pqr = (u, label) => (isLink(u) ? `<div class="p-qr"><img src="${qrUrl(u.trim())}" alt=""><span>${label}<br><small>امسحي الرمز لفتحها</small></span></div>` : "");

    const PRINT = {
      info: () => `<div class="pp">${pageHead("المقدمة والرؤية والرسالة")}
        ${m.intro ? `<h2 class="p-h2">المقدمة</h2><p class="p-text">${esc(m.intro)}</p>` : ""}
        <h2 class="p-h2">الرؤية</h2><p class="p-text">${esc(m.vision || "")}</p><h2 class="p-h2">الرسالة</h2><p class="p-text">${esc(m.mission || "")}</p>
        <h2 class="p-h2">البطاقة التعريفية</h2>${`<table class="p-t"><tbody>${[["المدرسة", m.school], ["الرمز", m.code], ["المرحلة", m.stage], ["إدارة التعليم", m.office], ["نوع المبنى", m.building],
          ["عدد الطالبات", m.students], ["عدد المعلمات", m.teachers], ["عدد الإداريات", m.admins], ["الكادر المساند", m.support], ["عدد الفصول", m.classes]]
          .map(([a, b]) => `<tr><td style="width:45mm;font-weight:700;background:#f0f6f8">${a}</td><td>${esc(b ?? "")}</td></tr>`).join("")}</tbody></table>`}</div>`,
      programs: () => `<div class="pp">${pageHead("برامج الخطة التشغيلية")}${tbl(["البرنامج الرئيسي", "البرنامج الفرعي", "الفترة الزمنية", "الفصل", "المسؤولة المنفذة"],
          items("programs").map(p => [p.data.main, p.data.sub, p.data.period, p.data.semester, p.data.executor]))}</div>`
        + (items("programs").some(p => p.data.goals || p.data.strategies || p.data.participants || p.data.link || filesOf(p.id).length)
          ? `<div class="pp">${pageHead("تفاصيل البرامج والمبادرات")}${items("programs").filter(p => p.data.goals || p.data.strategies || p.data.participants || p.data.link || filesOf(p.id).length).map(p => `<div class="p-report"><h3>${esc(p.data.main)} · ${esc(p.data.sub)}</h3><dl>
            ${[["الفترة", p.data.period], ["المسؤولة المنفذة", p.data.executor], ["الفئة المشاركة", p.data.participants], ["الفئة المستهدفة", p.data.target], ["الأهداف", p.data.goals], ["الاستراتيجيات", p.data.strategies]]
              .filter(x => x[1]).map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join("")}</dl>${pqr(p.data.link, "شواهد البرنامج")}${pics(p.id)}</div>`).join("")}</div>` : ""),
      swot: () => `<div class="pp">${pageHead("التحليل الرباعي (SWOT)")}<div class="p-swot">${SWOT.map(([type, title, , c]) =>
        `<div style="--c:${c}"><h3>${title}</h3><ol>${items("swot").filter(i => i.data.type === type).map(i => `<li>${esc(i.data.text)}</li>`).join("")}</ol></div>`).join("")}</div></div>`,
      edu_goals: () => `<div class="pp">${pageHead("أهداف التعليم")}${SECTIONS.edu_goals.fields[0].opts.map(k => {
        const rows = items("edu_goals").filter(i => i.data.kind === k);
        return rows.length ? `<h2 class="p-h2">${esc(k)}</h2><ol>${rows.map(i => `<li class="p-text">${esc(i.data.text)}</li>`).join("")}</ol>` : "";
      }).join("")}</div>`,
      timeline: () => {
        const progs = items("programs");
        const bar = (p, sem) => { const w = weeksOf(p.data.period, sem, p.data.semester); return Array.from({ length: 17 }, (_, i) => `<td style="padding:0;${w.has(i + 1) ? `background:${sem === 1 ? "#bfe6e2" : "#cdd8e8"}` : ""}">${w.has(i + 1) ? `<i style="display:block;margin:1.2mm;height:3.2mm;border-radius:0.8mm;background:${sem === 1 ? "#12a39a" : "#1f3a5f"};opacity:.55"></i>` : ""}</td>`).join(""); };
        const t = sem => `<h2 class="p-h2">الفصل الدراسي ${sem === 1 ? "الأول" : "الثاني"}</h2><table class="p-t" style="font-size:8.5pt"><thead><tr><th>البرنامج</th>${Array.from({ length: 17 }, (_, i) => `<th style="padding:1mm;width:6mm">${i + 1}</th>`).join("")}</tr></thead><tbody>
          ${progs.filter(p => p.data.semester === "الفصلان" || (sem === 1 ? p.data.semester !== "الثاني" : p.data.semester === "الثاني")).map(p => `<tr><td>${esc(p.data.sub)}<br><small>${esc(p.data.period || "")}</small></td>${bar(p, sem)}</tr>`).join("")}</tbody></table>`;
        return `<div class="pp">${pageHead("الجدول الزمني لتنفيذ البرامج")}${t(1)}</div><div class="pp">${pageHead("الجدول الزمني لتنفيذ البرامج")}${t(2)}</div>`;
      },
      followup: () => ["الأول", "الثاني"].map(sem => `<div class="pp">${pageHead(`متابعة تنفيذ برامج الخطة التشغيلية · الفصل الدراسي ${sem}`)}
        <table class="p-t"><thead><tr><th style="width:8mm">م</th><th>البرنامج الرئيسي</th><th>البرنامج الفرعي</th><th>مسؤولة التنفيذ</th><th style="width:12mm">نُفّذ</th><th style="width:14mm">لم يُنفّذ</th><th>الملاحظات</th></tr></thead><tbody>
        ${items("followup").filter(i => i.data.semester === sem).map((i, n) => `<tr><td class="c">${n + 1}</td><td>${esc(progMain(i.data.program))}</td><td>${esc(prog(i.data.program)?.data.sub || "")}</td><td>${esc(prog(i.data.program)?.data.executor || "")}</td>
          <td class="c">${i.data.status === "نُفّذ" ? "✓" : ""}</td><td class="c">${i.data.status === "لم يُنفّذ" ? "✓" : i.data.status === "جارٍ التنفيذ" ? "جارٍ" : ""}</td><td>${esc(i.data.notes || "")}</td></tr>`).join("")}</tbody></table></div>`).join(""),
      reports: () => `<div class="pp">${pageHead("تقارير البرامج والمبادرات")}${items("reports").map(r => `<div class="p-report"><h3>${esc(progMain(r.data.program))} · ${esc(r.data.title || progName(r.data.program))}</h3><dl>
        ${[["البرنامج الفرعي", r.data.title ? progName(r.data.program) : ""], ["المنفذة", r.data.executor], ["مكان التنفيذ", r.data.place], ["تاريخ التنفيذ", r.data.date], ["مدة التنفيذ", r.data.duration], ["الفئة المستهدفة", r.data.target], ["عدد المستفيدات", r.data.count],
          ["وصف البرنامج", r.data.description], ["الأهداف", r.data.outcomes], ["قياس الأثر", r.data.impact]]
          .filter(x => x[1] !== "" && x[1] != null).map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join("")}</dl>${pqr(r.data.link, "التقرير والشواهد")}${pics(r.id)}</div>`).join("") || "<p>لا توجد تقارير بعد.</p>"}</div>`,
      evaluation: () => {
        const f = items("followup"), done = f.filter(i => i.data.status === "نُفّذ").length;
        return `<div class="pp">${pageHead("التقويم والمتابعة")}<div class="p-stats"><div><b>${f.length ? Math.round(done / f.length * 100) : 0}%</b>نسبة تنفيذ البرامج</div>
          <div><b>${items("programs").length}</b>برنامج ومبادرة</div><div><b>${items("reports").length}</b>تقرير منجز</div></div>
          ${meta("evaluation").notes ? `<h2 class="p-h2">التوصيات والملاحظات</h2><p class="p-text">${esc(meta("evaluation").notes)}</p>` : ""}${signs}</div>`;
      },
    };
    // Every other tab prints as a table of its fields (and a committee with its tasks).
    const generic = k => {
      const s = SECTIONS[k], cols = s.fields.filter(f => !f.hideCol);
      const tasks = String(meta(k).tasks || "").split("\n").filter(Boolean);
      return `<div class="pp">${pageHead(s.title)}${tbl(cols.map(f => f.l), items(k).map(it => cols.map(f => f.t === "program" ? progName(it.data[f.k]) : it.data[f.k] ?? "")))}
        ${tasks.length ? `<h2 class="p-h2">مهام اللجنة</h2><ol>${tasks.map(t => `<li class="p-text" style="margin:0">${esc(t)}</li>`).join("")}</ol>` : ""}</div>`;
    };
    const chosen = ORDER.filter(k => keys.includes(k));
    const cover = `<div class="pp p-cover"><div class="band"></div><div class="lg"><img src="/img/moe.webp" alt=""><img src="/img/school.webp" alt=""></div>
      <h2>${esc(m.office || "الإدارة العامة للتعليم بمنطقة الرياض")}</h2><h1>${single ? esc(SECTIONS[keys[0]].title) : "الخطة التشغيلية"}<br>لعام ${esc(year)}هـ</h1><h2>${esc(m.school || "")}</h2>
      <div class="who">مديرة المدرسة: <b>${esc(m.principal || "")}</b><br>رئيسة لجنة التخطيط: <b>${esc(m.planHead || "")}</b></div></div>`;
    const toc = single ? "" : `<div class="pp">${pageHead("الفهرس")}<table class="p-toc"><tbody>${GROUPS.map(([g, ks]) => {
      const mine = ks.filter(k => chosen.includes(k));
      return mine.length ? `<tr><td class="g">${esc(g)}</td></tr>${mine.map(k => `<tr><td>${esc(SECTIONS[k].title)}</td></tr>`).join("")}` : "";
    }).join("")}</tbody></table></div>`;
    let body = "";
    for (const g of GROUPS) {
      const mine = g[1].filter(k => chosen.includes(k));
      if (!mine.length) continue;
      group = g[0];
      body += mine.map(k => (PRINT[k] || generic)(k)).join("");
    }
    $("#print").innerHTML = cover + toc + body;
    const imgs = $$("#print img");
    Promise.all(imgs.map(i => (i.complete ? 0 : new Promise(ok => { i.onload = i.onerror = ok; })))).then(() => document.fonts.ready).then(() => {
      const title = document.title;
      document.title = single ? `${SECTIONS[keys[0]].title} - الخطة التشغيلية ${year}` : `الخطة التشغيلية ${year} - ${m.school || ""}`;
      window.print();
      setTimeout(() => { document.title = title; }, 500);
    });
  }

  load();
})();
