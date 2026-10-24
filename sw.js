"use strict";

// アプリ本体(HTML/JS/CSS/アイコン)を端末にしまって、圏外でも開けるようにする。
// 教材のデータと学習記録は IndexedDB に入っていて、ここでは扱わない。
// 公開するときは CACHE の版を内容に合わせて更新する(riron publish)。
const CACHE = "riron-app-a93afeb731";
const SHELL = ["./", "index.html", "style.css", "srs.js", "local.js", "sync.js", "app.js", "manifest.webmanifest", "icon-180.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // 同じ版の中の組み合わせを保つため、しまってあるものを優先して返す
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
