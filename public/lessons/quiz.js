// Saves a lesson's quiz score for the student's teacher. Before the quiz the student types her national ID (or picks
// practice without saving); the quiz stays hidden until she does, so the first attempt the teacher reads is a real one.
// Each lesson calls LessonQuiz.gate(key, quizElement, restart) once and LessonQuiz.done(right) when a quiz ends.
// Styles follow the lesson's own text colour, so the box sits on light pages and on the dark observatory alike.
const LessonQuiz = (() => {
  const KEY = "lessonStudent";
  const toLatin = s => String(s ?? "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; } },
    set(v) { try { v ? sessionStorage.setItem(KEY, JSON.stringify(v)) : sessionStorage.removeItem(KEY); } catch {} },
  };
  let lesson = null, box = null, target = null, restart = null, mode = null, who = null;

  const css = `
.lq { border: 1.5px dashed color-mix(in srgb, currentColor 35%, transparent); border-radius: 16px; padding: 16px 18px; margin: 0 0 14px;
  background: color-mix(in srgb, currentColor 5%, transparent); font-family: inherit; line-height: 1.7; }
.lq h3 { margin: 0 0 4px; font-size: 17px; }
.lq p { margin: 0 0 10px; opacity: .85; font-size: 14.5px; }
.lq form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.lq input { font: inherit; font-size: 17px; letter-spacing: 1px; direction: ltr; text-align: center; width: 13ch; max-width: 100%; padding: 8px 12px;
  border-radius: 10px; border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent); background: color-mix(in srgb, currentColor 4%, Canvas); color: inherit; }
.lq input:focus { outline: 2px solid color-mix(in srgb, currentColor 55%, transparent); outline-offset: 1px; }
.lq button { font: inherit; font-weight: 700; cursor: pointer; border-radius: 10px; padding: 8px 18px; border: 0; background: #0f766e; color: #fff; }
.lq button.lq-link { background: none; color: inherit; text-decoration: underline; font-weight: 500; padding: 8px 6px; opacity: .8; }
.lq button:disabled { opacity: .6; cursor: default; }
.lq .lq-err { color: #c2410c; font-size: 14px; margin: 8px 0 0; }
.lq .lq-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: space-between; }
.lq .lq-badge { display: inline-block; font-weight: 700; padding: 2px 10px; border-radius: 99px; background: color-mix(in srgb, #0f766e 18%, transparent); }
.lq.on { border-style: solid; }
.lq-toast { position: fixed; z-index: 50; bottom: max(18px, env(safe-area-inset-bottom)); inset-inline: 16px; margin: 0 auto; max-width: 420px; padding: 12px 16px;
  border-radius: 14px; background: #0f3d3a; color: #fff; font-family: inherit; font-size: 15px; line-height: 1.6; text-align: center;
  box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .5); transition: opacity .3s, transform .3s; }
.lq-toast.err { background: #9a3412; }
.lq-toast.off { opacity: 0; transform: translateY(10px); pointer-events: none; }`;

  function api(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || "error"), { status: r.status }); return d; });
  }

  const saved = () => who?.results?.[lesson.key];
  // The quiz ends far below the box, so its outcome also shows for a moment at the bottom of the screen.
  function toast(html, err) {
    document.querySelector(".lq-toast")?.remove();
    const t = document.createElement("div"); t.className = "lq-toast off" + (err ? " err" : ""); t.setAttribute("role", "status"); t.innerHTML = html;
    document.body.appendChild(t); requestAnimationFrame(() => t.classList.remove("off"));
    setTimeout(() => { t.classList.add("off"); setTimeout(() => t.remove(), 400); }, 5000);
  }
  const savedText = r => `${r.score} من ${r.total}`;

  function show(open, fresh = true) {
    target.hidden = !open;
    if (open && fresh && restart) restart();
  }

  function drawAsk(err) {
    mode = null; box.classList.remove("on");
    box.innerHTML = `<h3>📝 سجّلي درجتك عند معلمتك</h3>
      <p>اكتبي رقم هويتك قبل ما تبدئين، وتنحفظ درجة <b>أول محاولة</b> عند معلمتك. بعدها تقدرين تعيدين الاختبار للتدريب.</p>
      <form novalidate><input inputmode="numeric" autocomplete="off" maxlength="10" placeholder="رقم الهوية" aria-label="رقم الهوية">
        <button type="submit">ابدئي الاختبار</button><button type="button" class="lq-link" data-practice>تدرّبي بدون تسجيل</button></form>
      ${err ? `<p class="lq-err" role="alert">${esc(err)}</p>` : ""}`;
    const form = box.querySelector("form"), input = form.querySelector("input");
    input.addEventListener("input", () => { input.value = toLatin(input.value).replace(/\D/g, "").slice(0, 10); });
    form.onsubmit = async e => {
      e.preventDefault();
      const id = toLatin(input.value).replace(/\D/g, "");
      if (id.length < 9) return drawAsk("رقم الهوية لازم يكون ١٠ أرقام.");
      const btn = form.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "لحظة…";
      try {
        const d = await api("/api/lessons/student", { id });
        who = { id, name: d.name, results: d.results || {} }; store.set(who);
        drawReady();
      } catch (x) {
        drawAsk(x.status === 404 ? "ما لقينا هذا الرقم بين الطالبات. تأكدي منه أو اسألي معلمتك." : x.status === 429 ? "محاولات كثيرة، انتظري شوي وجربي." : "تعذّر الاتصال. تأكدي من الإنترنت وجربي مرة ثانية.");
      }
    };
    form.querySelector("[data-practice]").onclick = () => { mode = "practice"; drawPractice(); };
    show(false);
  }

  function drawReady(fresh = true) {
    mode = "save"; box.classList.add("on");
    const r = saved();
    box.innerHTML = `<div class="lq-row"><div><h3>أهلًا يا ${esc(who.name)} 👋</h3>
      <p>${r ? `درجتك المحفوظة في هذا الدرس <span class="lq-badge">${savedText(r)}</span>. أي محاولة جديدة للتدريب وما تغيّر درجتك.` : "حلّي الاختبار تحت، ودرجتك تنحفظ عند معلمتك أول ما تخلصين."}</p></div>
      <button type="button" class="lq-link" data-out>مو أنا؟</button></div>`;
    box.querySelector("[data-out]").onclick = () => { who = null; store.set(null); drawAsk(); };
    show(true, fresh);
  }

  function drawPractice() {
    box.classList.add("on");
    box.innerHTML = `<div class="lq-row"><p style="margin:0">وضع التدريب: درجتك ما تنحفظ.</p><button type="button" class="lq-link" data-back>أبغى أسجّل درجتي</button></div>`;
    box.querySelector("[data-back]").onclick = () => drawAsk();
    show(true);
  }

  function gate(key, el, onRestart) {
    lesson = { key }; target = el; restart = onRestart || null;
    if (!document.getElementById("lq-css")) document.head.insertAdjacentHTML("beforeend", `<style id="lq-css">${css}</style>`);
    box = document.createElement("div"); box.className = "lq"; box.setAttribute("aria-live", "polite");
    el.parentNode.insertBefore(box, el);
    who = store.get();
    if (!who) return drawAsk();
    // Her scores may have changed in another tab: read them again before the quiz opens.
    drawReady();
    api("/api/lessons/student", { id: who.id }).then(d => { who.results = d.results || {}; store.set(who); if (mode === "save") drawReady(false); })
      .catch(x => { if (x.status === 404) { who = null; store.set(null); drawAsk(); } });
  }

  // Called by the lesson when a quiz ends. In practice mode nothing leaves the page.
  async function done(right) {
    if (mode !== "save" || !who) return;
    const had = saved();
    try {
      const d = await api(`/api/lessons/${lesson.key}/result`, { id: who.id, score: right });
      who.results[lesson.key] = { score: d.score, total: d.total, best: d.best, attempts: d.attempts }; store.set(who);
      box.innerHTML = `<div class="lq-row"><div><h3>${d.first ? "✅ انحفظت درجتك" : "محاولة تدريب"}</h3>
        <p>${d.first ? `درجتك <span class="lq-badge">${savedText(d)}</span> وصلت لمعلمتك. تقدرين تعيدين الاختبار للتدريب.`
          : `درجتك المحفوظة تبقى <span class="lq-badge">${savedText(had || d)}</span>، وهذي المحاولة ${right} من ${d.total}.`}</p></div>
        <button type="button" class="lq-link" data-out>مو أنا؟</button></div>`;
      box.querySelector("[data-out]").onclick = () => { who = null; store.set(null); drawAsk(); };
      toast(d.first ? `✅ انحفظت درجتك عند معلمتك: ${savedText(d)}` : `محاولة تدريب. درجتك المحفوظة تبقى ${savedText(had || d)}`);
    } catch {
      box.insertAdjacentHTML("beforeend", `<p class="lq-err" role="alert">ما قدرنا نحفظ الدرجة. تأكدي من الإنترنت وأعيدي الاختبار.</p>`);
      toast("ما قدرنا نحفظ الدرجة. تأكدي من الإنترنت وأعيدي الاختبار.", true);
    }
  }

  return { gate, done };
})();
