"use strict";

// 間隔反復のスケジューラー(riron/srs.py の移植。変えるときは両方をそろえること)。
// スマホ単体で使うとき(local.js)はこちらが評価を計算する。日時はタイムゾーンなしのローカル時刻の ISO 文字列。
const Srs = (() => {
  const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;
  const FINAL_STAGE = 2;
  const STAGED_TYPES = ["yoten", "kitei"];
  const DAY_START_HOUR = 4;
  const REVIEW_LADDER = [1, 2, 6, 14, 31];
  const TARGET_RECALL = 0.9;
  const INITIAL_EASE = 2.5, MIN_EASE = 1.3, MAX_EASE = 3.0;

  const newState = () => ({
    status: "new", stage: 0, interval: 0, ease: INITIAL_EASE, due: null,
    reps: 0, lapses: 0, last_review: null, last_score: null,
  });

  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // 時刻のないタイムゾーンなし文字列はローカル時刻として解釈される
  const parse = (s) => new Date(s);

  // Python の round() は偶数丸め(2.5 → 2)なので合わせる
  function pyRound(x) {
    const f = Math.floor(x), diff = x - f;
    if (diff < 0.5) return f;
    if (diff > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  const startStage = (type) => (STAGED_TYPES.includes(type) ? 0 : FINAL_STAGE);

  function studyDay(now) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_START_HOUR, 0, 0);
    return now < start ? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, DAY_START_HOUR, 0, 0) : start;
  }

  function nextInterval(interval, ease, steps) {
    let ivl = interval;
    for (let i = 0; i < steps; i++) {
      const nxt = REVIEW_LADDER.find((d) => d > ivl + 1e-9);
      ivl = nxt ? Math.max(ivl + 1, nxt * Math.min(1, ease / INITIAL_EASE)) : ivl * ease;
    }
    return ivl;
  }

  // 評価に応じて次の状態を返す(state は変更しない)
  function schedule(state, type, grade, now, maxInterval = 45, score = null) {
    const s = { ...state };
    if (s.status === "new") {
      s.status = "learning";
      s.stage = startStage(type);
    }
    s.reps += 1;
    s.last_review = iso(now);
    s.last_score = score;
    const today = studyDay(now);
    const dueInDays = (days) =>
      iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + Math.max(1, pyRound(days)), DAY_START_HOUR, 0, 0));
    const dueInMinutes = (m) => iso(new Date(now.getTime() + m * 60000));

    if (s.status === "learning") {
      if (grade === AGAIN) {
        s.stage = Math.max(startStage(type), s.stage - 1);
        s.due = dueInMinutes(1);
      } else if (grade === HARD) {
        s.due = dueInMinutes(5);
      } else if (s.stage < FINAL_STAGE) {
        s.stage = Math.min(FINAL_STAGE, s.stage + (grade === EASY ? 2 : 1));
        s.due = dueInMinutes(1);
      } else {
        const base = Math.max(1, s.interval);
        s.interval = Math.min(maxInterval, grade === EASY ? nextInterval(base, s.ease, 1) : base);
        s.status = "review";
        s.due = dueInDays(s.interval);
      }
      return s;
    }

    const early = state.due != null && now < parse(state.due);
    if (grade === AGAIN) {
      s.lapses += 1;
      s.ease = Math.max(MIN_EASE, s.ease - 0.2);
      s.interval = Math.max(1, s.interval * 0.3);
      s.status = "learning";
      s.stage = STAGED_TYPES.includes(type) ? 1 : FINAL_STAGE;
      s.due = dueInMinutes(1);
      return s;
    }
    if (grade === HARD) s.ease = Math.max(MIN_EASE, s.ease - 0.15);
    else if (grade === EASY) s.ease = Math.min(MAX_EASE, s.ease + 0.15);
    if (early) return s;
    const ivl = grade === HARD ? Math.max(1, s.interval * 1.2) : nextInterval(s.interval, s.ease, grade === GOOD ? 1 : 2);
    s.interval = Math.min(maxInterval, ivl);
    s.due = dueInDays(s.interval);
    return s;
  }

  function mastery(s) {
    if (s.status === "new") return 0;
    if (s.status === "learning") return s.stage === 0 ? 1 : s.stage === 1 ? 2 : 3;
    if (s.interval >= 21) return 5;
    if (s.interval >= 7) return 4;
    return 3;
  }

  function retrievability(s, now) {
    if (s.status !== "review" || !s.last_review) return 0;
    const elapsed = (now - parse(s.last_review)) / 86400e3;
    return Math.exp(Math.log(TARGET_RECALL) * Math.max(0, elapsed) / Math.max(s.interval, 1));
  }

  return {
    AGAIN, HARD, GOOD, EASY, FINAL_STAGE, REVIEW_LADDER, TARGET_RECALL,
    newState, iso, parse, startStage, studyDay, nextInterval, schedule, mastery, retrievability,
  };
})();
