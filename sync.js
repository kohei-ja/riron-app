"use strict";

// 学習記録の自動同期。GitHub の非公開リポジトリ(sync/<端末名>.json)に、評価ログだけを預ける。
// 教材の文章は含まない。端末ごとに自分のファイルだけを書くので、書き込みが衝突しない。
// 流れ: 他の端末のファイルを取得して統合(/api/import)→ 自分の記録を書き戻す(/api/export)。
const Sync = (() => {
  const API = "https://api.github.com";
  const DIR = "sync";
  const KEY_CFG = "riron_sync";
  const KEY_STATE = "riron_sync_state";
  // 預ける評価ログの列。status_before・interval_after は取り込み時に再生で計算し直すので省く
  const COLS = ["card_id", "ts", "grade", "stage", "score", "mode", "duration_ms", "context"];

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } };

  let opts = { kind: "pc", exportFn: null, importFn: null, onStatus: () => {}, onPushed: () => {} };
  let cfg = read(KEY_CFG);
  let state = read(KEY_STATE) || { own_hash: null, seen: {}, last_ok: null };
  let running = null;
  let timer = null;

  function init(o) { opts = { ...opts, ...o }; status(); }
  const configured = () => !!(cfg && cfg.repo && cfg.token);
  const config = () => cfg;
  const lastOk = () => state.last_ok;

  function configure(c) {
    const repo = String(c.repo || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
    const token = String(c.token || "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("リポジトリは「ユーザー名/リポジトリ名」の形で入れてください");
    if (!token) throw new Error("トークンを入れてください");
    // 形式が不正だと、通信の前にブラウザが弾いて「通信できません」と区別がつかなくなる
    if (!/^[!-~]+$/.test(token)) throw new Error("トークンに空白や全角などの余計な文字が入っています。コピーし直してください");
    if (token.length > 120) throw new Error(`トークンが長すぎます(${token.length} 文字)。通常は 93 文字前後です。複数回貼り付けていないか確認してください`);
    if (!/^(github_pat_|ghp_)/.test(token)) throw new Error("トークンは github_pat_ で始まります。作成したときに表示された値を貼ってください");
    // 端末名は端末ごとに決める(ファイルに入っていても引き継がない)
    const device = cfg?.device || `${opts.kind}-${Math.random().toString(36).slice(2, 7)}`;
    cfg = { repo, token, device };
    state = { own_hash: null, seen: {}, last_ok: null };
    write(KEY_CFG, cfg);
    write(KEY_STATE, state);
    status();
  }

  function disconnect() {
    cfg = null;
    state = { own_hash: null, seen: {}, last_ok: null };
    write(KEY_CFG, null);
    write(KEY_STATE, null);
    status();
  }

  function status(s) { opts.onStatus(s || (configured() ? { state: "idle", at: state.last_ok } : { state: "off" })); }

  // ---- GitHub API ----
  async function gh(path, init = {}, accept = "application/vnd.github+json") {
    let res;
    try {
      res = await fetch(`${API}/repos/${cfg.repo}${path && `/${path}`}`, {
        cache: "no-store",
        ...init,
        headers: {
          Authorization: `Bearer ${cfg.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw Object.assign(new Error("通信できません"), { offline: true });
    }
    if (res.status === 401) throw new Error("トークンが無効か、期限が切れています");
    if (res.status === 403) throw new Error("トークンの権限が足りないか、利用回数の上限です");
    if (res.status === 404 && init.method !== "PUT") throw Object.assign(new Error("リポジトリが見つかりません"), { notFound: true });
    return res;
  }

  async function listFiles() {
    const res = await gh(`contents/${DIR}?ref=main`).catch((e) => { if (e.notFound) return null; throw e; });
    if (!res || res.status === 404) return [];  // まだ誰も預けていない
    if (!res.ok) throw new Error(`一覧を取得できませんでした (${res.status})`);
    return (await res.json()).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  }

  async function fetchBlob(sha) {
    const res = await gh(`git/blobs/${sha}`, {}, "application/vnd.github.raw+json");
    if (!res.ok) throw new Error(`記録を取得できませんでした (${res.status})`);
    return res.text();
  }

  const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  async function putOwn(text, sha) {
    const res = await gh(`contents/${DIR}/${cfg.device}.json`, {
      method: "PUT",
      body: JSON.stringify({ message: `sync ${cfg.device}`, content: toBase64(text), branch: "main", ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw Object.assign(new Error(`保存できませんでした (${res.status})`), { conflict: res.status === 409 || res.status === 422 });
    return (await res.json()).content.sha;
  }

  // ---- 形式の変換(小さくして預ける) ----
  function pack(rec) {
    const { log, exported_at, ...rest } = rec;  // exported_at は毎回変わるので入れない
    return { ...rest, cols: COLS, rows: log.map((r) => COLS.map((k) => r[k] ?? null)) };
  }

  function unpack(p) {
    const { cols, rows, ...rest } = p;
    return { ...rest, log: rows.map((row) => ({ ...Object.fromEntries(cols.map((k, i) => [k, row[i]])), status_before: null, interval_after: null })) };
  }

  const hash = (s) => {  // cyrb53
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };

  // ---- 同期の本体 ----
  function run() {
    if (!configured()) return Promise.resolve(null);
    if (!running) {
      running = sync().finally(() => { running = null; });
    }
    return running;
  }

  async function sync() {
    status({ state: "syncing" });
    try {
      let result = await attempt();
      if (result.conflict) result = await attempt();  // 他の端末と同時に書いたときは取得からやり直す
      state.last_ok = new Date().toISOString();
      write(KEY_STATE, state);
      status({ state: "ok", at: state.last_ok });
      return result;
    } catch (e) {
      status({ state: e.offline ? "offline" : "error", message: e.message });
      if (e.offline) return null;
      throw e;
    }
  }

  async function attempt() {
    const files = await listFiles();
    let merged = 0;
    for (const f of files) {
      if (f.name === `${cfg.device}.json` || state.seen[f.name] === f.sha) continue;
      const r = await opts.importFn(unpack(JSON.parse(await fetchBlob(f.sha))));
      merged += (r.added || 0) + (r.flags || 0) + (r.settings || []).length;
      state.seen[f.name] = f.sha;
    }
    const text = JSON.stringify(pack(await opts.exportFn()));
    const own = files.find((f) => f.name === `${cfg.device}.json`);
    let pushed = false;
    if (!own || hash(text) !== state.own_hash) {
      try {
        await putOwn(text, own?.sha);
      } catch (e) {
        if (e.conflict) return { merged, pushed: false, conflict: true };
        throw e;
      }
      state.own_hash = hash(text);
      pushed = true;
      opts.onPushed();
    }
    return { merged, pushed };
  }

  // 評価の直後など、少し待ってからまとめて同期する
  function soon(ms = 15000) {
    if (!configured()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { run().then((r) => opts.onSynced?.(r)).catch(() => {}); }, ms);
  }

  async function test() {  // 接続の確認(トークンとリポジトリが合っているか)
    const res = await gh("");
    if (!res.ok) throw new Error(`接続できませんでした (${res.status})`);
    const info = await res.json();
    if (info.permissions && !info.permissions.push) throw new Error("このトークンには書き込み権限がありません(Contents を Read and write にしてください)");
    if (info.private === false) throw new Error("このリポジトリは公開されています。学習記録を預けるので、非公開のリポジトリを使ってください");
  }

  return { init, configured, config, configure, disconnect, lastOk, run, soon, test, pack, unpack };
})();
