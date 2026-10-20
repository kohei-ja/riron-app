"use strict";

const TYPE_LABEL = { yoten: "要点", kitei: "規定", riron: "理論チェック", maru: "〇×" };
const STAGE_LABEL = ["キーワード穴埋め", "頭文字ヒント", "白紙から再現"];
const MASTERY_LABEL = ["未学習", "キーワード段階", "頭文字段階", "再現できた", "定着", "完全定着"];
const GRADE_LABEL = { 1: "もう一度", 2: "あやふや", 3: "OK", 4: "完璧" };
const STAGED = new Set(["yoten"]); // 規定は赤字の穴埋めだけで覚える
const MEMORIZE = new Set(["yoten", "kitei"]); // 暗記の中心(定着率などの集計対象)
const DAY_MS = 86400e3;
const LADDER = Srs.REVIEW_LADDER; // 忘却曲線に沿った卒業後の復習間隔(srs.py・srs.js と同じ)
const TARGET_RECALL = Srs.TARGET_RECALL;
const PUNCT_RE = /[、。，．「」『』（）・\s]/;

let DATA = null;
let BY_ID = {};
let ORDER = {};
let S = null; // 学習セッション

// ---------- 共通 ----------
// PC のサーバーに話しかけるか、この端末の中(local.js)だけで動くか。
// サーバーが JSON を返さない(GitHub Pages など)か、つながらなければ端末内で動く。
let LOCAL = false;

async function detectBackend() {
  try {
    const res = await fetch("api/connect");
    LOCAL = !(res.headers.get("content-type") || "").includes("json");
  } catch {
    LOCAL = true;
  }
  if (LOCAL && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

async function api(path, body) {
  if (LOCAL) return Local.request(path, body);
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.replace("/");  // サーバーがログイン画面を返す
    throw new Error("ログインが必要です");
  }
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

async function load() {
  DATA = await api("/api/data");
  BY_ID = {};
  ORDER = {};
  DATA.cards.forEach((c, i) => { BY_ID[c.id] = c; ORDER[c.id] = i; });
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

// replaceChildren は null を "null" という文字にしてしまうので取り除いてから渡す
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const st = (id) => DATA.states[id];
const settings = () => DATA.settings;
// 講義計画にあるカードは受講済みの講義回まで、計画にない章は設定で手動で選んだものだけを出題する
const unlocked = (c) => (c.lecture != null ? c.lecture <= settings().lectures_done : settings().unlocked_chapters.includes(c.chapter));
const chapterUnlocked = (ch) => DATA.cards.some((c) => c.chapter === ch && unlocked(c));
const runsText = (runs) => runs.map((r) => r[0]).join("");
const hasKeywords = (runs) => runs.some((r) => r[1] && r[0].trim());
const starsText = (n) => (n ? "★".repeat(n) : "");
const chapterTitle = (ch) => (DATA.cards.find((c) => c.chapter === ch) || {}).chapter_title || "";
const chapters = () => [...new Set(DATA.cards.map((c) => c.chapter))].sort((a, b) => a - b);

// 学習日は朝 4 時で切り替える
function dayKey(date) {
  const d = new Date(new Date(date).getTime() - 4 * 3600e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n, 12);
  return dayKey(new Date(dt.getTime() + 4 * 3600e3));
}
function daysBetween(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}
const fmtDay = (key) => { const [, m, d] = key.split("-").map(Number); return `${m}/${d}`; };

function isDue(c, now = new Date()) {
  const s = st(c.id);
  if (!s || s.suspended || s.status === "new" || !s.due) return false;
  if (s.status === "learning") return new Date(s.due) <= new Date(now.getTime() + 20 * 60e3);
  return dayKey(s.due) <= dayKey(now);
}

function newIntroducedToday() {
  const today = dayKey(new Date());
  // ミニテスト対策で初めて解いたカードは、毎日の新規枠に数えない
  return DATA.log.filter((e) => e[4] === "new" && e[8] !== "test" && dayKey(e[0]) === today).length;
}

function newCandidates(filter) {
  const s = settings();
  const list = DATA.cards.filter((c) =>
    st(c.id).status === "new" && !st(c.id).suspended && unlocked(c) &&
    s.new_types.includes(c.type) && (!filter || filter(c)));
  const key = s.new_order === "chapter"
    ? (c) => [c.chapter, ORDER[c.id]]
    : (c) => [-c.stars, c.chapter, ORDER[c.id]];
  return list.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

function shownStage(c) {
  const s = st(c.id);
  if (!STAGED.has(c.type) || s.status === "review") return 2;
  return s.status === "new" ? 0 : s.stage;
}

// ---------- ツールチップ ----------
const tipEl = () => document.getElementById("tooltip");
function showTip(evt, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tipEl().hidden = true; }
function tipOn(el, html) {
  el.addEventListener("mousemove", (e) => showTip(e, typeof html === "function" ? html() : html));
  el.addEventListener("mouseleave", hideTip);
  return el;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- リッチテキストの描画 ----------
// how: full(全表示) / skeleton(各文節の頭文字だけ) / kwinput(キーワードを入力欄に)
//      / redsheet(キーワードを赤シートで覆う。クリックでめくる。opts.toggle なら再クリックで戻す)
function renderRuns(runs, how, opts = {}) {
  const root = h("span", { class: "answer-runs" });
  const inputs = [];
  for (const [text, k] of runs) {
    if (how === "kwinput" && k && text.trim()) {
      const inp = h("input", {
        class: "blank-input",
        autocomplete: "off",
        style: `width:${Math.min(28, text.length * 1.15 + 1.2)}em`,
      });
      inp.dataset.answer = text;
      root.append(inp);
      inputs.push(inp);
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (i > 0) root.append(h("br"));
      appendPhrases(root, line, k, how, opts);
    });
  }
  return { el: root, inputs };
}

function appendPhrases(parent, line, k, how, opts) {
  const parts = line.match(/[^、。，．「」『』（）]*[、。，．「」『』（）]?/g).filter(Boolean);
  for (const p of parts) {
    const span = h("span", { class: "ph" + (k ? " kw" : "") });
    if (how === "redsheet" && k && p.trim()) {
      span.textContent = p;
      span.classList.add("sheet");
      span.title = "クリックでめくる";
      span.addEventListener("click", () => {
        if (span.classList.contains("sheet")) { span.classList.remove("sheet"); opts.onOpen?.(); }
        else if (opts.toggle) span.classList.add("sheet");
      });
      parent.append(span);
      continue;
    }
    const hideAll = how === "kwinput" && k;
    if (!hideAll && how !== "skeleton") {
      span.textContent = p;
      parent.append(span);
      continue;
    }
    let first = true;
    for (const ch of p) {
      const isPunct = PUNCT_RE.test(ch);
      const show = how === "skeleton" && (isPunct || first);
      if (!isPunct) first = false;
      span.append(show ? ch : h("span", { class: "hid" }, ch));
    }
    if (opts.peek) {
      span.classList.add("peekable");
      span.title = "クリックでこの部分だけ見る";
      span.addEventListener("click", () => {
        if (!span.classList.contains("peekable")) return;
        span.querySelectorAll(".hid").forEach((x) => x.classList.remove("hid"));
        span.classList.remove("peekable");
        opts.peek();
      }, { once: true });
    }
    parent.append(span);
  }
}

// ---------- 採点(タイピング) ----------
const norm = (s) => s.normalize("NFKC").replace(/\s/g, "");

function lcsMatch(a, b) {
  const n = a.length, m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ma = new Array(n).fill(false), mb = new Array(m).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ma[i] = mb[j] = true; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return { ma, mb, len: dp[0] };
}

// 表示単位(元の 1 文字)ごとに、正規化後の文字列へ対応付ける
function units(text) {
  const out = [];
  for (const ch of text) out.push({ ch, n: norm(ch) });
  return out;
}

function gradeTyped(runs, typed) {
  const modelUnits = [];
  for (const [t, k] of runs) for (const u of units(t)) modelUnits.push({ ...u, k });
  const typedUnits = units(typed);
  const flat = (us) => { const arr = [], owner = []; us.forEach((u, idx) => { for (const c of u.n) { arr.push(c); owner.push(idx); } }); return { arr, owner }; };
  const A = flat(modelUnits), B = flat(typedUnits);
  const { ma, mb, len } = lcsMatch(A.arr, B.arr);
  const mUnitOk = modelUnits.map(() => true), tUnitOk = typedUnits.map(() => true);
  ma.forEach((ok, i) => { if (!ok) mUnitOk[A.owner[i]] = false; });
  mb.forEach((ok, i) => { if (!ok) tUnitOk[B.owner[i]] = false; });
  const typedNorm = norm(typed);
  const kws = runs.filter((r) => r[1]).map((r) => norm(r[0])).filter(Boolean);
  const hit = kws.filter((k) => typedNorm.includes(k)).length;
  const score = A.arr.length ? len / A.arr.length : 0;
  const coverage = kws.length ? hit / kws.length : score;
  return { modelUnits, mUnitOk, typedUnits, tUnitOk, score, coverage, kwHit: hit, kwTotal: kws.length };
}

function suggestFromScore(score, coverage) {
  if (score >= 0.95 && coverage >= 0.999) return 4;
  if (score >= 0.8 && coverage >= 0.8) return 3;
  if (score >= 0.5) return 2;
  return 1;
}

function renderDiff(g) {
  const model = h("div", { class: "answer diff" });
  g.modelUnits.forEach((u, i) => {
    if (u.ch === "\n") { model.append(h("br")); return; }
    model.append(h("span", { class: (g.mUnitOk[i] || !u.n ? "" : "miss") + (u.k ? " kw" : "") }, u.ch));
  });
  const typed = h("div", { class: "answer diff" });
  g.typedUnits.forEach((u, i) => {
    if (u.ch === "\n") { typed.append(h("br")); return; }
    typed.append(h("span", { class: g.tUnitOk[i] || !u.n ? "" : "extra" }, u.ch));
  });
  return h("div", {},
    h("div", { class: "score-line" },
      h("span", {}, "一致率 ", h("b", {}, `${Math.round(g.score * 100)}%`)),
      g.kwTotal ? h("span", {}, "キーワード ", h("b", {}, `${g.kwHit}/${g.kwTotal}`)) : null),
    h("div", { class: "small muted" }, "模範解答(", h("span", { class: "diff" }, h("span", { class: "miss" }, "波線")), " = 書けなかった部分)"),
    model,
    h("div", { class: "small muted", style: "margin-top:8px" }, "あなたの解答(", h("span", { class: "diff" }, h("span", { class: "extra" }, "色付き")), " = 模範解答にない部分)"),
    typed);
}

function checkInputs(inputs) {
  let ok = 0;
  for (const inp of inputs) {
    const right = norm(inp.value) === norm(inp.dataset.answer);
    inp.classList.add(right ? "ok" : "ng");
    inp.readOnly = true;
    if (right) ok++;
    else inp.after(h("span", { class: "blank-fix" }, `→${inp.dataset.answer}`));
  }
  return inputs.length ? ok / inputs.length : 1;
}

// ---------- 学習セッション ----------
function studyMode() {
  let m;
  try { m = localStorage.getItem("studyMode") || "auto"; } catch { m = "auto"; }
  return m === "self" ? "redsheet" : m; // 口頭・手書きモードは赤シートに統合した
}
function setStudyMode(m) {
  try { localStorage.setItem("studyMode", m); } catch { /* 保存できなくても動作は続ける */ }
}

function interleave(reviews, news) {
  if (!news.length) return reviews;
  const out = [];
  const step = Math.max(1, Math.floor(reviews.length / (news.length + 1)));
  let r = 0;
  for (const n of news) {
    for (let i = 0; i < step && r < reviews.length; i++) out.push(reviews[r++]);
    out.push(n);
  }
  return out.concat(reviews.slice(r));
}

function todayQueue(filter) {
  const now = new Date();
  const due = DATA.cards.filter((c) => (!filter || filter(c)) && isDue(c, now));
  const learning = due.filter((c) => st(c.id).status === "learning")
    .sort((a, b) => new Date(st(a.id).due) - new Date(st(b.id).due));
  const reviews = due.filter((c) => st(c.id).status === "review")
    .sort((a, b) => st(a.id).recall - st(b.id).recall);
  const newLeft = Math.max(0, settings().daily_new - newIntroducedToday());
  const news = newCandidates(filter).slice(0, newLeft);
  return [...learning, ...interleave(reviews, news)].map((c) => c.id);
}

function practiceQueue(filter) {
  return DATA.cards
    .filter((c) => !st(c.id).suspended && filter(c))
    .sort((a, b) => st(a.id).mastery - st(b.id).mastery || st(a.id).recall - st(b.id).recall || ORDER[a.id] - ORDER[b.id])
    .map((c) => c.id);
}

function weakCards() {
  return DATA.cards
    .filter((c) => !st(c.id).suspended && st(c.id).status !== "new" &&
      (st(c.id).lapses > 0 || st(c.id).flagged || (st(c.id).status === "review" && st(c.id).recall < 0.8)))
    .sort((a, b) => (st(b.id).flagged - st(a.id).flagged) || (st(b.id).lapses - st(a.id).lapses) || (st(a.id).recall - st(b.id).recall));
}

// opts.context: "test" ならミニテスト対策として記録 / opts.mock: 模擬テスト(全問白紙で出題し、再出題しない)
function startSession(queue, title, opts = {}) {
  if (!queue.length) { alert("対象のカードがありません。"); return; }
  S = { queue: [...queue], title, done: 0, results: { 1: 0, 2: 0, 3: 0, 4: 0 }, startedAt: Date.now(), cur: null, history: [],
    context: opts.context || null, mock: !!opts.mock };
  nextCard();
  if (location.hash !== "#/study") location.hash = "#/study";
  else render();
}

function nextCard() {
  const id = S.queue.shift();
  S.cur = id ? { id, start: Date.now(), revealed: false, peeks: 0, suggest: null, score: null, typing: false } : null;
}

async function submitGrade(grade) {
  const cur = S.cur;
  if (!cur || !cur.revealed || S.busy) return;
  S.busy = true;
  const c = BY_ID[cur.id];
  const before = st(c.id);
  try {
    const after = await api("/api/review", {
      card_id: c.id,
      grade,
      mode: c.type === "maru" ? "choice" : cur.typing ? "type" : "self",
      score: cur.score,
      duration_ms: Date.now() - cur.start,
      stage: shownStage(c),
      context: S.context,
    });
    DATA.log.push([after.last_review, c.id, grade, shownStage(c), before.status, cur.score, Date.now() - cur.start, after.interval, S.context]);
    S.lastGrade = grade;
    DATA.states[c.id] = after;
    S.history.push({ id: c.id, grade });
    S.results[grade]++;
    S.done++;
    if (after.status === "learning" && !S.mock) {
      // 学習中のカードは少し後にもう一度出す
      S.queue.splice(Math.min(S.queue.length, grade === 1 ? 2 : 4), 0, c.id);
    }
    nextCard();
    Sync.soon();
  } catch (e) {
    alert(`保存に失敗しました: ${e.message}`);
  } finally {
    S.busy = false;
    render();
  }
}

async function undoLast() {
  if (!S || !S.history.length || S.busy) return;
  const res = await api("/api/undo", {});
  if (!res.card_id) return;
  const last = S.history.pop();
  DATA.states[res.card_id] = res.state;
  DATA.log.pop();
  S.results[last.grade]--;
  S.done--;
  // 再挿入していた分を取り除いてから先頭に戻す
  const idx = S.queue.indexOf(res.card_id);
  if (idx >= 0) S.queue.splice(idx, 1);
  if (S.cur) S.queue.unshift(S.cur.id);
  S.cur = { id: res.card_id, start: Date.now(), revealed: false, peeks: 0, suggest: null, score: null, typing: false };
  render();
}

const nextInterval = Srs.nextInterval;

function gradeHints(c) {
  const s = st(c.id);
  const maxI = settings().max_interval;
  const days = (n) => `${Math.round(Math.min(maxI, n))}日後`;
  if (s.status === "review") {
    const relearn = STAGED.has(c.type) ? "頭文字から再学習" : "すぐ再出題";
    const ivl = Math.max(1, s.interval);
    if (s.due && new Date() < new Date(s.due)) {
      const keep = `予定どおり ${fmtDay(dayKey(s.due))}`;
      return { 1: relearn, 2: keep, 3: keep, 4: keep };
    }
    return {
      1: relearn,
      2: days(Math.max(1, ivl * 1.2)),
      3: days(nextInterval(ivl, s.ease, 1)),
      4: days(nextInterval(ivl, Math.min(3, s.ease + 0.15), 2)),
    };
  }
  const stage = shownStage(c);
  const startStage = STAGED.has(c.type) ? 0 : 2;
  const graduate = Math.max(1, s.interval || 1);
  return {
    1: stage > startStage ? "前の段階へ" : "すぐ再出題",
    2: "数分後に再出題",
    3: stage < 2 ? `次へ: ${STAGE_LABEL[stage + 1]}` : `卒業: ${days(graduate)}`,
    4: stage < 2 ? `次へ: ${STAGE_LABEL[Math.min(2, stage + 2)]}` : `卒業: ${days(nextInterval(graduate, s.ease, 1))}`,
  };
}

function renderStudy(app) {
  if (!S) return renderStudyStart(app);
  if (!S.cur) return renderSessionEnd(app);
  const c = BY_ID[S.cur.id];
  const s = st(c.id);
  const cur = S.cur;
  const stage = c.type === "kitei" ? 0 : S.mock ? 2 : shownStage(c);
  const mode = studyMode();
  cur.typing = c.type !== "maru" && (mode === "typing" || (mode === "auto" && s.status !== "review"));
  const total = S.done + S.queue.length + 1;

  const [mood, react] = REACTIONS[S.lastGrade || 0];
  const head = h("div", { class: "study-head" },
    mascot(mood, react, "sm"),
    h("b", {}, S.title),
    h("span", { class: "muted small" }, `${S.done + 1} / ${total}`),
    h("span", { class: "spacer" }),
    modeSelect(),
    h("button", { class: "btn", onclick: undoLast, disabled: !S.history.length, title: "直前の評価を取り消す (Ctrl+Z)" }, "取り消し"),
    h("button", { class: "btn", onclick: () => { S = null; location.hash = "#/"; } }, "終了"));
  const progress = h("div", { class: "progress" }, h("div", { style: `width:${(S.done / total) * 100}%` }));

  const meta = h("div", { class: "card-meta row" },
    h("span", { class: `chip type-${c.type}` }, TYPE_LABEL[c.type]),
    c.stars ? h("span", { class: "stars" }, starsText(c.stars)) : null,
    h("span", {}, `第${c.chapter}章 ${c.chapter_title}`),
    h("span", { class: "muted" }, c.section || ""),
    h("span", { class: "muted" }, `p.${c.page ?? "-"}`),
    c.lecture ? h("span", { class: "chip" }, `第${c.lecture}講`) : null,
    h("span", { class: "spacer" }),
    c.type === "kitei" ? h("span", { class: `stage-badge ${s.status === "review" ? "stage-review" : "stage-0"}` }, s.status === "review" ? "復習: 赤字の穴埋め" : "赤字の穴埋め") :
    S.mock ? h("span", { class: "stage-badge stage-mock" }, "模擬テスト: 白紙から") :
    STAGED.has(c.type) ? h("span", { class: `stage-badge ${s.status === "review" ? "stage-review" : `stage-${stage}`}` }, s.status === "review" ? "復習" : `段階 ${stage + 1}/3: ${STAGE_LABEL[stage]}`) : null);

  const panel = h("div", { class: "panel" }, meta);
  const work = h("div", {});
  const after = h("div", {});

  if (c.type === "maru") renderMaru(c, panel, work, after);
  else if (c.type === "riron") renderRiron(c, panel, work, after);
  else renderMemorize(c, stage, panel, work, after);

  panel.append(work, after);
  app.append(head, progress, panel, h("p", { class: "kbd" },
    "ショートカット: Space=答えを見る / Ctrl+Enter=答え合わせ / 1〜4=評価 / Ctrl+Z=取り消し"));
  const focus = work.querySelector("textarea, input");
  if (focus && !cur.revealed) setTimeout(() => focus.focus(), 0);
}

const REACTIONS = {
  0: ["normal", "集中していこう!"],
  1: ["think", "大丈夫、ここが伸びしろだホー"],
  2: ["think", "あとひと息だホー"],
  3: ["happy", "いいね!"],
  4: ["cheer", "完璧だホー!"],
};

function modeSelect() {
  const sel = h("select", {
    title: "解答方法",
    onchange: (e) => { setStudyMode(e.target.value); render(); },
  },
  h("option", { value: "auto" }, "自動(新規=タイピング/復習=赤シート)"),
  h("option", { value: "typing" }, "タイピング"),
  h("option", { value: "redsheet" }, "赤シート"));
  sel.value = studyMode();
  return sel;
}

function questionBlock(c) {
  return h("div", { class: "question" }, runsText(c.q));
}

function revealButton(label, onReveal) {
  return h("div", { class: "row", style: "margin-top:16px" },
    h("button", { class: "btn primary big", id: "reveal-btn", onclick: onReveal }, label));
}

function gradeButtons(c) {
  const hints = gradeHints(c);
  return h("div", { class: "grades" }, [1, 2, 3, 4].map((g) =>
    h("button", {
      class: `btn g${g}` + (S.cur.suggest === g ? " suggest" : ""),
      onclick: () => submitGrade(g),
    }, h("span", {}, `${g}. ${GRADE_LABEL[g]}`), h("small", {}, hints[g]))));
}

function revealed(after, ...content) {
  S.cur.revealed = true;
  after.replaceChildren(h("div", { class: "reveal-box" }, ...content), gradeButtons(BY_ID[S.cur.id]));
  document.getElementById("reveal-btn")?.closest(".row")?.remove();
  document.activeElement?.blur?.();
}

// 赤シート: キーワードを思い出してからクリックでめくる。全部めくるか「全部めくる」で評価へ
function redSheet(runs, work, after) {
  const { el } = renderRuns(runs, "redsheet", {
    onOpen: () => { if (!el.querySelector(".sheet") && !S.cur.revealed) revealed(after); },
  });
  work.append(h("div", { class: "small muted" }, "赤シートの下を思い出してから、クリックでめくって確認"),
    h("div", { class: "answer" }, el),
    revealButton("全部めくる", () => {
      el.querySelectorAll(".sheet").forEach((x) => x.classList.remove("sheet"));
      revealed(after);
    }));
}

function renderMemorize(c, stage, panel, work, after) {
  const cur = S.cur;
  panel.append(questionBlock(c));
  const fullAnswer = () => h("div", { class: "answer" }, renderRuns(c.a, "full").el);
  // キーワードのない解答は穴埋めができないので頭文字ヒントで出す
  const effStage = stage === 0 && !hasKeywords(c.a) ? 1 : stage;
  const peek = () => { cur.peeks++; };

  if (c.type === "kitei" && !hasKeywords(c.a)) {
    // 赤字のない規定は覚える語句がないので、読んで確認するだけ
    work.append(fullAnswer(), revealButton("確認した", () => revealed(after)));
    return;
  }

  if (cur.typing) {
    if (effStage === 0) {
      const { el, inputs } = renderRuns(c.a, "kwinput");
      work.append(h("div", { class: "small muted" }, "空欄のキーワードを入力してください"), h("div", { class: "answer" }, el),
        revealButton("答え合わせ", () => {
          const score = checkInputs(inputs);
          cur.score = score;
          cur.suggest = score >= 0.999 ? 4 : score >= 0.8 ? 3 : score >= 0.5 ? 2 : 1;
          revealed(after, h("div", { class: "score-line" }, h("span", {}, "正解 ", h("b", {}, `${Math.round(score * inputs.length)}/${inputs.length}`))), fullAnswer());
        }));
      inputs.forEach((inp, i) => inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); (inputs[i + 1] || document.getElementById("reveal-btn"))?.focus(); }
      }));
      return;
    }
    const ta = h("textarea", { class: "recall", placeholder: "解答を書いてください(Ctrl+Enter で答え合わせ)" });
    if (effStage === 1) {
      work.append(h("div", { class: "hint-box" }, h("div", { class: "small muted" }, "ヒント(各文節の頭文字)"), h("div", { class: "answer" }, renderRuns(c.a, "skeleton").el)));
    }
    work.append(ta, revealButton("答え合わせ", () => {
      const g = gradeTyped(c.a, ta.value);
      cur.score = Math.round(g.score * 1000) / 1000;
      cur.suggest = suggestFromScore(g.score, g.coverage);
      ta.readOnly = true;
      revealed(after, renderDiff(g));
    }));
    return;
  }

  // タイピングしないとき: キーワード段階は赤シート、それ以降は言う・書いてから答えを見る
  if (effStage === 0) return redSheet(c.a, work, after);
  if (effStage === 1) {
    work.append(h("div", { class: "small muted" }, "頭文字をヒントに全文を言う・書く(文節クリックで個別に確認)"),
      h("div", { class: "answer" }, renderRuns(c.a, "skeleton", { peek }).el));
  } else {
    work.append(h("p", { class: "muted" }, "解答を声に出すか紙に書いてから、答えを見てください。"));
  }
  work.append(revealButton("答えを見る", () => {
    if (cur.peeks) cur.suggest = 2;
    revealed(after, cur.peeks ? h("p", { class: "small muted" }, `途中で ${cur.peeks} か所確認しました`) : null, fullAnswer());
  }));
}

function renderRiron(c, panel, work, after) {
  const cur = S.cur;
  if (!hasKeywords(c.q)) {
    panel.append(h("div", { class: "answer" }, renderRuns(c.q, "full").el));
    work.append(revealButton("確認した", () => revealed(after)));
    return;
  }
  if (cur.typing) {
    const { el, inputs } = renderRuns(c.q, "kwinput");
    panel.append(h("div", { class: "answer" }, el));
    work.append(revealButton("答え合わせ", () => {
      const score = checkInputs(inputs);
      cur.score = score;
      cur.suggest = score >= 0.999 ? 3 : score >= 0.6 ? 2 : 1;
      revealed(after, h("div", { class: "score-line" }, h("span", {}, "正解 ", h("b", {}, `${Math.round(score * inputs.length)}/${inputs.length}`))));
    }));
    inputs.forEach((inp, i) => inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.ctrlKey) { e.preventDefault(); (inputs[i + 1] || document.getElementById("reveal-btn"))?.focus(); }
    }));
    return;
  }
  redSheet(c.q, work, after);
}

function renderMaru(c, panel, work, after) {
  const cur = S.cur;
  panel.append(h("div", { class: "question", style: "font-weight:400" }, runsText(c.q)));
  const choose = (pick) => {
    if (cur.revealed) return;
    const right = pick === c.verdict;
    cur.score = right ? 1 : 0;
    cur.suggest = right ? 3 : 1;
    revealed(after,
      h("p", {}, right ? h("span", { class: "verdict-ok" }, "✓ 正解") : h("span", { class: "verdict-ng" }, "✗ 不正解"),
        ` 正解は「${c.verdict}」`),
      c.a && c.a.length ? h("div", {}, h("div", { class: "small muted" }, "正しい内容"), h("div", { class: "answer" }, renderRuns(c.a, "full").el)) : null);
  };
  cur.choose = choose;
  work.append(h("div", { class: "maru-buttons", style: "margin-top:8px" },
    h("button", { class: "btn", onclick: () => choose("〇") }, "〇"),
    h("button", { class: "btn", onclick: () => choose("×") }, "×")),
  h("p", { class: "kbd" }, "キー: O = 〇 / X = ×"));
}

function renderStudyStart(app) {
  const now = new Date();
  const dueN = DATA.cards.filter((c) => isDue(c, now)).length;
  const newN = Math.min(Math.max(0, settings().daily_new - newIntroducedToday()), newCandidates().length);
  const weak = weakCards();
  const chapterSel = h("select", {}, chapters().map((ch) =>
    h("option", { value: ch }, `第${ch}章 ${chapterTitle(ch)}${chapterUnlocked(ch) ? "" : "(未解放)"}`)));
  const typeSel = h("select", {},
    h("option", { value: "memorize" }, "要点・規定"),
    h("option", { value: "riron" }, "理論チェック"),
    h("option", { value: "maru" }, "〇×チェック"),
    h("option", { value: "all" }, "すべて"));
  const typeFilter = (v) => (c) => v === "all" || (v === "memorize" ? MEMORIZE.has(c.type) : c.type === v);

  app.append(
    h("h1", {}, "学習"),
    h("div", { class: "panel" },
      h("h2", {}, "今日の学習"),
      h("p", {}, `復習 ${dueN} 枚 + 新規 ${newN} 枚`),
      h("div", { class: "row" },
        h("button", { class: "btn primary big", onclick: () => startSession(todayQueue(), "今日の学習") }, "始める"),
        h("span", { class: "spacer" }), h("span", { class: "small muted" }, "解答方法:"), modeSelect())),
    h("div", { class: "panel" },
      h("h2", {}, "範囲を指定して練習"),
      h("p", { class: "small muted" }, "予定に関係なく、習熟度の低い順に出題します(評価は記録されます)。"),
      h("div", { class: "row" }, chapterSel, typeSel,
        h("button", { class: "btn", onclick: () => {
          const ch = Number(chapterSel.value), f = typeFilter(typeSel.value);
          startSession(practiceQueue((c) => c.chapter === ch && f(c)), `第${ch}章 ${typeSel.selectedOptions[0].text}`);
        } }, "練習する"),
        h("button", { class: "btn", onclick: () => {
          const ch = Number(chapterSel.value), f = typeFilter(typeSel.value);
          startSession(todayQueue((c) => c.chapter === ch && f(c)), `第${ch}章 今日の分`);
        } }, "この章の今日の分だけ"))),
    h("div", { class: "panel" },
      h("h2", {}, "苦手カード"),
      h("p", {}, `${weak.length} 枚(忘れたことがある・要注意フラグ・想起率 80% 未満)`),
      h("button", { class: "btn", disabled: !weak.length, onclick: () => startSession(weak.slice(0, 30).map((c) => c.id), "苦手カード") }, "苦手カードを練習(最大30枚)")));
}

function renderSessionEnd(app) {
  const mins = Math.round((Date.now() - S.startedAt) / 60000);
  const newLeft = newCandidates().length;
  if (!S.celebrated) { S.celebrated = true; confetti(); }
  const good = S.results[3] + S.results[4];
  if (S.mock) return renderMockResult(app, good);
  app.append(h("h1", {}, "おつかれさまでした"),
    h("div", { class: "panel" },
      mascot("cheer", `${S.done} 回答、${mins} 分がんばったホー!OK 以上が ${good} 回。今日思い出した分だけ、忘れにくくなっているよ。`, "lg"),
      h("p", {}, `${S.title}: ${S.done} 回答 / ${mins} 分`),
      h("div", { class: "row" }, [1, 2, 3, 4].map((g) => h("span", { class: "chip" }, `${GRADE_LABEL[g]} ${S.results[g]}`))),
      h("div", { class: "row", style: "margin-top:16px" },
        h("button", { class: "btn primary", onclick: () => { S = null; location.hash = "#/"; } }, "ホームへ"),
        h("button", { class: "btn", disabled: !newLeft, onclick: () => startSession(newCandidates().slice(0, 5).map((c) => c.id), "追加の新規") }, "新規をあと5枚"))));
}

document.addEventListener("keydown", (e) => {
  if (!S || !S.cur || currentRoute().name !== "study") return;
  const inField = /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "z" && (e.ctrlKey || e.metaKey) && !inField) { e.preventDefault(); undoLast(); return; }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    document.getElementById("reveal-btn")?.click();
    return;
  }
  if (inField) return;
  const c = BY_ID[S.cur.id];
  if (!S.cur.revealed) {
    if (c.type === "maru" && /^[oOxX]$/.test(e.key)) { S.cur.choose(/[oO]/.test(e.key) ? "〇" : "×"); return; }
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); document.getElementById("reveal-btn")?.click(); }
    return;
  }
  if (/^[1-4]$/.test(e.key)) submitGrade(Number(e.key));
  else if ((e.key === " " || e.key === "Enter") && S.cur.suggest) { e.preventDefault(); submitGrade(S.cur.suggest); }
});

// ---------- マスコット(フクロウ先生) ----------
function owlSvg(mood = "normal") {
  const ink = "#2b2350";
  const eyes = mood === "happy" || mood === "cheer"
    ? `<path d="M38 55 q10 -11 20 0 M62 55 q10 -11 20 0" stroke="${ink}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`
    : `<circle cx="48" cy="54" r="12" fill="#fff"/><circle cx="72" cy="54" r="12" fill="#fff"/>
       <circle cx="${mood === "think" ? 51 : 49}" cy="${mood === "think" ? 50 : 55}" r="6" fill="${ink}"/>
       <circle cx="${mood === "think" ? 75 : 73}" cy="${mood === "think" ? 50 : 55}" r="6" fill="${ink}"/>
       <circle cx="${mood === "think" ? 53 : 51}" cy="${mood === "think" ? 48 : 53}" r="2" fill="#fff"/>
       <circle cx="${mood === "think" ? 77 : 75}" cy="${mood === "think" ? 48 : 53}" r="2" fill="#fff"/>`;
  const leftWing = `<ellipse cx="25" cy="80" rx="10" ry="22" fill="#5a49bd" transform="rotate(12 25 80)"/>`;
  const rightWing = mood === "cheer"
    ? `<ellipse cx="100" cy="58" rx="10" ry="22" fill="#5a49bd" transform="rotate(-35 100 58)"/>`
    : `<ellipse cx="95" cy="80" rx="10" ry="22" fill="#5a49bd" transform="rotate(-12 95 80)"/>`;
  const sparkle = mood === "cheer"
    ? `<path d="M108 24 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" fill="#ffd23f"/><path d="M14 30 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" fill="#ff7ab6"/>`
    : mood === "think" ? `<text x="96" y="30" font-size="20" font-weight="700" fill="#6d5bd0">?</text>` : "";
  return `<svg viewBox="0 0 120 120" class="owl" aria-hidden="true">
    ${sparkle}${leftWing}${rightWing}
    <ellipse cx="60" cy="70" rx="37" ry="41" fill="#6d5bd0"/>
    <ellipse cx="60" cy="88" rx="22" ry="20" fill="#efe9ff"/>
    <path d="M52 84 q4 4 8 0 q4 4 8 0 M48 94 q4 4 8 0 q4 4 8 0 q4 4 8 0" stroke="#c9bdf5" stroke-width="2" fill="none"/>
    <ellipse cx="60" cy="55" rx="31" ry="21" fill="#8f7fe6"/>
    <circle cx="36" cy="66" r="5" fill="#ff8fb8" opacity=".7"/><circle cx="84" cy="66" r="5" fill="#ff8fb8" opacity=".7"/>
    ${eyes}
    <path d="M55 63 L65 63 L60 71 Z" fill="#ff9f1c"/>
    <ellipse cx="48" cy="110" rx="7" ry="4" fill="#ff9f1c"/><ellipse cx="72" cy="110" rx="7" ry="4" fill="#ff9f1c"/>
    <path d="M26 30 L60 16 L94 30 L60 44 Z" fill="${ink}"/>
    <path d="M44 37 v8 q16 7 32 0 v-8" fill="${ink}"/>
    <path d="M90 31 v15" stroke="#ffd23f" stroke-width="2.5"/><circle cx="90" cy="48" r="3.5" fill="#ffd23f"/>
  </svg>`;
}

function mascot(mood, message, size = "md") {
  return h("div", { class: `mascot mascot-${size}` },
    h("div", { class: "owl-wrap", html: owlSvg(mood) }),
    message ? h("div", { class: "bubble" }, message) : null);
}

const TIPS = [
  "覚えた直後がいちばん忘れやすいホー。翌日の復習で記憶がぐっと長持ちするよ。",
  "思い出すたびに忘れるまでの時間が延びるホー。1日→2日→6日→14日→31日と間隔を空けていくよ。",
  "答えを見る前に、まず自分で思い出してみるのがコツだホー。",
  "★★ は本試験でよく出る基本。ここを完全暗記すれば土台ができるホー。",
  "「もう一度」は恥ずかしくないホー。忘れたところこそ伸びしろだよ。",
  "キーワードは採点で見られやすい語句。まずはここを確実にするホー。",
  "声に出してすらすら言えたら本物だホー。",
];
const tipOfDay = () => TIPS[daysBetween("2026-01-01", dayKey(new Date())) % TIPS.length];

function confetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#2a78d6", "#e34948", "#eb6834", "#12a150", "#6250d6", "#eda100", "#e0559a", "#1baf7a"];
  const root = h("div", { class: "confetti", "aria-hidden": "true" });
  for (let i = 0; i < 70; i++) {
    root.append(h("i", { style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};` +
      `animation-delay:${Math.random() * 0.8}s;animation-duration:${2.4 + Math.random() * 1.6}s;` +
      `width:${6 + Math.random() * 6}px;height:${8 + Math.random() * 8}px` }));
  }
  document.body.append(root);
  setTimeout(() => root.remove(), 5000);
}

// ---------- 忘却曲線 ----------
const recallAt = (days, interval) => Math.pow(TARGET_RECALL, Math.max(0, days) / Math.max(1, interval));

function forgettingPanel() {
  const D = 60, W = 1040, H = 220, padL = 40, padR = 12, padT = 12, padB = 26;
  const x = (t) => padL + (t / D) * (W - padL - padR);
  const y = (r) => H - padB - r * (H - padT - padB);
  // このツールの復習タイミング(卒業後 1・2・6・14・31 日間隔)
  const reviews = [0];
  for (const d of [...LADDER, 31 * 2.5]) reviews.push(reviews[reviews.length - 1] + d);
  const ivls = [...LADDER, 31 * 2.5];
  const toolAt = (t) => {
    let i = 0;
    while (i + 1 < reviews.length && reviews[i + 1] <= t) i++;
    return recallAt(t - reviews[i], ivls[Math.min(i, ivls.length - 1)]);
  };
  const noReview = (t) => recallAt(t, 1);
  const path = (f) => Array.from({ length: D * 4 + 1 }, (_, i) => i / 4).map((t, i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(f(t)).toFixed(1)}`).join("");
  // 復習直後は 100% に戻るので、復習日の直前の値と直後の値を縦線でつなぐ
  const toolPath = Array.from({ length: D * 4 + 1 }, (_, i) => i / 4).map((t) => {
    const at = reviews.find((r) => r > 0 && Math.abs(r - t) < 0.125);
    return at ? `L${x(t).toFixed(1)},${y(toolAt(t - 0.01)).toFixed(1)} L${x(t).toFixed(1)},${y(1).toFixed(1)}` : `L${x(t).toFixed(1)},${y(toolAt(t)).toFixed(1)}`;
  }).join("").replace(/^L/, "M");

  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "忘却曲線: 復習しない場合とこのツールの復習タイミング" });
  [0, 0.5, 0.9, 1].forEach((r) => {
    chart.append(svg("line", { x1: padL, x2: W - padR, y1: y(r), y2: y(r), stroke: "var(--border)", "stroke-dasharray": r === 0.9 ? "4 4" : null }));
    chart.append(svg("text", { x: 0, y: y(r) + 4 }, `${Math.round(r * 100)}%`));
  });
  [0, 10, 20, 30, 40, 50, 60].forEach((t) => chart.append(svg("text", { x: x(t), y: H - 6, "text-anchor": "middle" }, t ? `${t}日` : "卒業")));
  chart.append(svg("path", { d: path(noReview), fill: "none", stroke: "var(--muted)", "stroke-width": 2, "stroke-dasharray": "6 4" }));
  chart.append(svg("path", { d: toolPath, fill: "none", stroke: "var(--c-blue)", "stroke-width": 2, "stroke-linejoin": "round" }));
  reviews.filter((r) => r > 0 && r <= D).forEach((r) =>
    chart.append(svg("circle", { cx: x(r), cy: y(1), r: 4, fill: "var(--c-blue)", stroke: "var(--surface)", "stroke-width": 2 })));
  const cross = svg("line", { y1: padT, y2: H - padB, stroke: "var(--text-2)", visibility: "hidden" });
  const hit = svg("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
  hit.addEventListener("mousemove", (e) => {
    const r = chart.getBoundingClientRect();
    const t = Math.max(0, Math.min(D, Math.round(((((e.clientX - r.left) / r.width) * W - padL) / (W - padL - padR)) * D)));
    cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t)); cross.setAttribute("visibility", "visible");
    showTip(e, `卒業から ${t} 日<br>復習あり ${Math.round(toolAt(t) * 100)}%<br>復習なし ${Math.round(noReview(t) * 100)}%`);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  chart.append(cross, hit);

  // 自分のカードで復習を止めた場合の予測
  const now = new Date();
  const mine = memorizeCards().filter((c) => st(c.id).status === "review");
  const avgAfter = (days) => mine.reduce((a, c) => {
    const s = st(c.id);
    const elapsed = (now - new Date(s.last_review)) / DAY_MS;
    return a + recallAt(elapsed + days, s.interval);
  }, 0) / mine.length;

  return h("div", { class: "panel" },
    h("h2", {}, "忘却曲線と復習のタイミング"),
    h("p", { class: "small muted" }, "記憶は覚えた直後から急に薄れていきます(エビングハウスの忘却曲線)。思い出すたびに忘れにくくなるので、想起率が 90% まで下がる頃に復習します。点が復習日です。"),
    chart,
    h("div", { class: "legend" },
      h("span", {}, h("i", { class: "mdot", style: "background:var(--c-blue)" }), "このツールの復習(1→2→6→14→31日)"),
      h("span", {}, h("i", { class: "mdot", style: "background:transparent;border-top:2px dashed var(--muted);border-radius:0;height:0" }), "復習しない場合")),
    mine.length ? h("p", { class: "small", style: "margin:8px 0 0" },
      `あなたの復習中のカード ${mine.length} 枚: 今の想起率(推定)は平均 ${Math.round(avgAfter(0) * 100)}%。復習を止めると 1 週間後に ${Math.round(avgAfter(7) * 100)}%、2 週間後に ${Math.round(avgAfter(14) * 100)}% まで下がる見込みです。`) : null);
}

// カード 1 枚の記憶の推移(のこぎり形の忘却曲線)
function cardCurve(c) {
  const entries = DATA.log.filter((e) => e[1] === c.id);
  const firstGrad = entries.findIndex((e) => (e[7] || 0) >= 1);
  if (firstGrad < 0) return h("p", { class: "small muted" }, "白紙から再現できる(卒業する)と、このカードの忘却曲線が表示されます。");
  const now = Date.now();
  const t0 = new Date(entries[firstGrad][0]).getTime();
  const last = entries[entries.length - 1];
  const end = Math.max(now, new Date(last[0]).getTime() + Math.max(7, last[7] || 1) * DAY_MS);
  const W = 640, H = 130, padL = 34, padR = 8, padT = 8, padB = 20;
  const x = (t) => padL + ((t - t0) / Math.max(DAY_MS, end - t0)) * (W - padL - padR);
  const y = (r) => H - padB - r * (H - padT - padB);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "このカードの想起率の推移" });
  [0, 0.9, 1].forEach((r) => {
    chart.append(svg("line", { x1: padL, x2: W - padR, y1: y(r), y2: y(r), stroke: "var(--border)", "stroke-dasharray": r === 0.9 ? "4 4" : null }));
    chart.append(svg("text", { x: 0, y: y(r) + 4 }, `${Math.round(r * 100)}%`));
  });
  let d = "";
  entries.slice(firstGrad).forEach((e, i, arr) => {
    const ivl = e[7] || 0;
    const ts = new Date(e[0]).getTime();
    if (ivl < 1) return; // 学習中(再学習中)の間は曲線を描かない
    const segEnd = i + 1 < arr.length ? new Date(arr[i + 1][0]).getTime() : end;
    for (let k = 0; k <= 30; k++) {
      const t = ts + ((segEnd - ts) * k) / 30;
      d += `${k === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(recallAt((t - ts) / DAY_MS, ivl)).toFixed(1)}`;
    }
  });
  chart.append(svg("path", { d, fill: "none", stroke: "var(--c-blue)", "stroke-width": 2 }));
  chart.append(svg("line", { x1: x(now), x2: x(now), y1: padT, y2: H - padB, stroke: "var(--text-2)", "stroke-dasharray": "2 3" }));
  chart.append(svg("text", { x: x(now), y: H - 6, "text-anchor": "middle" }, "今日"));
  chart.append(svg("text", { x: padL, y: H - 6 }, fmtDay(dayKey(t0))));
  const gradeColor = { 1: "var(--c-red)", 2: "var(--c-orange)", 3: "var(--c-green)", 4: "var(--c-blue)" };
  entries.slice(firstGrad).forEach((e) => {
    const ts = new Date(e[0]).getTime();
    const dot = svg("circle", { cx: x(ts), cy: y(1), r: 5, fill: gradeColor[e[2]], stroke: "var(--surface)", "stroke-width": 2 });
    tipOn(dot, `${e[0].replace("T", " ").slice(0, 16)}<br>評価: ${GRADE_LABEL[e[2]]}` + ((e[7] || 0) >= 1 ? `<br>次の間隔 ${Math.round(e[7])} 日` : "<br>再学習へ"));
    chart.append(dot);
  });
  return h("div", {}, h("div", { class: "small muted" }, "このカードの忘却曲線(点 = 復習した日。色は評価)"), chart);
}

// ---------- ダッシュボード ----------
function memorizeCards(onlyUnlocked = true) {
  return DATA.cards.filter((c) => MEMORIZE.has(c.type) && !st(c.id).suspended && (!onlyUnlocked || unlocked(c)));
}

function streakDays() {
  const days = new Set(DATA.log.map((e) => dayKey(e[0])));
  let d = dayKey(new Date());
  if (!days.has(d)) d = addDays(d, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

function tile(label, value, sub, tone) {
  return h("div", { class: `tile tone-${tone}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);
}

const mColor = (m) => `var(--m${m})`;
function masteryLegend() {
  return h("div", { class: "legend" }, MASTERY_LABEL.map((l, i) => h("span", {}, h("i", { class: "mdot", style: `background:${mColor(i)}` }), l)));
}

function renderHome(app) {
  const now = new Date();
  const today = dayKey(now);
  const mem = memorizeCards();
  const due = DATA.cards.filter((c) => isDue(c, now));
  const newN = Math.min(Math.max(0, settings().daily_new - newIntroducedToday()), newCandidates().length);
  const fixed = mem.filter((c) => st(c.id).mastery >= 4).length;
  const recallAvg = mem.length ? mem.reduce((a, c) => a + st(c.id).recall, 0) / mem.length : 0;
  const examDays = daysBetween(today, settings().exam_date);
  const twoStar = mem.filter((c) => c.stars === 2);
  const twoStarFixed = twoStar.filter((c) => st(c.id).mastery >= 4).length;
  const doneToday = DATA.log.filter((e) => dayKey(e[0]) === today).length;

  const remaining = due.length + newN;
  const streak = streakDays();
  let mood, msg;
  if (remaining === 0 && doneToday > 0) { mood = "cheer"; msg = "今日の分はおしまい!忘却曲線に勝ったホー。また明日ね。"; }
  else if (remaining === 0) { mood = "normal"; msg = "今日の出題はないホー。講義を受けたら、設定の「受講済みの講義」を進めてね。"; }
  else if (doneToday === 0) { mood = "normal"; msg = `今日は ${remaining} 枚だホー。忘れかけている復習から片付けよう!`; }
  else { mood = "happy"; msg = `あと ${remaining} 枚!その調子だホー。`; }
  if (streak >= 2) msg += ` ${streak} 日連続、えらい!`;

  app.append(
    h("div", { class: "hero" },
      mascot(mood, h("div", {}, h("div", { class: "bubble-main" }, msg), h("div", { class: "bubble-tip" }, `ひとこと: ${tipOfDay()}`)), "lg"),
      h("div", { class: "hero-side" },
        h("button", { class: "btn primary big", onclick: () => startSession(todayQueue(), "今日の学習") },
          `今日の学習を始める(${remaining} 枚)`),
        testShortcut())),
    h("div", { class: "tiles" },
      tile("今日の残り", `${due.length + newN}`, `復習 ${due.length} / 新規 ${newN} ・ 今日 ${doneToday} 回答済み`, "blue"),
      tile("試験まで", `${examDays} 日`, `${settings().exam_date}(設定で変更)`, "red"),
      tile("連続学習", `${streakDays()} 日`, null, "orange"),
      tile("定着(要点・規定)", `${mem.length ? Math.round((fixed / mem.length) * 100) : 0}%`, `${fixed}/${mem.length} 枚 ・ ★★ ${twoStarFixed}/${twoStar.length}`, "green"),
      tile("今テストしたら(推定)", `${Math.round(recallAvg * 100)}%`, "解放済みの要点・規定を思い出せる確率の平均", "violet")),
    heatmapPanel(),
    h("div", { class: "grid grid-2" }, starPanel(mem), forecastPanel()),
    forgettingPanel(),
    pacePanel(),
    h("div", { class: "grid grid-2" }, calendarPanel(), weakPanel()),
    chapterTablePanel());
}

function heatmapPanel() {
  let filterKey;
  try { filterKey = localStorage.getItem("heatFilter") || "memorize"; } catch { filterKey = "memorize"; }
  const filters = { memorize: ["要点・規定", (c) => MEMORIZE.has(c.type)], riron: ["理論チェック", (c) => c.type === "riron"], maru: ["〇×", (c) => c.type === "maru"] };
  const body = h("div", {});
  const draw = () => {
    const f = filters[filterKey][1];
    const grid = h("div", { class: "heat" });
    for (const ch of chapters()) {
      const cards = DATA.cards.filter((c) => c.chapter === ch && f(c) && !st(c.id).suspended);
      if (!cards.length) continue;
      const locked = !chapterUnlocked(ch);
      grid.append(h("div", { class: "chap" + (locked ? " locked" : "") }, `${ch}. ${chapterTitle(ch)}`));
      grid.append(h("div", { class: "cells" + (locked ? " locked" : "") }, cards.map((c) => {
        const s = st(c.id);
        return tipOn(h("div", { class: "cell", style: `background:${mColor(s.mastery)}`, onclick: () => { hideTip(); location.hash = `#/list?card=${encodeURIComponent(c.id)}`; } }),
          () => `<b>${esc(c.id)}</b> ${starsText(c.stars)} ${TYPE_LABEL[c.type]}<br>${esc(runsText(c.q).slice(0, 80))}<br>${MASTERY_LABEL[s.mastery]}` +
            (s.due && s.status !== "new" ? ` ・ 次回 ${fmtDay(dayKey(s.due))}` : "") + (s.status === "review" ? ` ・ 想起率 ${Math.round(s.recall * 100)}%` : ""));
      })));
    }
    body.replaceChildren(grid);
  };
  const chips = h("div", { class: "row" }, Object.entries(filters).map(([k, [label]]) =>
    h("button", { class: "chip" + (k === filterKey ? " on" : ""), onclick: (e) => {
      filterKey = k;
      try { localStorage.setItem("heatFilter", k); } catch { /* 無視 */ }
      chips.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === e.currentTarget));
      draw();
    } }, label)));
  draw();
  return h("div", { class: "panel" },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, "章別の習熟度マップ"), h("span", { class: "spacer" }), chips),
    h("p", { class: "small muted" }, "1 マス = 1 枚。濃いほど定着しています。クリックでカードを開きます。"),
    body, masteryLegend());
}

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

function starPanel(mem) {
  const rows = [[2, "★★"], [1, "★"], [0, "無印"]];
  const W = 520, rowH = 30, labelW = 44, rightW = 96, barW = W - labelW - rightW;
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${rows.length * (rowH + 10)}`, role: "img", "aria-label": "★ランク別の習熟度" });
  rows.forEach(([n, label], ri) => {
    const cards = mem.filter((c) => c.stars === n);
    const y = ri * (rowH + 10);
    chart.append(svg("text", { x: 0, y: y + rowH / 2 + 4 }, label));
    let x = labelW;
    for (let m = 5; m >= 0; m--) {
      const cnt = cards.filter((c) => st(c.id).mastery === m).length;
      if (!cnt) continue;
      const w = (cnt / cards.length) * barW;
      const rect = svg("rect", { x: x + 1, y, width: Math.max(0, w - 2), height: rowH, rx: 3, fill: mColor(m) });
      tipOn(rect, `${label} ・ ${MASTERY_LABEL[m]}<br>${cnt} 枚(${Math.round((cnt / cards.length) * 100)}%)`);
      chart.append(rect);
      x += w;
    }
    const fixed = cards.filter((c) => st(c.id).mastery >= 4).length;
    chart.append(svg("text", { x: W - rightW + 8, y: y + rowH / 2 + 4 }, `定着 ${cards.length ? Math.round((fixed / cards.length) * 100) : 0}% (${cards.length})`));
  });
  return h("div", { class: "panel" }, h("h2", {}, "重要度(★)別の習熟度"), h("p", { class: "small muted" }, "解放済みの要点・規定。★★から完全暗記を目指します。"), chart, masteryLegend());
}

function forecastPanel() {
  const today = dayKey(new Date());
  const N = 14;
  const counts = new Array(N).fill(0);
  for (const c of DATA.cards) {
    const s = st(c.id);
    if (s.suspended || s.status === "new" || !s.due) continue;
    const k = s.status === "learning" ? today : dayKey(s.due);
    const i = Math.max(0, daysBetween(today, k));
    if (i < N) counts[i]++;
  }
  const W = 520, H = 170, padL = 28, padB = 22, padT = 16;
  const max = Math.max(5, ...counts);
  const bw = (W - padL) / N;
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "今後14日の復習予定枚数" });
  const yScale = (v) => H - padB - (v / max) * (H - padB - padT);
  [0, Math.round(max / 2), max].forEach((v) => {
    chart.append(svg("line", { x1: padL, x2: W, y1: yScale(v), y2: yScale(v), stroke: "var(--border)" }));
    chart.append(svg("text", { x: 0, y: yScale(v) + 4 }, v));
  });
  counts.forEach((v, i) => {
    const x = padL + i * bw + 3, key = addDays(today, i);
    const bar = svg("rect", { x, y: yScale(v), width: bw - 6, height: Math.max(0, H - padB - yScale(v)), rx: 3, fill: "var(--m3)" });
    const hit = svg("rect", { x: padL + i * bw, y: padT, width: bw, height: H - padB - padT, fill: "transparent" });
    tipOn(hit, `${fmtDay(key)}${i === 0 ? "(今日・期限切れ含む)" : ""}<br>復習 ${v} 枚`);
    chart.append(bar, hit);
    if (i % 2 === 0) chart.append(svg("text", { x: x + (bw - 6) / 2, y: H - 6, "text-anchor": "middle" }, i === 0 ? "今日" : fmtDay(key)));
  });
  return h("div", { class: "panel" }, h("h2", {}, "今後14日の復習予定"), h("p", { class: "small muted" }, "新規を増やしすぎると数日後の復習が膨らみます。"), chart);
}

function graduationSeries() {
  // 白紙から再現できた(卒業した)要点・規定の累計
  const seen = new Set(), byDay = new Map();
  for (const e of DATA.log) {
    const [ts, id, grade, stage, before] = e;
    const c = BY_ID[id];
    if (!c || !MEMORIZE.has(c.type) || seen.has(id)) continue;
    if (before !== "review" && stage === 2 && grade >= 3) {
      seen.add(id);
      const k = dayKey(ts);
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }
  }
  return byDay;
}

function pacePanel() {
  const today = dayKey(new Date());
  const exam = settings().exam_date;
  const goal = addDays(exam, -90);
  const total = DATA.cards.filter((c) => MEMORIZE.has(c.type)).length;
  const byDay = graduationSeries();
  const first = DATA.log.length ? dayKey(DATA.log[0][0]) : today;
  const start = first < today ? first : today;
  const span = Math.max(1, daysBetween(start, exam));
  let cum = 0;
  const actual = [];
  for (let i = 0; i <= daysBetween(start, today); i++) {
    const k = addDays(start, i);
    cum += byDay.get(k) || 0;
    actual.push([k, cum]);
  }
  const recent = [...byDay.entries()].filter(([k]) => daysBetween(k, today) < 14).reduce((a, [, v]) => a + v, 0) / 14;
  const remaining = total - cum;
  const finish = recent > 0 ? addDays(today, Math.ceil(remaining / recent)) : null;
  const needPerDay = daysBetween(today, goal) > 0 ? remaining / daysBetween(today, goal) : remaining;

  const W = 1040, H = 220, padL = 36, padR = 12, padT = 12, padB = 24;
  const x = (k) => padL + (daysBetween(start, k) / span) * (W - padL - padR);
  const y = (v) => H - padB - (v / total) * (H - padT - padB);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "卒業カード数の累計と目標ペース" });
  [0, 0.5, 1].forEach((f) => {
    chart.append(svg("line", { x1: padL, x2: W - padR, y1: y(total * f), y2: y(total * f), stroke: "var(--border)" }));
    chart.append(svg("text", { x: 0, y: y(total * f) + 4 }, Math.round(total * f)));
  });
  // 月の目盛り
  for (let i = 0; i <= span; i++) {
    const k = addDays(start, i);
    if (k.endsWith("-01")) chart.append(svg("text", { x: x(k), y: H - 6, "text-anchor": "middle" }, `${Number(k.slice(5, 7))}月`));
  }
  chart.append(svg("line", { x1: x(start), y1: y(0), x2: x(goal), y2: y(total), stroke: "var(--muted)", "stroke-width": 2, "stroke-dasharray": "6 4" }));
  chart.append(svg("line", { x1: x(exam), x2: x(exam), y1: padT, y2: H - padB, stroke: "var(--critical)", "stroke-width": 1 }));
  chart.append(svg("text", { x: x(exam) - 4, y: padT + 10, "text-anchor": "end" }, "試験"));
  chart.append(svg("polyline", { points: actual.map(([k, v]) => `${x(k)},${y(v)}`).join(" "), fill: "none", stroke: "var(--m3)", "stroke-width": 2, "stroke-linejoin": "round" }));
  const last = actual[actual.length - 1];
  chart.append(svg("circle", { cx: x(last[0]), cy: y(last[1]), r: 4, fill: "var(--m3)", stroke: "var(--surface)", "stroke-width": 2 }));
  chart.append(svg("text", { x: x(last[0]) + 8, y: y(last[1]) - 6 }, `${last[1]} 枚`));
  // ホバーで日付ごとの値
  const cross = svg("line", { y1: padT, y2: H - padB, stroke: "var(--text-2)", "stroke-width": 1, visibility: "hidden" });
  const hit = svg("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
  hit.addEventListener("mousemove", (e) => {
    const r = chart.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((fx - padL) / (W - padL - padR)) * span);
    const k = addDays(start, Math.max(0, Math.min(span, i)));
    const a = actual.find(([d]) => d === k);
    const target = Math.min(total, Math.round((total * Math.max(0, daysBetween(start, k))) / Math.max(1, daysBetween(start, goal))));
    cross.setAttribute("x1", x(k)); cross.setAttribute("x2", x(k)); cross.setAttribute("visibility", "visible");
    showTip(e, `${k}<br>目標ペース ${target} 枚` + (a ? `<br>実績 ${a[1]} 枚` : ""));
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  chart.append(cross, hit);

  return h("div", { class: "panel" },
    h("h2", {}, "一巡目の進み具合(白紙から再現できた要点・規定の累計)"),
    h("p", { class: "small muted" },
      `目標: 試験 90 日前(${goal})までに全 ${total} 枚を一巡し、残りを反復に充てる。残り ${remaining} 枚 → 1 日あたり ${needPerDay.toFixed(1)} 枚必要。` +
      (finish ? ` 直近 14 日のペース(${recent.toFixed(1)} 枚/日)だと ${finish} に一巡します。` : "")),
    chart,
    h("div", { class: "legend" },
      h("span", {}, h("i", { class: "mdot", style: "background:var(--m3)" }), "実績"),
      h("span", {}, h("i", { class: "mdot", style: "background:transparent;border-top:2px dashed var(--muted);border-radius:0;height:0" }), "目標ペース"),
      h("span", {}, h("i", { class: "mdot", style: "background:var(--critical);width:2px" }), "試験日")));
}

function calendarPanel() {
  const today = dayKey(new Date());
  const weeks = 20;
  const per = new Map();
  for (const e of DATA.log) {
    const k = dayKey(e[0]);
    const p = per.get(k) || { n: 0, ok: 0, ms: 0 };
    p.n++; if (e[2] >= 3) p.ok++; p.ms += e[6] || 0;
    per.set(k, p);
  }
  const vals = [...per.values()].map((p) => p.n).sort((a, b) => a - b);
  const q = (f) => vals.length ? vals[Math.floor((vals.length - 1) * f)] : 1;
  const level = (n) => !n ? 0 : n <= q(0.2) ? 1 : n <= q(0.45) ? 2 : n <= q(0.7) ? 3 : n <= q(0.9) ? 4 : 5;
  const todayDow = (new Date(today + "T12:00").getDay() + 6) % 7; // 月曜=0
  const startKey = addDays(today, -(weeks - 1) * 7 - todayDow);
  const cell = 14, gap = 3;
  const W = 24 + weeks * (cell + gap), H = 7 * (cell + gap) + 16;
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "学習カレンダー" });
  ["月", "", "水", "", "金", "", "日"].forEach((d, i) => d && chart.append(svg("text", { x: 0, y: 16 + i * (cell + gap) + 10 }, d)));
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const k = addDays(startKey, w * 7 + d);
      if (k > today) continue;
      if (d === 0 && Number(k.slice(8)) <= 7) chart.append(svg("text", { x: 24 + w * (cell + gap), y: 10 }, `${Number(k.slice(5, 7))}月`));
      const p = per.get(k);
      const r = svg("rect", { x: 24 + w * (cell + gap), y: 16 + d * (cell + gap), width: cell, height: cell, rx: 2, fill: `var(--seq${level(p?.n || 0)})` });
      tipOn(r, `${k}<br>` + (p ? `${p.n} 回答 ・ OK以上 ${Math.round((p.ok / p.n) * 100)}% ・ ${Math.round(p.ms / 60000)} 分` : "学習なし"));
      chart.append(r);
    }
  }
  return h("div", { class: "panel" }, h("h2", {}, "学習カレンダー"), chart);
}

function weakPanel() {
  const weak = weakCards().slice(0, 8);
  return h("div", { class: "panel" },
    h("div", { class: "row" }, h("h2", { style: "margin:0" }, "苦手カード"), h("span", { class: "spacer" }),
      h("button", { class: "btn", disabled: !weak.length, onclick: () => startSession(weakCards().slice(0, 30).map((c) => c.id), "苦手カード") }, "練習する")),
    weak.length ? h("div", {}, weak.map((c) => {
      const s = st(c.id);
      return h("div", { class: "card-row" }, h("div", { class: "line", onclick: () => { location.hash = `#/list?card=${encodeURIComponent(c.id)}`; } },
        h("i", { class: "mdot", style: `background:${mColor(s.mastery)}` }),
        h("span", { class: "qtext" }, runsText(c.q)),
        h("span", { class: "small muted" }, s.flagged ? "要注意 " : "", s.lapses ? `忘却${s.lapses}回` : `想起${Math.round(s.recall * 100)}%`)));
    })) : h("p", { class: "muted small" }, "まだありません。"));
}

function chapterTablePanel() {
  const rows = chapters().map((ch) => {
    const cards = DATA.cards.filter((c) => c.chapter === ch && MEMORIZE.has(c.type) && !st(c.id).suspended);
    const m = (f) => cards.filter((c) => f(st(c.id).mastery)).length;
    const recall = cards.length ? cards.reduce((a, c) => a + st(c.id).recall, 0) / cards.length : 0;
    return h("tr", {},
      h("td", {}, `${ch}. ${chapterTitle(ch)}${chapterUnlocked(ch) ? "" : "(未解放)"}`),
      h("td", {}, cards.length), h("td", {}, m((x) => x === 0)), h("td", {}, m((x) => x === 1 || x === 2)),
      h("td", {}, m((x) => x === 3)), h("td", {}, m((x) => x >= 4)),
      h("td", {}, cards.length ? `${Math.round((m((x) => x >= 4) / cards.length) * 100)}%` : "-"),
      h("td", {}, `${Math.round(recall * 100)}%`));
  });
  return h("details", { class: "panel" },
    h("summary", { style: "cursor:pointer;font-weight:600" }, "章別の集計表(要点・規定)"),
    h("table", { class: "data" },
      h("thead", {}, h("tr", {}, ["章", "枚数", "未学習", "学習中", "再現できた", "定着", "定着率", "想起率"].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows)));
}

// ---------- ミニテスト・確認テスト対策 ----------
// テストの範囲は学習計画表のミニテスト欄(テストを行う回の 1 回前と 2 回前の講義)
const lectureLabel = (n) => DATA.schedule?.lectures.find((l) => l.no === n)?.label || "講義計画なし";
const scheduledTest = (n) => DATA.schedule?.tests.find((t) => t.lecture === n);
const nextTest = () => DATA.schedule?.tests.find((t) => t.lecture > settings().lectures_done);

function testRange() {
  const t = settings().mini_test || {};
  const lecture = t.lecture || nextTest()?.lecture || null;
  if (!lecture) return { lecture: null, date: t.date, lectures: [] };
  const sched = scheduledTest(lecture);
  const auto = sched ? sched.range : [lecture - 2, lecture - 1].filter((n) => n > 0);
  return {
    lecture, date: t.date, auto,
    lectures: t.lectures || auto,
    custom: !!t.lectures,
    name: sched?.name || `第${lecture}講のテスト`,
    estimated: !!sched?.estimated,
  };
}

async function saveMiniTest(patch) {
  DATA.settings = await api("/api/settings", { mini_test: { ...settings().mini_test, ...patch } });
}

// テスト本番で書ける状態: 復習に入っていて、今の想起率(推定)が 85% 以上
const isReady = (c) => st(c.id).status === "review" && st(c.id).recall >= 0.85;

// 仕上げる順: 学習途中 → 忘れかけ(想起率の低い順) → 未学習(★の多い順)
function testOrder(cards) {
  const rank = (c) => {
    const s = st(c.id);
    if (s.status === "learning") return [0, s.stage, ORDER[c.id]];
    if (s.status === "review") return [1, s.recall, ORDER[c.id]];
    return [2, -c.stars, ORDER[c.id]];
  };
  return [...cards].sort((a, b) => {
    const ka = rank(a), kb = rank(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  }).map((c) => c.id);
}

function mockSample(cards, n = 10) {
  // ★が多いほど選ばれやすい重み付き抽選
  const pool = cards.map((c) => ({ c, w: c.stars + 1 }));
  const out = [];
  while (out.length < n && pool.length) {
    let r = Math.random() * pool.reduce((a, p) => a + p.w, 0);
    const i = pool.findIndex((p) => (r -= p.w) <= 0);
    out.push(pool.splice(i < 0 ? pool.length - 1 : i, 1)[0].c.id);
  }
  return out;
}

function testShortcut() {
  const t = testRange();
  const label = t.lecture
    ? `${t.name} 対策` + (t.date ? `(あと ${daysBetween(dayKey(new Date()), t.date)} 日)` : "")
    : "ミニテスト対策";
  return h("a", { class: "btn test-btn", href: "#/test" }, label);
}

function renderTest(app) {
  const t = testRange();
  const today = dayKey(new Date());
  const tests = DATA.schedule?.tests || [];
  const testSel = h("select", {
    onchange: async (e) => { await saveMiniTest({ lecture: Number(e.target.value) || null, lectures: null }); render(); },
  },
  tests.map((x) => h("option", { value: x.lecture }, `第${x.lecture}講 ${x.name}(範囲: 第${x.range.join("・")}講)`)),
  h("option", { value: "" }, "その他(講義回を入力)"));
  const isScheduled = tests.some((x) => x.lecture === t.lecture);
  testSel.value = isScheduled ? String(t.lecture) : "";
  const lectureInput = h("input", { type: "number", min: 3, max: 60, value: t.lecture ?? "", style: "width:5em",
    onchange: async (e) => { await saveMiniTest({ lecture: Number(e.target.value) || null, lectures: null }); render(); } });
  const dateInput = h("input", { type: "date", value: t.date || "",
    onchange: async (e) => { await saveMiniTest({ date: e.target.value || null }); render(); } });
  const maxLecture = Math.max(24, ...(DATA.schedule?.lectures || []).map((l) => l.no));
  const setup = h("div", { class: "panel" },
    h("h2", {}, "テストの設定"),
    h("div", { class: "row" }, "テスト", testSel,
      isScheduled ? null : h("span", {}, "第", lectureInput, "講"),
      h("span", { style: "width:16px" }), "テスト日", dateInput),
    t.lecture ? h("div", { class: "small", style: "margin-top:8px" },
      t.lectures.map((n) => h("div", {}, h("b", {}, `第${n}講: `), lectureLabel(n),
        n > settings().lectures_done ? h("span", { class: "chip", style: "margin-left:6px" }, "未受講のため出題しない") : null))) : null,
    t.estimated ? h("p", { class: "small muted" }, "このテストはまだ学習計画表に載っていないため、「1 回前と 2 回前の講義」から推定した範囲です。") : null,
    t.lecture ? h("div", { class: "row", style: "margin-top:8px" }, h("span", { class: "small muted" }, "範囲の講義を直接選ぶ:"),
      Array.from({ length: maxLecture }, (_, i) => i + 1).map((n) => h("button", {
        class: "chip" + (t.lectures.includes(n) ? " on" : ""),
        title: lectureLabel(n),
        onclick: async () => {
          const next = t.lectures.includes(n) ? t.lectures.filter((x) => x !== n) : [...t.lectures, n].sort((a, b) => a - b);
          await saveMiniTest({ lectures: next }); render();
        },
      }, `${n}講`)),
      t.custom ? h("button", { class: "btn", onclick: async () => { await saveMiniTest({ lectures: null }); render(); } }, "計画どおりの範囲に戻す") : null) : null);

  const inRange = DATA.cards.filter((c) => c.lecture != null && t.lectures.includes(c.lecture) && !st(c.id).suspended);
  // まだ受講していない講義の分は出題しない(設定の「受講済みの講義」を進めると対象に加わる)
  const range = inRange.filter(unlocked);
  const pendingLectures = t.lectures.filter((n) => n > settings().lectures_done);
  const pendingNote = inRange.length > range.length
    ? h("p", { class: "small notice" }, `第${pendingLectures.join("・")}講はまだ受講前なので出題しません(${inRange.length - range.length} 枚)。受講したら設定の「受講済みの講義」を進めてください。`)
    : null;
  if (!t.lecture || !range.length) {
    app.append(h("h1", {}, "ミニテスト・確認テスト対策"),
      h("div", { class: "hero" }, mascot("normal", h("div", {},
        h("div", { class: "bubble-main" }, !t.lecture ? "次のテストを選んでほしいホー。"
          : inRange.length ? "範囲の講義をまだ受講していないホー。受講したら一緒に仕上げよう!" : "この範囲には理論のカードがないホー。"),
        h("div", { class: "bubble-tip" }, "範囲は、テストの 1 回前と 2 回前の講義で習った理論だよ。毎日の 20 枚とは別に集中して仕上げられるホー。")), "lg")),
      setup);
    return;
  }

  const mem = range.filter((c) => MEMORIZE.has(c.type));
  const kitei = mem.filter((c) => c.type === "kitei");
  const checks = range.filter((c) => c.type === "riron" || c.type === "maru");
  const ready = mem.filter(isReady);
  const notReady = mem.filter((c) => !isReady(c));
  const newCount = mem.filter((c) => st(c.id).status === "new").length;
  const pct = mem.length ? Math.round((ready.length / mem.length) * 100) : 0;
  const daysLeft = t.date ? daysBetween(today, t.date) : null;
  const perDay = daysLeft && daysLeft > 0 ? Math.ceil(notReady.length / daysLeft) : notReady.length;

  let mood = "normal", msg;
  if (pct >= 90) { mood = "cheer"; msg = `範囲の ${pct}% が仕上がっているホー!あとは模擬テストで確認しよう。`; }
  else if (pct >= 50) { mood = "happy"; msg = `範囲の ${pct}% が仕上がっているホー。残り ${notReady.length} 枚!`; }
  else msg = `${t.name}の範囲は ${mem.length} 枚、仕上がりは ${pct}% だホー。★★から片付けよう!`;
  const plan = daysLeft == null ? "テスト日を入れると、1 日に何枚やればいいか計算するホー。"
    : daysLeft < 0 ? "このテストは終わったみたい。次のテストに切り替えてね。"
    : daysLeft === 0 ? "今日がテスト!模擬テストで最終確認だホー。"
    : `テストまであと ${daysLeft} 日。1 日 ${perDay} 枚ずつ仕上げれば間に合うホー。`;

  const title = t.name;
  const actions = [
    ["primary", `まだ仕上がっていないカード(${notReady.length} 枚)`, "学習途中 → 忘れかけ → 未学習(★の多い順)の順に出します",
      notReady, () => startSession(testOrder(notReady), `${title} 対策`, { context: "test" })],
    ["", `範囲をひととおり(${mem.length} 枚)`, "仕上がったカードも含めて全部",
      mem, () => startSession(testOrder(mem), `${title} 範囲`, { context: "test" })],
    ["", `規定だけ(${kitei.length} 枚)`, "穴埋め対策。赤字を一言一句",
      kitei, () => startSession(testOrder(kitei), `${title} 規定`, { context: "test" })],
    ["", `〇×・理論チェック(${checks.length} 問)`, "問題文の読み取りと知識の確認(章が終わった講義に含まれます)",
      checks, () => startSession(testOrder(checks), `${title} 〇×・理論チェック`, { context: "test" })],
    ["mock", `模擬テスト(${Math.min(10, mem.length)} 問)`, "★の多い問題から抽選。全問「白紙から」で出題し、最後に得点を出します",
      mem, () => startSession(mockSample(mem, 10), `${title} 模擬テスト`, { context: "test", mock: true })],
  ];

  app.append(
    h("h1", {}, `${t.name} 対策`),
    h("div", { class: "hero" }, mascot(mood, h("div", {}, h("div", { class: "bubble-main" }, msg), h("div", { class: "bubble-tip" }, plan)), "lg")),
    h("div", { class: "tiles" },
      tile("テスト範囲", `第${t.lectures.join("・")}講`, [...new Set(range.map((c) => c.chapter))].sort((a, b) => a - b).map((c) => `第${c}章`).join("・"), "blue"),
      tile("テストまで", daysLeft == null ? "-" : `${daysLeft} 日`, t.date || "テスト日を設定してください", "red"),
      tile("仕上がり", `${pct}%`, `${ready.length}/${mem.length} 枚(想起率 85% 以上)`, "green"),
      tile("未学習", `${newCount} 枚`, "範囲内でまだ一度も解いていない", "orange"),
      tile("1日の目安", daysLeft && daysLeft > 0 ? `${perDay} 枚` : "-", "毎日の 20 枚とは別枠", "violet")),
    h("div", { class: "panel" },
      h("h2", {}, "集中して仕上げる"),
      h("p", { class: "small muted" }, "ここで解いた分は毎日の新規 20 枚の枠を使いません。初めて解いたカードは、そのまま毎日の復習に組み込まれます。"),
      pendingNote,
      h("div", { class: "test-actions" }, actions.map(([cls, label, desc, list, fn]) =>
        h("button", { class: `btn test-action ${cls}`, disabled: !list.length, onclick: fn }, h("b", {}, label), h("small", {}, desc))))),
    rangeHeatPanel(mem),
    setup);
}

function rangeHeatPanel(mem) {
  const grid = h("div", { class: "heat" });
  for (const ch of [...new Set(mem.map((c) => c.chapter))].sort((a, b) => a - b)) {
    const cards = mem.filter((c) => c.chapter === ch);
    grid.append(h("div", { class: "chap" }, `${ch}. ${chapterTitle(ch)}`));
    grid.append(h("div", { class: "cells" }, cards.map((c) => {
      const s = st(c.id);
      return tipOn(h("div", { class: "cell" + (isReady(c) ? " ready" : ""), style: `background:${mColor(s.mastery)}`,
        onclick: () => { hideTip(); location.hash = `#/list?card=${encodeURIComponent(c.id)}`; } }),
        () => `<b>${esc(c.id)}</b> ${starsText(c.stars)} ${TYPE_LABEL[c.type]} ・ 第${c.lecture}講<br>${esc(runsText(c.q).slice(0, 80))}<br>${MASTERY_LABEL[s.mastery]}` +
          (s.status === "review" ? ` ・ 想起率 ${Math.round(s.recall * 100)}%` : "") + (isReady(c) ? "<br>✓ テスト準備OK" : ""));
    })));
  }
  return h("div", { class: "panel" }, h("h2", {}, "範囲の習熟度(要点・規定)"),
    h("p", { class: "small muted" }, "黄色い枠のマスはテスト準備OK(想起率 85% 以上)。"), grid, masteryLegend());
}

function renderMockResult(app, good) {
  const pct = S.done ? Math.round((good / S.done) * 100) : 0;
  const missed = [...new Set(S.history.filter((x) => x.grade <= 2).map((x) => x.id))];
  const mood = pct >= 80 ? "cheer" : pct >= 50 ? "happy" : "think";
  const msg = pct >= 80 ? `${pct} 点!本番もこの調子だホー!`
    : pct >= 50 ? `${pct} 点。あと少し、書けなかったところを固めよう!`
    : `${pct} 点。大丈夫、書けないところが分かったのが収穫だホー。`;
  app.append(h("h1", {}, "模擬ミニテストの結果"),
    h("div", { class: "panel" },
      mascot(mood, msg, "lg"),
      h("div", { class: "tiles", style: "margin-top:12px" },
        tile("得点", `${pct} 点`, `OK 以上 ${good} / ${S.done} 問`, pct >= 80 ? "green" : pct >= 50 ? "orange" : "red")),
      missed.length ? h("div", {}, h("h2", {}, "書けなかった問題"),
        missed.map((id) => h("div", { class: "card-row" }, h("div", { class: "line", onclick: () => { location.hash = `#/list?card=${encodeURIComponent(id)}`; } },
          h("span", { class: `chip type-${BY_ID[id].type}` }, TYPE_LABEL[BY_ID[id].type]),
          h("span", { class: "qtext" }, runsText(BY_ID[id].q).replace(/\n/g, " ")))))) : null,
      h("div", { class: "row", style: "margin-top:16px" },
        missed.length ? h("button", { class: "btn primary", onclick: () => startSession(missed, "模擬テストの復習", { context: "test" }) }, "書けなかった問題をやり直す") : null,
        h("button", { class: "btn", onclick: () => { S = null; location.hash = "#/test"; } }, "テスト対策に戻る"),
        h("button", { class: "btn", onclick: () => { S = null; location.hash = "#/"; } }, "ホームへ"))));
}

// ---------- 一覧 ----------
function renderList(app, params) {
  const target = params.get("card");
  let F;
  try { F = JSON.parse(localStorage.getItem("listFilter") || "null"); } catch { F = null; }
  F = F || { types: ["yoten", "kitei", "riron", "maru"], stars: [2, 1, 0], q: "" };
  listSheet = !!F.sheet;
  const save = () => { try { localStorage.setItem("listFilter", JSON.stringify(F)); } catch { /* 無視 */ } };
  const body = h("div", {});

  const draw = () => {
    body.replaceChildren();
    for (const ch of chapters()) {
      const cards = DATA.cards.filter((c) => c.chapter === ch && F.types.includes(c.type) &&
        (c.type === "riron" || c.type === "maru" || F.stars.includes(c.stars)) &&
        (!F.q || (runsText(c.q) + runsText(c.a || [])).includes(F.q)));
      if (!cards.length) continue;
      const open = target ? cards.some((c) => c.id === target) : false;
      const det = h("details", { class: "panel chapter-block", open },
        h("summary", {}, `第${ch}章 ${chapterTitle(ch)}`, h("span", { class: "muted small" }, `${cards.length} 枚`),
          chapterUnlocked(ch) ? null : h("span", { class: "chip" }, "未解放"),
          h("span", { class: "spacer" }),
          h("button", { class: "btn", onclick: (e) => { e.preventDefault(); startSession(practiceQueue((c) => cards.includes(c)), `第${ch}章 練習`); } }, "この一覧を練習")));
      // 中身は開いたときに作る(全章ぶんを一度に描画しない)
      const fill = () => { if (!det.dataset.filled) { det.dataset.filled = "1"; cards.forEach((c) => det.append(cardRow(c, c.id === target))); } };
      det.addEventListener("toggle", () => det.open && fill());
      if (open) fill();
      body.append(det);
    }
    if (target) setTimeout(() => document.getElementById(`row-${target}`)?.scrollIntoView({ block: "center" }), 0);
  };

  const typeChips = Object.entries(TYPE_LABEL).map(([t, label]) =>
    h("button", { class: "chip" + (F.types.includes(t) ? " on" : ""), onclick: (e) => {
      F.types = F.types.includes(t) ? F.types.filter((x) => x !== t) : [...F.types, t];
      e.currentTarget.classList.toggle("on"); save(); draw();
    } }, label));
  const starChips = [[2, "★★"], [1, "★"], [0, "無印"]].map(([n, label]) =>
    h("button", { class: "chip" + (F.stars.includes(n) ? " on" : ""), onclick: (e) => {
      F.stars = F.stars.includes(n) ? F.stars.filter((x) => x !== n) : [...F.stars, n];
      e.currentTarget.classList.toggle("on"); save(); draw();
    } }, label));
  const search = h("input", { type: "search", placeholder: "語句で検索", value: F.q, style: "padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface)",
    oninput: (e) => { F.q = e.target.value.trim(); save(); draw(); } });

  const sheetChip = h("button", { class: "chip sheet-chip" + (F.sheet ? " on" : ""), title: "太字・赤字のキーワードを赤シートで隠す(クリックでめくる/戻す)", onclick: (e) => {
    F.sheet = listSheet = !F.sheet;
    e.currentTarget.classList.toggle("on"); save(); draw();
  } }, "赤シート");

  app.append(h("h1", {}, "一覧"),
    h("p", { class: "small muted" }, "問題をクリックすると解答を表示します(熟読用)。赤シートをオンにすると、キーワードを隠した状態で表示します。"),
    h("div", { class: "filters" }, typeChips, h("span", { class: "muted" }, "|"), starChips, search, h("span", { class: "muted" }, "|"), sheetChip),
    body);
  draw();
}

let listSheet = false; // 一覧の赤シート

function cardRow(c, expanded) {
  const s = st(c.id);
  const detail = h("div", { class: "detail", hidden: !expanded });
  const fillDetail = () => {
    const s2 = st(c.id);
    fill(detail,
      c.type === "riron" ? null : h("div", { class: "question", style: "font-size:1rem" }, runsText(c.q)),
      c.type === "maru" ? h("p", {}, "正解: ", h("b", {}, c.verdict)) : null,
      h("div", { class: "answer" }, renderRuns(c.type === "riron" ? c.q : c.a, listSheet ? "redsheet" : "full", { toggle: true }).el),
      s2.status !== "new" ? h("div", { style: "margin-top:8px" }, cardCurve(c)) : null,
      h("div", { class: "row small muted", style: "margin-top:8px" },
        h("span", {}, `${c.id} ・ ${c.lecture ? `第${c.lecture}講で学習` : "講義計画外"} ・ ${MASTERY_LABEL[s2.mastery]}`),
        s2.status !== "new" ? h("span", {}, `回答 ${s2.reps} 回 ・ 忘却 ${s2.lapses} 回 ・ 次回 ${s2.due ? fmtDay(dayKey(s2.due)) : "-"}`) : null,
        h("span", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => startSession([c.id], c.id) }, "練習する"),
        h("button", { class: "btn", onclick: async () => { DATA.states[c.id] = await api("/api/flags", { card_id: c.id, flagged: !s2.flagged }); refresh(); } }, s2.flagged ? "要注意を外す" : "要注意にする"),
        h("button", { class: "btn", onclick: async () => { DATA.states[c.id] = await api("/api/flags", { card_id: c.id, suspended: !s2.suspended }); refresh(); } }, s2.suspended ? "除外を戻す" : "除外する")));
  };
  const head = h("div", { class: "line", onclick: () => { detail.hidden = !detail.hidden; if (!detail.hidden) fillDetail(); } });
  const refresh = () => {
    const s2 = st(c.id);
    fill(head,
      h("i", { class: "mdot", style: `background:${mColor(s2.mastery)}`, title: MASTERY_LABEL[s2.mastery] }),
      h("span", { class: `chip type-${c.type}` }, TYPE_LABEL[c.type]),
      c.stars ? h("span", { class: "stars" }, starsText(c.stars)) : null,
      h("span", { class: "qtext", style: s2.suspended ? "text-decoration:line-through;opacity:.6" : "" }, runsText(c.q).replace(/\n/g, " ")),
      s2.flagged ? h("span", { class: "chip" }, "要注意") : null);
    if (!detail.hidden) fillDetail();
  };
  refresh();
  if (expanded) fillDetail();
  return h("div", { class: "card-row", id: `row-${c.id}` }, head, detail);
}

// ---------- 設定 ----------
function renderSettings(app) {
  const s = structuredClone(settings());
  const exam = h("input", { type: "date", value: s.exam_date });
  const daily = h("input", { type: "number", min: 0, max: 100, value: s.daily_new, style: "width:6em" });
  const maxI = h("input", { type: "number", min: 7, max: 365, value: s.max_interval, style: "width:6em" });
  const typeBoxes = Object.entries(TYPE_LABEL).map(([t, label]) =>
    h("label", {}, h("input", { type: "checkbox", value: t, checked: s.new_types.includes(t) }), ` ${label} `));
  const order = h("select", {}, h("option", { value: "stars" }, "重要度順(★★→★→無印、同じ★なら章順)"), h("option", { value: "chapter" }, "章順"));
  order.value = s.new_order;
  const lecturesDone = h("input", { type: "number", min: 0, max: 60, value: s.lectures_done, style: "width:5em" });
  const lectures = DATA.schedule?.lectures || [];
  // 講義計画に載っていないカードがある章だけ、手動で出題対象にできる
  const offPlan = chapters().filter((ch) => DATA.cards.some((c) => c.chapter === ch && c.lecture == null));
  const chapBoxes = offPlan.map((ch) =>
    h("label", {}, h("input", { type: "checkbox", value: ch, checked: s.unlocked_chapters.includes(ch) }), ` 第${ch}章 ${chapterTitle(ch)}`));
  const msg = h("span", { class: "muted small" });

  // スマホ単体で動いているときは、PC のサーバー向けの案内は出さない
  const phone = LOCAL ? null : h("div", { class: "panel" }, h("h2", {}, "スマホで使う"), h("p", { class: "small muted" }, "確認中…"));
  if (phone) api("/api/connect").then((info) => fill(phone, phonePanelBody(info))).catch(() => {});

  app.append(...[h("h1", {}, "設定"), phone, syncPanel(), h("div", { class: "panel" },
    h("div", { class: "form-row" }, h("label", { class: "title" }, "試験日"), h("div", {}, exam, h("div", { class: "small muted" }, "ダッシュボードの残り日数と目標ペースに使います。"))),
    h("div", { class: "form-row" }, h("label", { class: "title" }, "受講済みの講義"),
      h("div", {}, h("div", { class: "row" }, "第", lecturesDone, "講まで受講した"),
        h("div", { class: "small muted" }, "学習計画表をもとに、受講済みの講義で習ったカードだけを新規に出題します。講義を受けたら 1 つ進めてください。"),
        lectures.length ? h("details", { style: "margin-top:6px" }, h("summary", { class: "small", style: "cursor:pointer" }, "講義計画(理論)を見る"),
          h("table", { class: "data", style: "margin-top:6px" }, h("tbody", {}, lectures.map((l) =>
            h("tr", {}, h("td", { style: "white-space:nowrap" }, `第${l.no}講`), h("td", { style: "text-align:left" }, l.label)))))) : null)),
    h("div", { class: "form-row" }, h("label", { class: "title" }, "講義計画にない章"),
      h("div", {}, h("div", { class: "small muted", style: "margin-bottom:6px" },
        "まだ学習計画表をもらっていない講義の章です。先に学習したい章があればチェックしてください(章全体が出題対象になります)。"),
      h("div", { class: "chap-grid" }, chapBoxes))),
    h("div", { class: "form-row" }, h("label", { class: "title" }, "1日の新規枚数"), h("div", {}, daily, h("div", { class: "small muted" }, "要点は 1 枚につき 3 段階を同じ日に進めます(規定は赤字の穴埋めのみ)。20 枚で 1 日 30〜60 分程度が目安です。復習が多い日も新規の枚数は減らないので、負担を見て調整してください。"))),
    h("div", { class: "form-row" }, h("label", { class: "title" }, "新規に出す種類"), h("div", {}, typeBoxes, h("div", { class: "small muted" }, "理論チェック・〇×は「範囲を指定して練習」やミニテスト対策から解く使い方もできます。"))),
    h("div", { class: "form-row" }, h("label", { class: "title" }, "新規の出題順"), h("div", {}, order)),
    h("div", { class: "form-row" }, h("label", { class: "title" }, "復習間隔の上限(日)"), h("div", {}, maxI, h("div", { class: "small muted" }, "試験まで忘れないよう、長く空けすぎないための上限です。"))),
    h("div", { class: "row", style: "margin-top:16px" },
      h("button", { class: "btn primary", onclick: async () => {
        DATA.settings = await api("/api/settings", {
          exam_date: exam.value,
          lectures_done: Number(lecturesDone.value),
          daily_new: Number(daily.value),
          max_interval: Number(maxI.value),
          new_types: typeBoxes.map((l) => l.querySelector("input")).filter((b) => b.checked).map((b) => b.value),
          new_order: order.value,
          unlocked_chapters: chapBoxes.map((l) => l.querySelector("input")).filter((b) => b.checked).map((b) => Number(b.value)),
        });
        msg.textContent = "保存しました";
      } }, "保存"), msg))].filter(Boolean));
}

function phonePanelBody(info) {
  const title = h("h2", {}, "スマホで使う");
  if (!info.lan) {
    return [title, h("p", { class: "small" },
      "今は PC だけで使う起動方法になっています。スマホでも使うときは、アプリのフォルダにある ",
      h("b", {}, "start.bat"), " をダブルクリックして起動してください(", h("code", {}, "uv run riron serve --lan"), " と同じです)。")];
  }
  if (!info.local) {
    return [title, h("p", { class: "small" }, "このスマホ(端末)はログイン済みです。学習記録は PC と共有されています。")];
  }
  return [title,
    h("div", { class: "phone-connect" },
      h("div", { class: "qr", html: info.qr }),
      h("div", {},
        h("ol", { class: "small" },
          h("li", {}, "スマホを家の Wi-Fi(5GHz・2.4GHz のどちらでも可)につなぐ"),
          h("li", {}, "カメラで QR コードを読むか、下のアドレスを開く"),
          h("li", {}, "合言葉を入力する(最初の 1 回だけ)"),
          h("li", {}, "ブラウザのメニューから「ホーム画面に追加」すると、アプリのように起動できます")),
        h("div", { class: "passcode" }, "合言葉 ", h("b", {}, info.passcode)),
        h("div", { class: "small muted" }, "アドレス(上から順に試してください):"),
        h("ul", { class: "small urls" }, info.urls.map((u) => h("li", {}, h("code", {}, u)))),
        h("p", { class: "small muted" },
          "PC の名前のアドレス(.local)は、Wi-Fi の帯域を変えて PC のアドレスが変わっても使えます。開けない機種では数字のアドレスを使ってください。",
          "スマホで使う間は PC を起動したままにし、スリープしないようにしてください。")))];
}

// ---------- 学習記録の同期(PC ↔ スマホ) ----------
const dateStamp = () => Srs.iso(new Date()).slice(0, 10).replaceAll("-", "");

function downloadJson(obj, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: "application/json" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportRecords(withCards) {
  const out = LOCAL ? await api("/api/export", { withCards }) : await api(withCards ? "/api/export?cards=1" : "/api/export");
  if (LOCAL) await Local.markExported();
  // スマホ用データには自動同期の接続設定も入れる(スマホで入力しなくて済むように)
  if (withCards && Sync.configured()) out.sync = { repo: Sync.config().repo, token: Sync.config().token };
  return out;
}

// 取り込んだファイルに接続設定があれば反映して、すぐ同期する
function applySyncFromFile(json) {
  if (!json.sync) return false;
  try { Sync.configure(json.sync); } catch { return false; }
  Sync.run().then(afterSync).catch(() => {});
  return true;
}

function manualSyncPanel() {
  const msg = h("div", { class: "small", style: "margin-top:8px" });
  const say = (text, bad) => { msg.textContent = text; msg.style.color = bad ? "var(--danger, #c0392b)" : ""; };
  const exportBtn = (label, withCards, name) => h("button", { class: "btn", onclick: async () => {
    try {
      downloadJson(await exportRecords(withCards), `${name}-${dateStamp()}.json`);
      say("書き出しました。ダウンロードしたファイルを、もう一方の端末に送って取り込んでください。");
    } catch (e) { say(`書き出せませんでした: ${e.message}`, true); }
  } }, label);
  const shareBtn = h("button", { class: "btn", hidden: true, onclick: async () => {
    try {
      const file = new File([JSON.stringify(await exportRecords(false))], `riron-records-${dateStamp()}.json`, { type: "application/json" });
      await navigator.share({ files: [file], title: "理論暗記の学習記録" });
    } catch (e) { if (e.name !== "AbortError") say(`共有できませんでした: ${e.message}`, true); }
  } }, "共有で送る");
  try {
    if (navigator.canShare?.({ files: [new File(["{}"], "x.json", { type: "application/json" })] })) shareBtn.hidden = false;
  } catch { /* 共有に未対応 */ }

  const file = h("input", { type: "file", accept: ".json,application/json", onchange: async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      let json;
      try { json = JSON.parse(await f.text()); } catch { throw new Error("JSON として読めませんでした"); }
      const r = await api("/api/import", json);
      const connected = applySyncFromFile(json);
      await load();
      if (connected) { say("取り込みました。自動同期の設定も入りました。"); return; }
      say(r.added || r.flags || r.loaded
        ? `取り込みました: 評価 ${r.added} 件(${r.cards} 枚のカード)${r.loaded ? `、カード ${r.loaded} 枚` : ""}${r.flags ? `、フラグ ${r.flags} 件` : ""}。`
        : "新しい記録はありませんでした。");
    } catch (e) { say(`取り込めませんでした: ${e.message}`, true); }
    file.value = "";
  } });

  let note = null;
  if (LOCAL) {
    const { at, logNow } = Local.lastExport();
    note = h("p", { class: "small muted" }, at ? `最後に書き出した日時: ${at.replace("T", " ")}` : "まだ書き出していません。", logNow ? ` (この端末の評価 ${logNow} 件)` : "");
  }
  return h("div", { style: "margin-top:8px" },
    h("p", { class: "small" },
      LOCAL ? "このスマホの記録はこの端末の中だけに保存されています。PC と記録を合わせたり、バックアップを取ったりするときは、ファイルで書き出して送ります。"
        : "スマホ単体で使うときや、PC とスマホの両方で学習したときは、ファイルで記録を受け渡します。"),
    h("p", { class: "small muted" }, "同じ評価は重複せず、日時の順に合わせて復習予定が計算し直されます。除外・要注意は新しく変えた方、受講済みの講義は進んだ方が残ります。"),
    note,
    h("div", { class: "row", style: "gap:8px;flex-wrap:wrap" },
      LOCAL ? [exportBtn("記録を書き出す", false, "riron-records"), shareBtn]
        : [exportBtn("スマホ用データを書き出す(カード+記録)", true, "riron-phone"), exportBtn("記録だけ書き出す", false, "riron-records")]),
    h("div", { style: "margin-top:12px" }, h("label", { class: "small" }, LOCAL ? "PC のデータを取り込む: " : "スマホの記録を取り込む: ", file)),
    msg,
    h("p", { class: "small muted" }, "注意: 「元に戻す」で取り消した評価でも、取り消す前に書き出したファイルを取り込むと元に戻ります。"));
}

function syncPanel() {
  return h("div", {}, autoSyncPanel(),
    h("details", { class: "panel" }, h("summary", { style: "cursor:pointer" }, "手動での受け渡し・バックアップ(予備)"), manualSyncPanel()));
}

function autoSyncPanel() {
  const box = h("div", { class: "panel" });
  const msg = h("div", { class: "small", style: "margin-top:8px" });
  const say = (text, bad) => { msg.textContent = text; msg.style.color = bad ? "var(--danger, #c0392b)" : ""; };
  const draw = () => {
    if (Sync.configured()) {
      const at = Sync.lastOk();
      fill(box, h("h2", {}, "自動同期"),
        h("p", { class: "small" }, "接続済み: ", h("code", {}, Sync.config().repo),
          at ? `(最後に同期: ${Srs.iso(new Date(at)).replace("T", " ").slice(0, 16)})` : ""),
        h("p", { class: "small muted" }, "このアプリを開いたときと、学習したあとに、PC とスマホの記録が自動で合わさります。圏外のときは、つながったときに同期します。"),
        h("div", { class: "row", style: "gap:8px" },
          h("button", { class: "btn primary", onclick: async () => {
            say("同期しています…");
            try {
              const r = await Sync.run();
              await load();
              say(r ? (r.merged ? `他の端末の記録を取り込みました(${r.merged} 件)。` : "同期しました。変更はありません。") : "オフラインです。");
            } catch (e) { say(`同期できませんでした: ${e.message}`, true); }
          } }, "今すぐ同期"),
          h("button", { class: "btn", onclick: () => { if (confirm("自動同期をやめますか?(この端末の記録は残ります)")) { Sync.disconnect(); draw(); } } }, "接続を解除")),
        msg);
      return;
    }
    const repo = h("input", { type: "text", placeholder: "ユーザー名/リポジトリ名", style: "width:100%", autocapitalize: "off" });
    const token = h("input", { type: "password", placeholder: "github_pat_…", style: "width:100%", autocomplete: "off" });
    fill(box, h("h2", {}, "自動同期"),
      h("p", { class: "small" }, "学習記録(カード ID・評価・日時だけで、教材の文章は含みません)を、GitHub の非公開リポジトリに預けて、PC とスマホで自動的に合わせます。"),
      h("ol", { class: "small" },
        h("li", {}, "非公開リポジトリを用意する(例: riron-data)"),
        h("li", {}, h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "トークンの作成ページ"),
          "で、そのリポジトリだけを選び、権限は Contents を「Read and write」にして作る(期限は 1 年)"),
        h("li", {}, "下に入力して接続する。PC で接続すると、「スマホ用データ」にも設定が入るので、スマホでは入力不要です")),
      h("div", { class: "form-row" }, h("label", { class: "title" }, "リポジトリ"), h("div", {}, repo)),
      h("div", { class: "form-row" }, h("label", { class: "title" }, "トークン"), h("div", {}, token)),
      h("button", { class: "btn primary", onclick: async () => {
        try {
          Sync.configure({ repo: repo.value, token: token.value });
          say("接続を確認しています…");
          await Sync.test();
          await Sync.run();
          await load();
          draw();
        } catch (e) { Sync.disconnect(); say(`接続できませんでした: ${e.message}`, true); }
      } }, "接続して同期する"),
      msg);
  };
  draw();
  return box;
}

// 端末内で動いているとき、しばらく書き出していなければバックアップを促す
function backupNotice() {
  if (Sync.configured()) return null;
  const { at, logAtExport, logNow } = Local.lastExport();
  if (logNow === logAtExport) return null;
  const days = at ? (Date.now() - Srs.parse(at)) / DAY_MS : Infinity;
  if (days < 7) return null;
  return h("div", { class: "panel small" },
    at ? `学習記録を最後に書き出してから ${Math.floor(days)} 日たっています。` : "学習記録をまだ書き出していません。",
    " 端末のデータが消えても戻せるよう、", h("a", { href: "#/settings" }, "設定"), "から書き出して保管してください。");
}

// 初回: カードが入っていない端末に、PC で書き出したデータを入れる
function renderImportScreen() {
  const msg = h("div", { class: "small", style: "margin-top:8px" });
  const file = h("input", { type: "file", accept: ".json,application/json", onchange: async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      let json;
      try { json = JSON.parse(await f.text()); } catch { throw new Error("JSON として読めませんでした"); }
      await api("/api/import", json);
      applySyncFromFile(json);
      await load();
      location.hash = "#/";
      render();
    } catch (e) { msg.textContent = `取り込めませんでした: ${e.message}`; }
  } });
  document.getElementById("app").replaceChildren(h("div", { class: "panel" },
    h("h1", {}, "はじめに: データを入れる"),
    h("p", {}, "このアプリには教材のデータが入っていません。PC で書き出したファイルを、この端末に取り込みます。"),
    h("ol", {},
      h("li", {}, "PC で理論暗記ツールを開き、「設定」→「手動での受け渡し・バックアップ」の「スマホ用データを書き出す」を押す(自動同期を設定済みなら、スマホの接続設定も入ります)"),
      h("li", {}, "できたファイル(riron-phone-….json)を、このスマホに送る(USB ケーブル、自分だけが見られるクラウドのフォルダなど)"),
      h("li", {}, "下のボタンでそのファイルを選ぶ(取り込んだら、ファイルは削除してください)")),
    h("div", {}, file),
    msg,
    h("p", { class: "small muted" }, "教材のデータと学習記録は、この端末の中だけに保存されます。アプリを置いているサーバーには送られません。")));
}

// ---------- 進め方 ----------
function renderGuide(app) {
  app.append(h("div", { class: "panel guide", html: `
<h1>暗記の進め方</h1>
<p>本試験の理論は記述式です。目標は「問題文を見たら、解答をすらすら言える・書ける」状態にすることです。このツールは、<b>思い出す練習(アクティブリコール)</b>と<b>間隔を空けた復習</b>を軸にしています。</p>

<h2>1. 3 段階で隠す量を増やす(要点チェック)</h2>
<ol>
<li><b>キーワード穴埋め</b>: テキストの太字・赤字(採点で見られやすい語句)だけを空欄にします。まず骨格になる語句を確実にします。</li>
<li><b>頭文字ヒント</b>: 各文節の 1 文字目だけを見せ、文の流れ(つなぎ)を再現します。</li>
<li><b>白紙から再現</b>: 問題文だけを見て全文を言う・書く。ここで「OK」以上なら卒業して復習に回ります。</li>
</ol>
<p>同じ日のうちに 1 → 2 → 3 と進みます。あやしいところは文節をクリックすれば、その部分だけ確認できます。</p>
<p><b>規定</b>は全文を書けるようになる必要はないので、<b>赤字の穴埋めだけ</b>で出題します。穴埋めができたら卒業して復習に回り、復習も赤字の穴埋めで行います。</p>

<h2>2. 忘却曲線に合わせて復習する</h2>
<p>エビングハウスの忘却曲線のとおり、覚えた内容は直後から急に忘れ、時間がたつほどゆっくり忘れていきます。思い出すたびに記憶が強くなり、次に忘れるまでの時間が延びます。</p>
<ul>
<li>同じ日のうちに: 段階を上げながら数分おきに再出題(いちばん急に忘れる最初の 1 時間を補う)</li>
<li>卒業後: <b>1 日 → 2 日 → 6 日 → 14 日 → 31 日</b>と間隔を空けて復習(想起率がおよそ 90% まで下がる頃)</li>
<li>それ以降: 覚えやすさに応じて間隔を伸ばす(上限は設定で変更可)。覚えにくいカードは間隔を短めにする</li>
<li>忘れていたら(もう一度): 頭文字ヒントの段階から再学習し、間隔も短くしてやり直す</li>
<li>予定より早く練習した場合: まだ忘れかけていないので、復習予定日は変えない</li>
</ul>
<p>ホームの「忘却曲線と復習のタイミング」と、一覧で開いたカードの曲線で、記憶の残り具合を確認できます。</p>

<h2>3. 評価の付け方</h2>
<ul>
<li><b>完璧</b>: 一言一句ほぼそのまま、迷わず出た</li>
<li><b>OK</b>: キーワードはすべて出て、言い回しが少し違う程度</li>
<li><b>あやふや</b>: キーワードの抜けや、途中で確認した部分がある</li>
<li><b>もう一度</b>: 出てこなかった</li>
</ul>
<p>タイピングで答えた場合は、一致率とキーワードの網羅率から評価の目安を枠で示します。最終的な評価はご自身で選んでください。</p>

<h2>4. 毎日の流れ</h2>
<ol>
<li>ホームの「今日の学習を始める」で、<b>復習を優先</b>しつつ新規を混ぜて出題します。</li>
<li>新規は <b>★★ → ★ → 無印</b> の順(設定で章順にも変更可)。学習計画表をもとに、<b>受講済みの講義で習った範囲だけ</b>が対象です。講義を受けたら、設定の「受講済みの講義」を進めてください。</li>
<li>新しく覚えるとき(新規・学習中)は<b>タイピング</b>で正確さを確認し、復習は<b>赤シート</b>で素早く回すのがおすすめです(「自動」がこの動きです)。</li>
<li>解答方法を<b>赤シート</b>にすると、キーワード穴埋めの段階(規定・理論チェックは常に)でキーワードが赤く塗りつぶされ、クリックでめくって確認できます。一覧でも「赤シート」をオンにすると同じように隠せます。</li>
<li>講義の復習としてテキストを熟読するときは「一覧」で問題と解答を読み、〇×・理論チェックは「範囲を指定して練習」から章ごとに解きます。</li>
</ol>

<h2>5. ミニテスト・確認テスト対策</h2>
<p>テストは、行われる回の <b>1 回前と 2 回前の講義</b>で習った理論が範囲です。「ミニテスト」タブでテストの回とテスト日を入れると範囲が決まり、毎日の 20 枚とは別枠で集中して仕上げられます。</p>
<ul>
<li><b>まだ仕上がっていないカード</b>: 学習途中 → 忘れかけ → 未学習(★の多い順)の順に出題。テスト日までの 1 日の目安枚数も表示します。</li>
<li><b>規定だけ</b>/<b>〇×・理論チェック</b>: 穴埋め対策や読み取りの確認に。</li>
<li><b>模擬ミニテスト</b>: 範囲から 10 問を抽選し、全問「白紙から」で出題して得点を出します。書けなかった問題はその場でやり直せます。</li>
</ul>
<p>範囲は学習計画表のミニテスト欄に合わせてあり、講義の回ごとに習った節単位で決まります(第何講で習うかは、学習中のカードと一覧に表示されます)。ここで初めて解いたカードは、そのまま毎日の復習に組み込まれます。</p>

<h2>6. 視覚化の見方</h2>
<ul>
<li><b>習熟度マップ</b>: 1 マス 1 枚。章ごとに、どこが薄い(未定着)かがひと目でわかります。</li>
<li><b>重要度別の習熟度</b>: ★★ を最優先で「定着」以上にします。</li>
<li><b>一巡目の進み具合</b>: 試験 90 日前までに全カードを一度「白紙から再現」できる状態にし、残りの期間は反復に充てる計画です。</li>
<li><b>今テストしたら(推定)</b>: 復習間隔と経過日数から、今思い出せる確率を推定した平均です。</li>
</ul>
<p class="muted small">習熟度の定義: キーワード段階/頭文字段階 = 学習中、再現できた = 白紙で再現でき復習間隔 7 日未満、定着 = 間隔 7 日以上、完全定着 = 間隔 21 日以上。</p>
` }));
}

// ---------- ルーティング ----------
function currentRoute() {
  const [path, query] = (location.hash.replace(/^#/, "") || "/").split("?");
  const name = { "/": "home", "/study": "study", "/test": "test", "/list": "list", "/guide": "guide", "/settings": "settings" }[path] || "home";
  return { name, params: new URLSearchParams(query || "") };
}

async function render() {
  hideTip();
  const { name, params } = currentRoute();
  document.querySelectorAll(".topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
  const app = document.getElementById("app");
  app.replaceChildren();
  ({ home: renderHome, study: renderStudy, test: renderTest, list: renderList, guide: renderGuide, settings: renderSettings })[name](app, params);
  if (LOCAL && name === "home") { const n = backupNotice(); if (n) app.prepend(n); }
}

window.addEventListener("hashchange", async () => {
  // 学習中以外の画面に移るときは最新の状態を読み直す
  try {
    if (currentRoute().name !== "study") { await load(); Sync.soon(3000); }
  } catch (e) {
    if (e.code === "no-data") return renderImportScreen();
  }
  render();
});

// ---------- 自動同期 ----------
function showSyncBadge(s) {
  const el = document.getElementById("sync-badge");
  if (!el) return;
  const t = (iso) => Srs.iso(new Date(iso)).slice(11, 16);
  const text = {
    off: "", idle: s.at ? `同期 ${t(s.at)}` : "未同期", syncing: "同期中…",
    ok: `同期済み ${s.at ? t(s.at) : ""}`, offline: "オフライン", error: "同期エラー",
  }[s.state] || "";
  el.textContent = text;
  el.title = s.message || "";
  el.classList.toggle("bad", s.state === "error");
}

// 他の端末の記録を取り込んだら、学習中でなければ画面を読み直す
async function afterSync(result) {
  if (!result || !result.merged || currentRoute().name === "study") return;
  try { await load(); render(); } catch { /* 次の操作で読み直す */ }
}

function startSync() {
  Sync.init({
    kind: LOCAL ? "phone" : "pc",
    exportFn: () => (LOCAL ? api("/api/export", {}) : api("/api/export")),
    importFn: (rec) => api("/api/import", rec),
    onStatus: showSyncBadge,
    onPushed: () => { if (LOCAL) Local.markExported(); },  // 同期できていればバックアップにもなっている
    onSynced: afterSync,
  });
  Sync.run().then(afterSync).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") Sync.run().then(afterSync).catch(() => {});
  });
}

detectBackend().then(async () => {
  startSync();
  await load();
  render();
}).catch((e) => {
  if (e.code === "no-data") return renderImportScreen();
  document.getElementById("app").replaceChildren(h("p", {}, `読み込みに失敗しました: ${e.message}`));
});
