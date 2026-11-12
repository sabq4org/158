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
);
-- The teacher publishes the results: until then a student who handed in sees that it arrived, not her mark.
ALTER TABLE exam_state ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false;`;

// Text marks the page renders: {p:2,1} a point, {f:-2/3} a fraction (or {f:2x²/3}), {e:y = 3x + 1} an equation, {d:90} degrees.
const FAIZA = 1;
// The true/false and matching questions are the same in both models of the chapter-2 exam.
const [TF, MATCH] = [
    { key: "t", type: "tf", title: "السؤال الثاني: صح وخطأ", marks: 5, hint: "اختاري «صح» للعبارة الصحيحة و«خطأ» للعبارة الخاطئة (لكل فقرة نصف درجة).", items: [
      ["المستقيمان المتخالفان يقعان في مستوى واحد.", false],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن الزاويتين المتناظرتين متطابقتان.", true],
      ["الزاويتان المتحالفتان متكاملتان عندما يكون المستقيمان متوازيين.", true],
      ["ميل المستقيم الأفقي يساوي 1.", false],
      ["المستقيمان اللذان ميلاهما 2 و {f:-1/2} متعامدان.", true],
      ["ميل المستقيم المار بالنقطتين {p:1,3} و {p:5,3} يساوي صفرًا.", true],
      ["المستقيمان {e:y = 3x + 1} و {e:y = 3x − 4} يتقاطعان في نقطة واحدة.", false],
      ["المسافة بين نقطة ومستقيم هي طول القطعة العمودية من النقطة إلى المستقيم.", true],
      ["ميل المستقيم {e:y = 4x − 7} يساوي {e:−7}.", false],
      ["الزاويتان المتبادلتان خارجيًا متكاملتان دائمًا عندما يتوازى المستقيمان.", false],
    ] },
    { key: "p", type: "match", title: "السؤال الثالث: المزاوجة", marks: 5, hint: "اختاري لكل عبارة الرمز المناسب من العمود الثاني. انتبهي: فيه رمز زائد (لكل فقرة نصف درجة).",
      choices: [
        ["أ", "2"],
        ["ب", "زاويتان داخليتان على جهة واحدة من القاطع، مجموعهما {d:180} عند توازي المستقيمين"],
        ["ج", "{e:y − y₁ = m(x − x₁)}"],
        ["د", "مستقيمان لا يتقاطعان ولا يقعان في مستوى واحد"],
        ["هـ", "{f:-3/2}"],
        ["و", "طول القطعة المستقيمة العمودية من النقطة إلى المستقيم"],
        ["ز", "مستقيم يقطع مستقيمين أو أكثر في نقاط مختلفة"],
        ["ح", "مستقيمان لا يتقاطعان أبدًا ويقعان في المستوى نفسه"],
        ["ط", "{e:y = mx + b}"],
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
      ] }
];
// Chapter 3 of رياضيات 2 (الثاني الثانوي): «كثيرات الحدود ودوالها», from the teacher's paper (2026-11-12): 40 items, a mark each.
// theme picks the page's look: "curve" (a polynomial curve over a grid), "sadu" (a Sadu band of triangles).
const POLY = {
  key: "polynomials",
  title: "اختبار الفصل الثالث: كثيرات الحدود ودوالها",
  subject: "الرياضيات 2", book: "رياضيات 2", grade: 2, semester: "الفصل الدراسي الأول", theme: "curve",
  minutes: 60, total: 40, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختيار من متعدد", marks: 20, hint: "اختاري الإجابة الصحيحة لكل فقرة (لكل فقرة درجة).", items: [
      ["قيمة {e:√−27} تساوي:", ["{e:9i√3}", "{e:3i√3}", "{e:−3√3}", "{e:3√3}"], 1],
      ["قيمة {e:i³¹} تساوي:", ["{e:i}", "{e:−1}", "{e:−i}", "1"], 2],
      ["ناتج {e:(3 + 2i) + (5 − 6i)} هو:", ["{e:8 + 4i}", "{e:−2 + 8i}", "{e:2 − 4i}", "{e:8 − 4i}"], 3],
      ["ناتج {e:(2 + 3i)(1 − i)} هو:", ["{e:5 + i}", "{e:−1 + i}", "{e:5 − i}", "{e:−1 + 5i}"], 0],
      ["ناتج {e:√−6 · √−15} يساوي:", ["{e:3√10}", "{e:−3√10}", "{e:3i√10}", "{e:−3i√10}"], 1],
      ["المرافق المركب للعدد {e:4 − 7i} هو:", ["{e:−4 + 7i}", "{e:−4 − 7i}", "{e:4 + 7i}", "{e:7 − 4i}"], 2],
      ["حل المعادلة {e:x² + 4 = 0} هو:", ["{e:x = ±2}", "{e:x = ±4}", "{e:x = ±4i}", "{e:x = ±2i}"], 3],
      ["قيمة المميز للمعادلة {e:x² + 6x + 13 = 0} تساوي:", ["{e:−16}", "16", "88", "{e:−88}"], 0],
      ["عدد جذور المعادلة {e:x² − 6x + 9 = 0} ونوعها:", ["جذران مركبان غير حقيقيين", "جذران حقيقيان مختلفان", "جذر حقيقي واحد (مكرر مرتين)", "أربعة جذور حقيقية"], 2],
      ["حلّا المعادلة {e:x² − 4x − 5 = 0} باستعمال القانون العام هما:", ["{e:5} ، {e:1}", "{e:5} ، {e:−1}", "{e:−5} ، {e:−1}", "{e:−5} ، {e:1}"], 1],
      ["أبسط صورة للعبارة {e:(2x³y)(−3x⁻¹y²)} هي:", ["{e:−6x²y³}", "{e:6x²y³}", "{e:−6x⁴y³}", "{e:−5x²y³}"], 0],
      ["عند قسمة {e:P(x)} على {e:x + 3} بالقسمة التركيبية، فإن العدد {e:r} الذي يوضع في صندوق القسمة هو:", ["3", "{e:−3}", "{f:1/3}", "0"], 1],
      ["درجة كثيرة الحدود {e:3x⁴ + 6x³ − 4x⁸ + 2x} ومعاملها الرئيس على الترتيب:", ["{e:4} ، {e:3}", "{e:8} ، {e:4}", "{e:8} ، {e:−4}", "{e:4} ، {e:−4}"], 2],
      ["أيٌّ مما يأتي ليس كثيرة حدود بمتغير واحد؟", ["{e:5x² − 6x − 9}", "12", "{e:4x − 9}", "{e:12x² − 3xy + 8x}"], 3],
      ["إذا كانت {e:f(x) = x² + 2x − 3}، فإن {e:f(3)} تساوي:", ["12", "6", "15", "9"], 0],
      ["ناتج قسمة {e:(x² + 3x − 40) ÷ (x − 5)} هو:", ["{e:x − 8}", "{e:x + 5}", "{e:x + 8}", "{e:x − 5}"], 2],
      ["باقي قسمة {e:f(x) = x³ − 2x² + x − 5} على {e:x − 2} يساوي:", ["3", "{e:−3}", "5", "{e:−5}"], 1],
      ["تحليل كثيرة الحدود {e:27x³ + y³} هو:", ["{e:(3x + y)(9x² + 3xy + y²)}", "{e:(3x − y)(9x² + 3xy + y²)}", "{e:(3x + y)(3x² − 3xy + y²)}", "{e:(3x + y)(9x² − 3xy + y²)}"], 3],
      ["أحد عوامل كثيرة الحدود {e:f(x) = x³ − 3x² + 4} هو:", ["{e:x − 2}", "{e:x + 2}", "{e:x − 4}", "{e:x − 1}"], 0],
      ["عدد جذور المعادلة {e:4x⁴ − 3x³ + 5x − 6 = 0} في مجموعة الأعداد المركبة (بما فيها المكررة) هو:", ["3", "4", "6", "5"], 1],
    ] },
    { key: "t", type: "tf", title: "السؤال الثاني: صح أم خطأ", marks: 10, hint: "اختاري «صح» للعبارة الصحيحة و«خطأ» للعبارة الخاطئة (لكل فقرة درجة).", items: [
      ["العدد {e:3i} عدد تخيلي بحت.", true],
      ["قيمة {e:i²} تساوي 1.", false],
      ["كل عدد حقيقي هو عدد مركب.", true],
      ["إذا كان مميز معادلة تربيعية سالبًا فإن لها جذرين حقيقيين مختلفين.", false],
      ["درجة كثيرة الحدود {e:5x³ − 2x⁷ + x} هي 3.", false],
      ["{e:(x³)² = x⁶}", true],
      ["إذا قُسمت كثيرة الحدود {e:P(x)} على {e:x − r} فإن الباقي يساوي {e:P(r)}.", true],
      ["إذا كان {e:P(3) = 0} فإن {e:x + 3} عامل من عوامل {e:P(x)}.", false],
      ["لمعادلة كثيرة حدود من الدرجة السادسة ست جذور مركبة، بما فيها الجذور المكررة.", true],
      ["الأصفار الحقيقية لدالة كثيرة حدود هي الإحداثيات {e:y} لنقاط تقاطع تمثيلها البياني مع المحور {e:y}.", false],
    ] },
    { key: "p", type: "match", title: "السؤال الثالث: المزاوجة", marks: 10, hint: "اختاري لكل فقرة الرمز المناسب من العمود الثاني. انتبهي: فيه رمز زائد ما يُستعمل (لكل فقرة درجة).",
      choices: [
        ["أ", "{e:x + 3}"], ["ب", "4"], ["ج", "{e:−1}"], ["د", "{e:±5i}"], ["هـ", "0"], ["و", "{e:x − 3}"],
        ["ز", "{e:2 − 5i}"], ["ح", "42"], ["ط", "1"], ["ي", "{e:x⁵}"], ["ك", "5"],
      ],
      items: [
        ["قيمة {e:i²}", "ج"],
        ["قيمة {e:i⁴}", "ط"],
        ["المرافق المركب للعدد {e:2 + 5i}", "ز"],
        ["ناتج {e:(3 + i) + (2 − i)}", "ك"],
        ["قيمة المميز للمعادلة {e:x² − 4x + 4 = 0}", "هـ"],
        ["ناتج {e:x⁷ ÷ x²}", "ي"],
        ["درجة كثيرة الحدود {e:x⁴ − 3x² + 1}", "ب"],
        ["باقي قسمة {e:x² + 6x + 2} على {e:x − 4}", "ح"],
        ["ناتج {e:(x² − 9) ÷ (x − 3)}", "أ"],
        ["حل المعادلة {e:x² + 25 = 0}", "د"],
      ] },
  ],
};
// Its model for صعوبات التعلم, from the teacher's own paper: two choices an item, 20 items, a mark each.
const POLY_LD = {
  key: "polynomials-2", parent: "polynomials", ld: true, model: "نموذج صعوبات التعلم (بخيارين)",
  title: POLY.title, subject: POLY.subject, book: POLY.book, grade: 2, semester: POLY.semester, theme: "curve",
  minutes: 45, total: 20, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختاري الإجابة الصحيحة", marks: 10, hint: "اختاري الإجابة الصحيحة من الخيارين (لكل فقرة درجة).", items: [
      ["قيمة {e:i⁴³} تساوي:", ["{e:−i}", "{e:i}"], 0],
      ["ناتج {e:(2x + 3)(x − 1)} يساوي:", ["{e:2x² + x − 3}", "{e:2x² − x − 3}"], 0],
      ["ناتج {e:(2 + 3i)(1 − 2i)} في أبسط صورة:", ["{e:8 − i}", "{e:8 − 7i}"], 0],
      ["ناتج قسمة {e:(x² + 7x − 30) ÷ (x − 3)} هو:", ["{e:x − 10}", "{e:x + 10}"], 1],
      ["باقي قسمة {e:x³ − 2x² + x − 1} على {e:x − 3} يساوي:", ["9", "11"], 1],
      ["قيمة {e:√−36} تساوي:", ["{e:6i}", "{e:−6}"], 0],
      ["معادلة محور التماثل للقطع المكافئ {e:y = x² − 2x + 5} هي:", ["{e:x = 1}", "{e:x = −1}"], 0],
      ["أيٌّ مما يلي عامل من عوامل كثيرة الحدود {e:x² − 5x + 6}؟", ["{e:x − 4}", "{e:x − 2}"], 1],
      ["المقدار {f:(2x²)³/12x⁴} يساوي:", ["{f:2x²/3}", "{f:x²/4}"], 0],
      ["القيمة المطلقة للعدد المركب {e:z = 3 + 4i} تساوي:", ["7", "5"], 1],
    ] },
    { key: "t", type: "tf", title: "السؤال الثاني: صح أم خطأ", marks: 10, hint: "اختاري «صح» للعبارة الصحيحة و«خطأ» للعبارة الخاطئة (لكل فقرة درجة).", items: [
      ["قيمة {e:i¹⁶} تساوي 1.", true],
      ["{e:(x + 1)² = x² + 1}", false],
      ["{e:√−9 = −3}", false],
      ["باقي قسمة كثيرة الحدود {e:f(x)} على {e:(x − a)} يساوي {e:f(a)}.", true],
      ["كثيرة الحدود من الدرجة الثالثة لها ثلاثة أصفار حقيقية على الأكثر.", true],
      ["ناتج {e:(3 + 2i)(3 − 2i)} يساوي 13.", true],
      ["{e:(x − 1)} عامل من عوامل كثيرة الحدود {e:x² + x + 1}.", false],
      ["طرفا التمثيل البياني لدالة كثيرة حدود من الدرجة الفردية يتجهان في الاتجاه نفسه.", false],
      ["{e:x² · x³ = x⁶}", false],
      ["{e:(a²b)³ = a⁶b³}", true],
    ] },
  ],
};

// Chapter 3 of رياضيات 1-2 (الأول الثانوي): «المثلثات المتطابقة», from the teacher's paper (2026-11-12): 40 items, half a mark each.
// fig is a drawing the page makes beside the question (never the answer): see figure() in public/exams/exam.html.
const TRI = {
  key: "congruent-triangles",
  title: "اختبار الفصل الثالث: المثلثات المتطابقة",
  subject: "الرياضيات 1-2", book: "رياضيات 1-2", grade: 1, semester: "الفصل الدراسي الأول", theme: "sadu",
  minutes: 50, total: 20, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختيار من متعدد", marks: 10, hint: "اختاري الإجابة الصحيحة لكل فقرة (لكل فقرة نصف درجة).", items: [
      ["مثلث قياسات زواياه {d:30} ، {d:110} ، {d:40}، يُصنَّف بحسب زواياه إلى مثلث:", ["حاد الزوايا", "قائم الزاوية", "منفرج الزاوية", "متطابق الزوايا"], 2],
      ["مثلث قياس كل زاوية فيه {d:60}، يُسمّى مثلثًا:", ["منفرج الزاوية", "متطابق الزوايا", "قائم الزاوية", "مختلف الأضلاع"], 1],
      ["المثلث الذي فيه ضلعان متطابقان على الأقل يُسمّى مثلثًا:", ["مختلف الأضلاع", "قائم الزاوية", "منفرج الزاوية", "متطابق الضلعين"], 3],
      ["مثلث أطوال أضلاعه {e:5 cm} ، {e:7 cm} ، {e:9 cm}، يُصنَّف بحسب أضلاعه إلى مثلث:", ["مختلف الأضلاع", "متطابق الأضلاع", "متطابق الضلعين", "متطابق الزوايا"], 0],
      ["في {e:△ABC}، إذا كان {e:m∠A = 48°} و {e:m∠B = 67°}، فإن {e:m∠C} يساوي:", ["{d:55}", "{d:65}", "{d:75}", "{d:115}"], 1,
        { fig: { t: "tri", A: 48, B: 67, labels: ["48°", "67°", "?"] } }],
      ["قياس الزاوية الخارجية في المثلث يساوي مجموع قياسي:", ["الزاوية الداخلية المجاورة لها فقط", "زوايا المثلث الثلاث", "زاويتين خارجيتين", "الزاويتين الداخليتين البعيدتين"], 3],
      ["زاوية خارجية لمثلث قياسها {d:120}، وقياس إحدى الزاويتين الداخليتين البعيدتين {d:45}، فإن قياس الزاوية الداخلية البعيدة الأخرى هو:", ["{d:55}", "{d:65}", "{d:75}", "{d:135}"], 2,
        { fig: { t: "ext", A: 45, B: 75, labels: ["45°", "?", "120°"] } }],
      ["مثلث متطابق الضلعين قياس زاوية رأسه {d:40}، فإن قياس كل زاوية من زاويتي القاعدة هو:", ["{d:70}", "{d:40}", "{d:60}", "{d:140}"], 0,
        { fig: { t: "iso", apex: 40, label: "40°" } }],
      ["إذا كان {e:△ABC ≅ △XYZ}، فإن الضلع المناظر للضلع {e:AB} هو:", ["{e:YZ}", "{e:XY}", "{e:ZX}", "لا يوجد ضلع مناظر"], 1],
      ["إذا كان {e:△ABC ≅ △DEF}، فإن الزاوية المناظرة للزاوية {e:∠B} هي:", ["{e:∠D}", "{e:∠F}", "{e:∠A}", "{e:∠E}"], 3],
      ["أيٌّ مما يأتي لا يُستعمل لإثبات تطابق مثلثين؟", ["{e:SSS}", "{e:SAS}", "{e:AAA}", "{e:ASA}"], 2],
      ["في مسلّمة {e:SAS} تكون الزاوية المستعملة في الإثبات هي الزاوية:", ["المحصورة بين الضلعين", "المقابلة لأحد الضلعين", "الخارجية", "أي زاوية في المثلث"], 0],
      ["في مثلثين: {e:AB ≅ DE} ، {e:∠A ≅ ∠D} ، {e:AC ≅ DF}، فإن المسلّمة التي تثبت تطابق المثلثين هي:", ["{e:SSS}", "{e:SAS}", "{e:ASA}", "{e:AAS}"], 1,
        { fig: { t: "pair", sides: { AB: 1, AC: 2 }, angles: { A: 1 } } }],
      ["إذا طابقت زاويتان وضلع غير محصور بينهما في مثلث نظائرها في مثلث آخر، فإن المثلثين متطابقان بحسب:", ["{e:SAS}", "{e:ASA}", "{e:SSS}", "{e:AAS}"], 3],
      ["في {e:△ABC} و {e:△DEF}: {e:∠A ≅ ∠D} ، {e:∠B ≅ ∠E} ، {e:AB ≅ DE}، فإن المثلثين متطابقان بحسب:", ["{e:SSS}", "{e:AAS}", "{e:ASA}", "{e:SAS}"], 2,
        { fig: { t: "pair", sides: { AB: 1 }, angles: { A: 1, B: 2 } } }],
      ["مثلث متطابق الأضلاع، طول أحد أضلاعه {e:(2x + 3)} وحدة، وطول ضلع آخر فيه 15 وحدة، فإن قيمة {e:x} تساوي:", ["3", "6", "9", "12"], 1,
        { fig: { t: "equi", labels: ["2x + 3", "15"] } }],
      ["في المثلث المتطابق الضلعين، الزاويتان المقابلتان للضلعين المتطابقين:", ["متتامتان", "متكاملتان", "إحداهما قائمة", "متطابقتان"], 3],
      ["قياس كل زاوية في المثلث المتطابق الأضلاع يساوي:", ["{d:30}", "{d:45}", "{d:60}", "{d:90}"], 2],
      ["عند كتابة برهان إحداثي لمثلث قائم الزاوية، فإن الأفضل جعل رأس الزاوية القائمة عند:", ["نقطة الأصل", "{e:(a, a)}", "{e:(a, 2a)}", "أي نقطة على المحور {e:y} فقط"], 0],
      ["الضلع الذي يقع بين زاويتين متتاليتين في مضلع يُسمّى الضلع:", ["المحصور", "المناظر", "المساعد", "الخارجي"], 0],
    ] },
    { key: "t", type: "tf", title: "السؤال الثاني: صح أو خطأ", marks: 5, hint: "اختاري «صح» للعبارة الصحيحة و«خطأ» للعبارة الخاطئة (لكل فقرة نصف درجة).", items: [
      ["مجموع قياسات زوايا أي مثلث يساوي {d:180}.", true],
      ["المثلث الذي يحوي زاوية قياسها أكبر من {d:90} هو مثلث قائم الزاوية.", false],
      ["إذا تطابقت الزوايا الثلاث في مثلث مع نظائرها في مثلث آخر ({e:AAA}) فإن المثلثين متطابقان دائمًا.", false],
      ["كل مثلث متطابق الأضلاع هو مثلث متطابق الضلعين أيضًا.", true],
      ["في المثلث المتطابق الضلعين، زاويتا القاعدة متطابقتان.", true],
      ["في المثلث المختلف الأضلاع يوجد ضلعان متطابقان على الأقل.", false],
      ["في المثلثين المتطابقين، تكون جميع العناصر المتناظرة متطابقة.", true],
      ["الزاوية الخارجية للمثلث أصغر دائمًا من كل واحدة من الزاويتين الداخليتين البعيدتين.", false],
      ["يمكن أن يحتوي المثلث الواحد على زاويتين منفرجتين.", false],
      ["يكون المثلث متطابق الأضلاع إذا وفقط إذا كان متطابق الزوايا.", true],
    ] },
    { key: "p", type: "match", title: "السؤال الثالث: المزاوجة", marks: 5, hint: "اختاري لكل عبارة الرمز المناسب من العمود الثاني. انتبهي: فيه فقرة زائدة ما تُستعمل (لكل فقرة نصف درجة).",
      choices: [
        ["أ", "{e:SSS}"], ["ب", "{e:SAS}"], ["ج", "{e:ASA}"], ["د", "{e:AAS}"],
        ["هـ", "المثلث الحاد الزوايا"], ["و", "المثلث القائم الزاوية"], ["ز", "المثلث المتطابق الأضلاع"], ["ح", "المثلث المتطابق الضلعين"],
        ["ط", "الضلع المحصور"], ["ي", "الزاويتان الداخليتان البعيدتان"], ["ك", "البرهان الإحداثي"],
      ],
      items: [
        ["مثلث زواياه الثلاث حادة", "هـ"],
        ["مثلث له زاوية قياسها {d:90}", "و"],
        ["مثلث أضلاعه الثلاثة متطابقة", "ز"],
        ["مثلث فيه ضلعان متطابقان على الأقل", "ح"],
        ["الضلع الذي يقع بين زاويتين متتاليتين في مضلع", "ط"],
        ["مسلّمة تنص على تطابق الأضلاع الثلاثة المتناظرة في مثلثين", "أ"],
        ["مسلّمة تنص على تطابق ضلعين والزاوية المحصورة بينهما في مثلثين", "ب"],
        ["نظرية تنص على تطابق زاويتين وضلع غير محصور بينهما في مثلثين", "د"],
        ["زاويتان داخليتان في المثلث لا تجاوران الزاوية الخارجية المعطاة", "ي"],
        ["برهان يستعمل الأشكال في المستوى الإحداثي والجبر", "ك"],
      ] },
  ],
};
// Its short model for صعوبات التعلم (نموذج مختصر), from the teacher's own paper: two choices an item, 20 items, a mark each, 25 minutes.
const TRI_LD = {
  key: "congruent-triangles-2", parent: "congruent-triangles", ld: true, model: "نموذج صعوبات التعلم (مختصر بخيارين)",
  title: TRI.title, subject: TRI.subject, book: TRI.book, grade: 1, semester: TRI.semester, theme: "sadu",
  minutes: 25, total: 20, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختيار من متعدد", marks: 10, hint: "اختاري الإجابة الصحيحة من الخيارين (لكل فقرة درجة).", items: [
      ["مثلث قياسات زواياه {d:90} ، {d:50} ، {d:40}، يُسمّى مثلثًا:", ["قائم الزاوية", "منفرج الزاوية"], 0],
      ["مثلث أطوال أضلاعه {e:6 cm} ، {e:6 cm} ، {e:6 cm}، يُسمّى مثلثًا:", ["مختلف الأضلاع", "متطابق الأضلاع"], 1],
      ["في {e:△ABC}، إذا كان {e:m∠A = 70°} و {e:m∠B = 60°}، فإن {e:m∠C} يساوي:", ["{d:40}", "{d:50}"], 1,
        { fig: { t: "tri", A: 70, B: 60, labels: ["70°", "60°", "?"] } }],
      ["زاوية خارجية لمثلث قياسها {d:110}، وقياس إحدى الزاويتين الداخليتين البعيدتين {d:40}، فإن قياس الأخرى يساوي:", ["{d:70}", "{d:150}"], 0,
        { fig: { t: "ext", A: 40, B: 70, labels: ["40°", "?", "110°"] } }],
      ["تنص مسلّمة {e:SSS} على تطابق مثلثين إذا تطابقت:", ["الزوايا الثلاث المتناظرة", "الأضلاع الثلاثة المتناظرة"], 1],
      ["في {e:△ABC} و {e:△DEF}: {e:AB ≅ DE} ، {e:∠B ≅ ∠E} ، {e:BC ≅ EF}، فإن المثلثين متطابقان بحسب مسلّمة:", ["{e:SAS}", "{e:ASA}"], 0,
        { fig: { t: "pair", sides: { AB: 1, BC: 2 }, angles: { B: 1 } } }],
      ["إذا تطابقت زاويتان وضلع غير محصور بينهما في مثلثين، فإن المثلثين متطابقان بحسب نظرية:", ["{e:ASA}", "{e:AAS}"], 1],
      ["مثلث متطابق الضلعين قياس زاوية رأسه {d:80}، فإن قياس كل زاوية من زاويتي القاعدة يساوي:", ["{d:50}", "{d:100}"], 0,
        { fig: { t: "iso", apex: 80, label: "80°" } }],
      ["قياس كل زاوية في المثلث المتطابق الأضلاع يساوي:", ["{d:30}", "{d:60}"], 1],
      ["عند كتابة برهان إحداثي لمثلث قائم الزاوية، الأفضل أن يكون رأس الزاوية القائمة عند:", ["نقطة الأصل", "النقطة {e:(a, a)}"], 0],
    ] },
    { key: "t", type: "tf", title: "السؤال الثاني: صح أو خطأ", marks: 10, hint: "اختاري «صح» للعبارة الصحيحة و«خطأ» للعبارة الخاطئة (لكل فقرة درجة).", items: [
      ["إذا كان {e:△ABC ≅ △DEF} فإن {e:∠A ≅ ∠D}.", true],
      ["يمكن إثبات تطابق مثلثين بتطابق ضلعين وزاوية غير محصورة بينهما.", false],
      ["مجموع قياسي الزاويتين الحادتين في المثلث القائم الزاوية يساوي {d:90}.", true],
      ["يمكن أن يكون المثلث المنفرج الزاوية متطابق الأضلاع.", false],
      ["قياس الزاوية الخارجية للمثلث يساوي مجموع قياسي الزاويتين الداخليتين البعيدتين.", true],
      ["المثلث الذي طولا ضلعين من أضلاعه {e:5 cm} و {e:5 cm} هو مثلث مختلف الأضلاع.", false],
      ["في مسلّمة {e:ASA} يكون الضلع محصورًا بين الزاويتين المتطابقتين.", true],
      ["تنص نظرية {e:AAS} على تطابق زاويتين والضلع المحصور بينهما.", false],
      ["قياس كل زاوية في أي مثلث متطابق الضلعين يساوي {d:60}.", false],
      ["زاوية الرأس في المثلث المتطابق الضلعين هي الزاوية التي تقع بين الضلعين المتطابقين.", true],
    ] },
  ],
};

// Newest first: the panel opens on the first one.
const EXAMS = [TRI, TRI_LD, POLY, POLY_LD, {
  key: "parallel-perpendicular",
  title: "اختبار الباب الثاني: التوازي والتعامد",
  subject: "الرياضيات 1", book: "رياضيات 1", grade: 1, semester: "الفصل الدراسي الأول",
  minutes: 55, total: 20, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختيار من متعدد", marks: 10, hint: "اختاري الإجابة الصحيحة لكل فقرة (لكل فقرة نصف درجة).", items: [
      ["المستقيمان اللذان لا يتقاطعان ولا يقعان في مستوى واحد يسمّيان:", ["متخالفين", "متوازيين", "متعامدين", "متقاطعين"], 0],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن كل زاويتين متبادلتين داخليًا تكونان:", ["متكاملتين", "متتامّتين", "متطابقتين", "غير متطابقتين"], 2],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن كل زاويتين متناظرتين تكونان:", ["مجموعهما {d:90}", "مجموعهما {d:180}", "مجموعهما {d:360}", "متطابقتين"], 3],
      ["مجموع قياسي زاويتين متحالفتين (داخليتين على جهة واحدة من القاطع) عند توازي المستقيمين يساوي:", ["{d:180}", "{d:90}", "{d:360}", "{d:120}"], 0],
      ["إذا كانت الزاويتان 1 و 2 متحالفتين، وكان {e:m∠1 = 65°}، والمستقيمان متوازيان، فإن {e:m∠2} يساوي:", ["{d:25}", "{d:65}", "{d:295}", "{d:115}"], 3],
      ["قطع قاطع مستقيمين متوازيين، وكان قياسا زاويتين متبادلتين خارجيًا {e:(3x + 10)°} و {e:(5x − 30)°}، فإن قيمة {e:x} تساوي:", ["10", "20", "15", "25"], 1],
      ["إذا قطع قاطع مستقيمين وكانت زاويتان متناظرتان متطابقتين، فإن المستقيمين:", ["متخالفان", "متقاطعان", "متوازيان", "متعامدان"], 2],
      ["إذا كان مستقيم عموديًا على أحد مستقيمين متوازيين في المستوى نفسه، فإنه:", ["يوازي المستقيم الآخر", "عمودي على المستقيم الآخر", "ينطبق على المستقيم الآخر", "يقطع المستقيم الآخر بزاوية {d:45}"], 1],
      ["ميل المستقيم المار بالنقطتين {p:2,1} و {p:4,7} يساوي:", ["{f:1/3}", "2", "3", "6"], 2],
      ["ميل المستقيم الأفقي يساوي:", ["0", "1", "{e:−1}", "غير معرّف"], 0],
      ["ميل المستقيم الرأسي:", ["0", "1", "{e:−1}", "غير معرّف"], 3],
      ["ميل أي مستقيم يوازي المستقيم {e:y = −2x + 5} يساوي:", ["2", "{e:−2}", "{f:1/2}", "5"], 1],
      ["ميل المستقيم العمودي على مستقيم ميله 4 يساوي:", ["4", "{e:−4}", "{f:1/4}", "{f:-1/4}"], 3],
      ["المستقيمان اللذان ميلاهما {f:3/2} و {f:-2/3} يكونان:", ["متوازيين", "متعامدين", "متقاطعين وغير متعامدين", "منطبقين"], 1],
      ["معادلة المستقيم الذي ميله 3 ومقطعه الصادي {e:−2} هي:", ["{e:y = −2x + 3}", "{e:y = 2x − 3}", "{e:y = 3x − 2}", "{e:y = 3x + 2}"], 2],
      ["معادلة المستقيم المار بالنقطة {p:1,5} وميله 2 بصيغة الميل ونقطة هي:", ["{e:y − 1 = 2(x − 5)}", "{e:y + 5 = 2(x + 1)}", "{e:y − 5 = 2(x − 1)}", "{e:y − 2 = 5(x − 1)}"], 2],
      ["معادلة المستقيم المار بالنقطتين {p:0,3} و {p:2,7} هي:", ["{e:y = 2x + 3}", "{e:y = 3x + 2}", "{e:y = 2x − 3}", "{e:y = 4x + 3}"], 0],
      ["المسافة بين نقطة ومستقيم لا تنتمي إليه هي طول:", ["أي قطعة مستقيمة تصل بين النقطة والمستقيم", "القطعة المستقيمة العمودية من النقطة إلى المستقيم", "أطول قطعة مستقيمة بين النقطة والمستقيم", "القطعة المستقيمة الموازية للمستقيم"], 1],
      ["المسافة بين النقطة {p:3,4} والمستقيم {e:x = 7} تساوي:", ["3", "7", "11", "4"], 3],
      ["المسافة بين المستقيمين المتوازيين {e:y = 2} و {e:y = −3} تساوي:", ["5", "1", "6", "2"], 0],
    ] },
    TF, MATCH,
  ],
}, {
  // The model for students with learning difficulties (صعوبات التعلم): two choices per item and 55 minutes (the teacher set both models to 55). The
  // same link takes them here; it opens and closes with the main exam.
  key: "parallel-perpendicular-2", parent: "parallel-perpendicular", ld: true, model: "نموذج صعوبات التعلم (بخيارين)",
  title: "اختبار الباب الثاني: التوازي والتعامد",
  subject: "الرياضيات 1", book: "رياضيات 1", grade: 1, semester: "الفصل الدراسي الأول",
  minutes: 55, total: 20, owner: FAIZA,
  sections: [
    { key: "m", type: "mcq", title: "السؤال الأول: اختيار من متعدد", marks: 10, hint: "اختاري الإجابة الصحيحة لكل فقرة (لكل فقرة نصف درجة).", items: [
      ["المستقيمان اللذان لا يتقاطعان ولا يقعان في مستوى واحد يسمّيان:", ["متخالفين", "متوازيين"], 0],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن كل زاويتين متبادلتين داخليًا تكونان:", ["متكاملتين", "متطابقتين"], 1],
      ["إذا قطع قاطع مستقيمين متوازيين، فإن كل زاويتين متناظرتين تكونان:", ["مجموعهما {d:180}", "متطابقتين"], 1],
      ["مجموع قياسي زاويتين متحالفتين (داخليتين على جهة واحدة من القاطع) عند توازي المستقيمين يساوي:", ["{d:180}", "{d:90}"], 0],
      ["إذا كانت الزاويتان 1 و 2 متحالفتين، وكان {e:m∠1 = 65°}، والمستقيمان متوازيان، فإن {e:m∠2} يساوي:", ["{d:65}", "{d:115}"], 1],
      ["قطع قاطع مستقيمين متوازيين، وكان قياسا زاويتين متبادلتين خارجيًا {e:(3x + 10)°} و {e:(5x − 30)°}، فإن قيمة {e:x} تساوي:", ["20", "10"], 0],
      ["إذا قطع قاطع مستقيمين وكانت زاويتان متناظرتان متطابقتين، فإن المستقيمين:", ["متوازيان", "متقاطعان"], 0],
      ["إذا كان مستقيم عموديًا على أحد مستقيمين متوازيين في المستوى نفسه، فإنه:", ["يوازي المستقيم الآخر", "عمودي على المستقيم الآخر"], 1],
      ["ميل المستقيم المار بالنقطتين {p:2,1} و {p:4,7} يساوي:", ["2", "3"], 1],
      ["ميل المستقيم الأفقي يساوي:", ["0", "غير معرّف"], 0],
      ["ميل المستقيم الرأسي:", ["غير معرّف", "0"], 0],
      ["ميل أي مستقيم يوازي المستقيم {e:y = −2x + 5} يساوي:", ["2", "{e:−2}"], 1],
      ["ميل المستقيم العمودي على مستقيم ميله 4 يساوي:", ["{f:-1/4}", "{e:−4}"], 0],
      ["المستقيمان اللذان ميلاهما {f:3/2} و {f:-2/3} يكونان:", ["متوازيين", "متعامدين"], 1],
      ["معادلة المستقيم الذي ميله 3 ومقطعه الصادي {e:−2} هي:", ["{e:y = 3x − 2}", "{e:y = 3x + 2}"], 0],
      ["معادلة المستقيم المار بالنقطة {p:1,5} وميله 2 بصيغة الميل ونقطة هي:", ["{e:y − 1 = 2(x − 5)}", "{e:y − 5 = 2(x − 1)}"], 1],
      ["معادلة المستقيم المار بالنقطتين {p:0,3} و {p:2,7} هي:", ["{e:y = 3x + 2}", "{e:y = 2x + 3}"], 1],
      ["المسافة بين نقطة ومستقيم لا تنتمي إليه هي طول:", ["القطعة المستقيمة العمودية من النقطة إلى المستقيم", "أي قطعة مستقيمة تصل بين النقطة والمستقيم"], 0],
      ["المسافة بين النقطة {p:3,4} والمستقيم {e:x = 7} تساوي:", ["7", "4"], 1],
      ["المسافة بين المستقيمين المتوازيين {e:y = 2} و {e:y = −3} تساوي:", ["5", "1"], 0],
    ] },
    TF, MATCH,
  ],
}];

// Each item gets an id (m1…m20, t1…, p1…) and the same weight: the section's marks over its items.
for (const ex of EXAMS) {
  ex.sections = ex.sections.map(sec => ({ ...sec }));
  ex.items = [];
  for (const s of ex.sections) {
    s.weight = s.marks / s.items.length;
    s.items = s.items.map((it, i) => {
      const id = s.key + (i + 1);
      // An item may end with { fig }: a drawing the page shows with the question.
      const extra = s.type === "mcq" ? it[3] : it[2];
      const item = s.type === "mcq" ? { id, q: it[0], options: it[1], answer: it[2] } : { id, q: it[0], answer: it[1] };
      if (extra?.fig) item.fig = extra.fig;
      ex.items.push({ ...item, section: s.key, type: s.type, weight: s.weight, n: i + 1 });
      return item;
    });
  }
  ex.byId = Object.fromEntries(ex.items.map(i => [i.id, i]));
}
const BY_KEY = Object.fromEntries(EXAMS.map(e => [e.key, e]));
// A main exam and its learning-difficulties model: a student is sent to the one that fits her.
const modelFor = (ex, ld) => { const main = BY_KEY[ex.parent] || ex; return ld ? EXAMS.find(e => e.parent === main.key) || main : main; };
// Practice IDs: anyone (the teacher, the principal, a visitor) can try the exam with them, open or closed. Their attempts
// start over every time and never reach the panel, since they are on no teacher's list.
const DEMO = { "0000000000": false, "0000000001": true };
// Each visitor practises on her own attempt: the page sends a random token of its own with a practice ID.
const keyOf = (id, token) => {
  if (!(id in DEMO)) return id;
  const t = String(token ?? "").toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 32);
  return t.length >= 16 ? `${id}:${t}` : null;
};
const SUBJECT = "رياضيات";
const GRACE_MS = 2 * 60 * 1000;
const round2 = n => Math.round(n * 100) / 100;

// What the page gets: the questions without their answers.
const publicSections = ex => ex.sections.map(s => ({ key: s.key, type: s.type, title: s.title, marks: s.marks, hint: s.hint,
  choices: s.choices?.map(([sym, text]) => ({ sym, text })),
  items: s.items.map(({ id, q, options, fig }) => ({ id, q, ...(options ? { options } : {}), ...(fig ? { fig } : {}) })) }));
const meta = ex => ({ key: ex.key, title: ex.title, theme: ex.theme || null, model: ex.model || null, ld: !!ex.ld, parent: ex.parent || null, subject: ex.subject, grade: ex.grade, gradeLabel: Report.GRADES[ex.grade - 1],
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
  const { rows } = await pool.query("SELECT name, class, email, learning_difficulty FROM students WHERE national_id = $1 AND teacher_id = ANY($2) ORDER BY teacher_id", [id, panels]);
  if (!rows.length) return null;
  const r = rows.find(x => Report.classParts(x.class)) || rows[0];
  return { name: r.name, class: r.class, email: !!r.email, grade: Report.classParts(r.class)?.grade || null, ld: rows.some(x => x.learning_difficulty) };
}

// A model opens and closes with its main exam.
const stateKey = ex => ex.parent || ex.key;
const isOpen = async (pool, ex) => !!(await pool.query("SELECT open FROM exam_state WHERE exam = $1", [stateKey(ex)])).rows[0]?.open;
const isPublished = async (pool, ex) => !!(await pool.query("SELECT published FROM exam_state WHERE exam = $1", [stateKey(ex)])).rows[0]?.published;

// Attempts past their deadline (and its grace) close with the answers they saved. One with no answer at all is not
// an attempt (she pressed «ابدئي» and left, days before the real sitting): it is removed, so she can start when she sits it.
async function closeExpired(pool, ex, id) {
  const late = `exam = $1 AND submitted_at IS NULL AND deadline + interval '${GRACE_MS / 1000} seconds' < now() ${id ? "AND national_id = $2" : ""}`;
  const args = id ? [ex.key, id] : [ex.key];
  await pool.query(`DELETE FROM exam_attempts WHERE ${late} AND answers = '{}'::jsonb`, args);
  const { rows } = await pool.query(`SELECT national_id, answers FROM exam_attempts WHERE ${late}`, args);
  for (const r of rows) {
    await pool.query("UPDATE exam_attempts SET submitted_at = deadline, auto_submitted = true, score = $3 WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL",
      [ex.key, r.national_id, grade(ex, r.answers).score]);
  }
}

const attemptOf = async (pool, ex, id) => (await pool.query("SELECT * FROM exam_attempts WHERE exam = $1 AND national_id = $2", [ex.key, id])).rows[0] || null;
// What the student sees of her attempt. After she hands it in: nothing of her mark until the teacher publishes the results
// ("hidden"); then her mark by section and every item with her answer and the right one ("review"). A practice try sees
// its mark at once, never the key ("score").
function attemptView(ex, a, show = "hidden") {
  if (!a) return { status: "none" };
  if (a.submitted_at) {
    const base = { status: "submitted", auto: a.auto_submitted, submittedAt: a.submitted_at, total: ex.total };
    if (show === "hidden") return { ...base, hidden: true };
    const g = grade(ex, a.answers);
    const out = { ...base, score: g.score, parts: g.parts.map(({ title, marks, score }) => ({ title, marks, score })) };
    if (show !== "review") return out;
    out.review = ex.sections.map(s => ({ title: s.title, type: s.type, choices: s.choices?.map(([sym, text]) => ({ sym, text })),
      items: s.items.map(({ id, q, options, fig, answer }) => ({ q, ...(options ? { options } : {}), ...(fig ? { fig } : {}), answer, mine: a.answers?.[id] ?? null, ok: g.right[id] })) }));
    return out;
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
  const showFor = async (ex, key) => String(key).includes(":") ? "score" : (await isPublished(pool, ex)) ? "review" : "hidden";
  const viewOf = async (ex, a, key) => attemptView(ex, a, await showFor(ex, key));
  // Who she is, and where her attempt stands. Her first name and class only: anyone can type an ID.
  const who = async (ex, id) => {
    if (id in DEMO) {
      const s = { name: "طالبة تجريبية", class: null, email: true, grade: ex.grade, ld: DEMO[id], demo: true };
      const to = modelFor(ex, s.ld);
      return to === ex ? { s } : { error: [409, "other_model"], to };
    }
    if (id.length < 9 || id.length > 10) return { error: [400, "invalid_id"] };
    const s = await studentOf(pool, ex, id);
    if (!s) return { error: [404, "not_found"] };
    if (s.grade && s.grade !== ex.grade) return { error: [403, "wrong_grade"], s };
    // A student with learning difficulties takes the two-choice model, the others the main one, from the same link.
    const to = modelFor(ex, s.ld);
    if (to !== ex) return { error: [409, "other_model"], to };
    return { s };
  };

  app.get("/api/exams/:exam", guard(async (req, res, ex) => res.json({ ...meta(ex), open: await isOpen(pool, ex) })));

  app.post("/api/exams/:exam/student", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id), key = keyOf(id, req.body?.token), w = await who(ex, id);
    if (!key) return res.status(400).json({ error: "no_token" });
    if (w.error) return res.status(w.error[0]).json({ error: w.error[1], gradeLabel: Report.GRADES[ex.grade - 1], to: w.to?.key });
    await closeExpired(pool, ex, key);
    // A practice attempt that was handed in starts over.
    if (w.s.demo) await pool.query("DELETE FROM exam_attempts WHERE exam = $1 AND national_id = $2 AND submitted_at IS NOT NULL", [ex.key, key]);
    res.json({ name: w.s.demo ? w.s.name : firstName(w.s.name), classLabel: w.s.demo ? "تجربة" : Report.classLabel(w.s.class), email: w.s.email,
      demo: !!w.s.demo, open: w.s.demo || await isOpen(pool, ex),
      now: new Date(), ...(await viewOf(ex, await attemptOf(pool, ex, key), key)) });
  }));

  // Starting (or coming back to) her attempt. The clock starts once, here, and runs on the server.
  app.post("/api/exams/:exam/start", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id), key = keyOf(id, req.body?.token), w = await who(ex, id);
    if (!key) return res.status(400).json({ error: "no_token" });
    if (w.error) return res.status(w.error[0]).json({ error: w.error[1], to: w.to?.key });
    await closeExpired(pool, ex, key);
    if (w.s.demo) {
      await pool.query("DELETE FROM exam_attempts WHERE exam = $1 AND national_id = $2 AND submitted_at IS NOT NULL", [ex.key, key]);
      await pool.query("DELETE FROM exam_attempts WHERE (national_id LIKE '0000000000:%' OR national_id LIKE '0000000001:%') AND started_at < now() - interval '1 day'");
    }
    let a = await attemptOf(pool, ex, key);
    if (!a) {
      if (!w.s.demo && !(await isOpen(pool, ex))) return res.status(423).json({ error: "closed" });
      await pool.query(`INSERT INTO exam_attempts (exam, national_id, deadline) VALUES ($1, $2, now() + interval '${ex.minutes} minutes') ON CONFLICT DO NOTHING`, [ex.key, key]);
      a = await attemptOf(pool, ex, key);
    }
    res.json({ now: new Date(), sections: publicSections(ex), ...(await viewOf(ex, a, key)) });
  }));

  // Saved as she goes; the last save before the deadline is what gets marked if time runs out.
  app.post("/api/exams/:exam/answers", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id), key = keyOf(id, req.body?.token);
    if (!key) return res.status(400).json({ error: "no_token" });
    const answers = cleanAnswers(ex, req.body?.answers);
    const { rowCount } = await pool.query(
      `UPDATE exam_attempts SET answers = $3 WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL
       AND now() < deadline + interval '${GRACE_MS / 1000} seconds'`, [ex.key, key, JSON.stringify(answers)]);
    if (!rowCount) {
      await closeExpired(pool, ex, key);
      const a = await attemptOf(pool, ex, key);
      return res.status(a ? 409 : 404).json({ error: a ? "closed" : "not_started", ...(await viewOf(ex, a, key)) });
    }
    res.json({ ok: true, saved: Object.keys(answers).length });
  }));

  app.post("/api/exams/:exam/submit", json, guard(async (req, res, ex) => {
    const id = idOf(req.body?.id), key = keyOf(id, req.body?.token);
    if (!key) return res.status(400).json({ error: "no_token" });
    const answers = cleanAnswers(ex, req.body?.answers);
    // Time ran out on a paper with nothing on it: it is removed, not handed in as a zero.
    if (!Object.keys(answers).length) {
      const gone = await pool.query("DELETE FROM exam_attempts WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL AND answers = '{}'::jsonb AND now() >= deadline", [ex.key, key]);
      if (gone.rowCount) return res.json({ status: "none", empty: true });
    }
    const { rows } = await pool.query(
      `UPDATE exam_attempts SET answers = $3, submitted_at = now(), score = $4 WHERE exam = $1 AND national_id = $2 AND submitted_at IS NULL
       AND now() < deadline + interval '${GRACE_MS / 1000} seconds' RETURNING *`, [ex.key, key, JSON.stringify(answers), grade(ex, answers).score]);
    if (!rows.length) await closeExpired(pool, ex, key);
    const a = rows[0] || await attemptOf(pool, ex, key);
    if (!a) return res.status(404).json({ error: "not_started" });
    res.json(await viewOf(ex, a, key));
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
        `SELECT s.national_id, s.name, s.class, s.test1, s.test2, s.learning_difficulty, a.started_at, a.deadline, a.answers, a.submitted_at, a.auto_submitted,
           a.approved_at, a.approved_field, a.approved_value
         FROM students s LEFT JOIN exam_attempts a ON a.exam = $2 AND a.national_id = s.national_id
         WHERE s.teacher_id = $1 ORDER BY s.class NULLS LAST, s.name`, [req.tid, ex.key]);
      // Her students in the exam's grade, and anyone of hers who took it anyway.
      // Each model lists the students it is for: صعوبات التعلم in the two-choice model, the others in the main one.
      const students = rows.filter(r => r.started_at || (!!r.learning_difficulty === !!ex.ld
        && (!Report.classParts(r.class) || Report.classParts(r.class).grade === ex.grade))).map(r => {
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
      out.push({ ...meta(ex), open: await isOpen(pool, ex), published: await isPublished(pool, ex), sections, students });
    }
    res.json({ max: maxOf(getSettings(req.tid)).test, exams: out });
  });

  router.put("/exams/:exam/open", async (req, res) => {
    const ex = pick(req, res);
    if (!ex) return;
    const open = !!req.body?.open;
    await pool.query("INSERT INTO exam_state (exam, open, changed_at) VALUES ($1, $2, now()) ON CONFLICT (exam) DO UPDATE SET open = EXCLUDED.open, changed_at = now()", [stateKey(ex), open]);
    res.json({ ok: true, open });
  });

  // Publishing the results: each student who handed in sees her mark and her answers against the key when she comes back
  // with her ID. The two models share it with the main exam.
  router.put("/exams/:exam/publish", async (req, res) => {
    const ex = pick(req, res);
    if (!ex) return;
    const published = !!req.body?.published;
    await pool.query("INSERT INTO exam_state (exam, published, changed_at) VALUES ($1, $2, now()) ON CONFLICT (exam) DO UPDATE SET published = EXCLUDED.published, changed_at = now()", [stateKey(ex), published]);
    res.json({ ok: true, published });
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

module.exports = { SCHEMA, EXAMS, DEMO, panelExams, grade, mount, mountPanel };
