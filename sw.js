// ハイパーロボットのサービスワーカー。
// アプリ本体（HTML/CSS/JS/アイコン）をキャッシュしておき、オフラインでも
// 起動できるようにする。
//
// CACHE_VERSION は、配布ファイルを更新したら必ず上げること。ここを上げると
// 古いキャッシュが破棄され、次回起動時に新しいファイルが読み込まれる。
const CACHE_VERSION = "hyper-robots-v1";

// アプリの見た目・動作に必要な自前のファイル一式。
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./boards.js",
  "./engine.js",
  "./game.js",
  "./profile.js",
  "./network.js",
  "./online.js",
  "./multiplayer.js",
  "./title.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // 1つでも失敗すると addAll 全体が失敗してインストールできなくなるので、
      // 個別に入れて、取れなかったものは黙って諦める。
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => {
            /* このファイルはキャッシュできなかった。致命的ではない。 */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // オンライン対戦は常に最新の通信が必要なので、PeerJS の配信サーバや
  // シグナリング通信はキャッシュせず、そのままネットワークに任せる。
  if (!sameOrigin) return;

  // HTML（ページ本体）はネットワーク優先。更新をすぐ反映したいため。
  // 通信できない時だけキャッシュを使う。
  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  // それ以外（CSS/JS/画像）はキャッシュ優先。表示が速く、オフラインでも動く。
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // 正常に取れたものだけ保存する（エラー応答を保存しない）。
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
