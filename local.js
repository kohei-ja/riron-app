"use strict";

// スマホ単体で動かすためのバックエンド。PC のサーバー(riron/server.py)と同じ API を、
// 端末内の IndexedDB だけで処理する。カードと学習記録はこの端末の外には出ない。
// 記録の統合(mergeRecords)は riron/records.py の移植なので、変えるときは両方をそろえること。
const Local = (() => {
  const DB_NAME = "riron";
  const FORMAT = "riron-records";
  const LOG_FIELDS = ["card_id", "ts", "grade", "stage", "status_before", "mode", "score", "duration_ms", "interval_after", "context"];
  // riron/db.py の DEFAULT_SETTINGS と同じ
  const DEFAULT_SETTINGS = {
    exam_date: "2027-08-03",
    lectures_done: 23,
    unlocked_chapters: [],
    daily_new: 20,
    new_types: ["yoten", "kitei"],
    new_order: "stars",
    max_interval: 45,
    mini_test: { lecture: null, date: null, lectures: null },
  };

  class UserError extends Error {}

  // ---- IndexedDB ----
  let db = null;
  const mem = { bundle: null, settings: {}, hasSettings: false, states: new Map(), log: [], meta: {} };

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("kv");
        d.createObjectStore("states", { keyPath: "card_id" });
        d.createObjectStore("log", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 1 つのトランザクションで複数のストアを操作する。fn の中では同期的に要求を出すこと
  function tx(stores, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, "readwrite");
      const out = fn(...stores.map((s) => t.objectStore(s)));
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }

  const getAll = (store) => new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const getKey = (key) => new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  let ready = null;
  function init() {
    if (!ready) {
      ready = (async () => {
        db = await open();
        mem.bundle = (await getKey("bundle")) || null;
        const saved = await getKey("settings");
        mem.hasSettings = saved != null;
        mem.settings = saved || {};
        mem.meta = (await getKey("meta")) || {};
        for (const row of await getAll("states")) mem.states.set(row.card_id, row);
        mem.log = await getAll("log");
        mem.log.sort((a, b) => a.id - b.id);
        // 端末の都合で保存領域を消されにくくする(通らなくても動く)
        try { await navigator.storage?.persist?.(); } catch { /* 無視 */ }
      })();
    }
    return ready;
  }

  const hasCards = () => !!mem.bundle;
  const cards = () => mem.bundle.cards;
  const cardType = (id) => mem.bundle.cards.find((c) => c.id === id)?.type;
  const settings = () => ({ ...DEFAULT_SETTINGS, ...mem.settings });
  const stateOf = (id) => mem.states.get(id)?.state || Srs.newState();
  const saveMeta = (patch) => { Object.assign(mem.meta, patch); return tx(["kv"], (kv) => kv.put(mem.meta, "meta")); };

  function cardView(id, now) {
    const row = mem.states.get(id);
    const state = row?.state || Srs.newState();
    return {
      ...state,
      mastery: Srs.mastery(state),
      recall: Math.round(Srs.retrievability(state, now) * 1000) / 1000,
      suspended: !!row?.suspended,
      flagged: !!row?.flagged,
    };
  }

  const logRow = (r) => [r.ts, r.card_id, r.grade, r.stage, r.status_before, r.score, r.duration_ms, r.interval_after, r.context];

  // ---- API(server.py と同じ形) ----
  function data() {
    if (!hasCards()) throw Object.assign(new Error("カードが入っていません"), { code: "no-data" });
    const now = new Date();
    const { cards: cs, schedule } = mem.bundle;
    const states = {};
    for (const c of cs) states[c.id] = cardView(c.id, now);
    return {
      now: Srs.iso(now),
      study_day: Srs.iso(Srs.studyDay(now)),
      cards: cs,
      states,
      settings: settings(),
      schedule: schedule && {
        lectures: schedule.lectures.map((l) => ({ no: l.no, label: l.label })),
        tests: schedule.tests || [],
      },
      log: mem.log.map(logRow),
    };
  }

  async function review(body) {
    const type = cardType(body.card_id);
    if (!type) throw new UserError(`カードがありません: ${body.card_id}`);
    const grade = Number(body.grade);
    if (![1, 2, 3, 4].includes(grade)) throw new UserError("grade は 1〜4");
    if (body.context != null && body.context !== "test") throw new UserError("context は test のみ");
    const now = new Date();
    const before = stateOf(body.card_id);
    const after = Srs.schedule(before, type, grade, now, settings().max_interval, body.score ?? null);
    const shown = before.status === "new" ? Srs.startStage(type) : before.status === "review" ? Srs.FINAL_STAGE : Math.max(before.stage, Srs.startStage(type));
    const row = {
      card_id: body.card_id, ts: after.last_review, grade, stage: shown, status_before: before.status,
      mode: body.mode ?? null, score: body.score ?? null, duration_ms: body.duration_ms ?? null,
      interval_after: after.interval, prev_state: before, context: body.context ?? null,
    };
    const prev = mem.states.get(body.card_id);
    const next = { card_id: body.card_id, state: after, suspended: !!prev?.suspended, flagged: !!prev?.flagged, flags_at: prev?.flags_at ?? null };
    await tx(["states", "log"], (states, log) => {
      states.put(next);
      log.add(row).onsuccess = (e) => { row.id = e.target.result; };
    });
    mem.states.set(body.card_id, next);
    mem.log.push(row);
    return cardView(body.card_id, now);
  }

  async function undo() {
    const row = mem.log[mem.log.length - 1];
    if (!row) return { card_id: null };
    const cur = mem.states.get(row.card_id);
    const next = { ...cur, state: row.prev_state };
    await tx(["states", "log"], (states, log) => { states.put(next); log.delete(row.id); });
    mem.states.set(row.card_id, next);
    mem.log.pop();
    return { card_id: row.card_id, state: cardView(row.card_id, new Date()) };
  }

  async function updateSettings(values) {
    const next = { ...mem.settings };
    for (const [k, v] of Object.entries(values)) if (k in DEFAULT_SETTINGS) next[k] = v;
    await tx(["kv"], (kv) => kv.put(next, "settings"));
    mem.settings = next;
    mem.hasSettings = true;
    return settings();
  }

  async function setFlags(body, at = Srs.iso(new Date())) {
    const id = body.card_id;
    if (!cardType(id)) throw new UserError(`カードがありません: ${id}`);
    const cur = mem.states.get(id) || { card_id: id, state: Srs.newState(), suspended: false, flagged: false, flags_at: null };
    const next = { ...cur, flags_at: at };
    if (body.suspended != null) next.suspended = !!body.suspended;
    if (body.flagged != null) next.flagged = !!body.flagged;
    await tx(["states"], (states) => states.put(next));
    mem.states.set(id, next);
    return cardView(id, new Date());
  }

  // ---- 書き出し・取り込み ----
  function exportRecords({ withCards = false } = {}) {
    const log = mem.log.map((r) => Object.fromEntries(LOG_FIELDS.map((k) => [k, r[k]])))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0));
    const flags = {};
    for (const [id, r] of mem.states) {
      if (r.suspended || r.flagged || r.flags_at) flags[id] = { suspended: !!r.suspended, flagged: !!r.flagged, at: r.flags_at ?? null };
    }
    const out = {
      format: FORMAT, version: 1, exported_at: Srs.iso(new Date()),
      settings: settings(), has_settings: mem.hasSettings, log, flags,
    };
    if (withCards && hasCards()) Object.assign(out, { cards: mem.bundle.cards, schedule: mem.bundle.schedule });
    return out;
  }

  async function markExported() { await saveMeta({ last_export: Srs.iso(new Date()), exported_log: mem.log.length }); }
  const lastExport = () => ({ at: mem.meta.last_export || null, logAtExport: mem.meta.exported_log || 0, logNow: mem.log.length });

  async function importRecords(records) {
    if (!records || records.format !== FORMAT) throw new UserError("学習記録のファイルではありません");
    let cardsReplaced = false;
    if (Array.isArray(records.cards)) {
      if (!records.cards.every((c) => c && c.id && c.type && c.q && c.a)) throw new UserError("カードのデータが壊れています");
      mem.bundle = { cards: records.cards, schedule: records.schedule || null };
      await tx(["kv"], (kv) => kv.put(mem.bundle, "bundle"));
      cardsReplaced = true;
    }
    if (!hasCards()) throw new UserError("カードが入っていません。PC で書き出した「スマホ用データ」を選んでください");
    return { ...(await mergeRecords(records)), loaded: cardsReplaced ? mem.bundle.cards.length : 0 };
  }

  async function mergeRecords(records) {
    const types = new Map(cards().map((c) => [c.id, c.type]));
    const fresh = mem.log.length === 0 && !mem.hasSettings;
    const have = new Set(mem.log.map((r) => `${r.card_id}\t${r.ts}`));
    const added = (records.log || []).filter((r) => types.has(r.card_id) && !have.has(`${r.card_id}\t${r.ts}`)).map((r) => ({ ...r }));

    // 設定: 何も記録がない端末は丸ごと引き継ぎ、そうでなければ進んだ分だけ取り込む
    const incoming = records.settings || {};
    const patch = {};
    if (fresh && records.has_settings) {
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in incoming) patch[k] = incoming[k];
    } else {
      const cur = settings();
      if ((incoming.lectures_done || 0) > cur.lectures_done) patch.lectures_done = incoming.lectures_done;
      const union = [...new Set([...cur.unlocked_chapters, ...(incoming.unlocked_chapters || [])])].sort((a, b) => a - b);
      if (JSON.stringify(union) !== JSON.stringify([...cur.unlocked_chapters].sort((a, b) => a - b))) patch.unlocked_chapters = union;
    }
    if (Object.keys(patch).length) await updateSettings(patch);

    // フラグ: 新しく変更した方が勝つ
    let flagsChanged = 0;
    for (const [id, f] of Object.entries(records.flags || {})) {
      if (!types.has(id)) continue;
      const row = mem.states.get(id);
      if ((f.at || "") > (row?.flags_at || "") || (!row && (f.suspended || f.flagged))) {
        await setFlags({ card_id: id, suspended: f.suspended, flagged: f.flagged }, f.at || Srs.iso(new Date()));
        flagsChanged++;
      }
    }

    if (added.length) await replay(added, types);
    return { added: added.length, cards: new Set(added.map((r) => r.card_id)).size, flags: flagsChanged, settings: Object.keys(patch).sort() };
  }

  // ログが増えたカードの状態を最初から再生して作り直し、ログを時刻順に並べ直す
  async function replay(added, types) {
    const maxInterval = settings().max_interval;
    const rows = [...mem.log, ...added].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.card_id < b.card_id ? -1 : 1));
    const touched = new Set(added.map((r) => r.card_id));
    const final = new Map();
    for (const id of touched) {
      let state = Srs.newState();
      for (const r of rows) {
        if (r.card_id !== id) continue;
        const after = Srs.schedule(state, types.get(id), r.grade, Srs.parse(r.ts), maxInterval, r.score ?? null);
        r.status_before = state.status;
        r.interval_after = after.interval;
        r.prev_state = state;
        state = after;
      }
      final.set(id, state);
    }
    for (const r of rows) delete r.id;
    await tx(["states", "log"], (states, log) => {
      for (const [id, state] of final) {
        const cur = mem.states.get(id);
        states.put({ card_id: id, state, suspended: !!cur?.suspended, flagged: !!cur?.flagged, flags_at: cur?.flags_at ?? null });
      }
      log.clear();
      rows.forEach((r) => { log.add(r).onsuccess = (e) => { r.id = e.target.result; }; });
    });
    for (const [id, state] of final) {
      const cur = mem.states.get(id);
      mem.states.set(id, { card_id: id, state, suspended: !!cur?.suspended, flagged: !!cur?.flagged, flags_at: cur?.flags_at ?? null });
    }
    mem.log = rows;
  }

  // ---- ルーティング ----
  // 操作は 1 つずつ順番に処理する(同期の取り込みと評価が重なって記録が食い違わないように)
  let queue = Promise.resolve();
  function request(path, body) {
    const run = queue.then(() => dispatch(path, body));
    queue = run.catch(() => {});
    return run;
  }

  async function dispatch(path, body) {
    await init();
    if (path === "/api/data") return data();
    if (path === "/api/connect") return { lan: false, local_app: true };
    if (path === "/api/export") return exportRecords(body || {});
    if (!hasCards() && path !== "/api/import") throw new UserError("カードが入っていません");
    switch (path) {
      case "/api/review": return review(body);
      case "/api/undo": return undo();
      case "/api/settings": return updateSettings(body);
      case "/api/flags": return setFlags(body);
      case "/api/import": return importRecords(body);
    }
    throw new UserError(`未対応の操作です: ${path}`);
  }

  return { init, request, hasCards, markExported, lastExport };
})();
