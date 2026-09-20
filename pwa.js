// サービスワーカーの登録。file:// で直接開いた場合や、対応していない
// ブラウザでは何もしない（登録に失敗しても、ゲーム自体は普通に動く）。
(function () {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("./sw.js").then(function (reg) {
      // 更新があればすぐ取りに行く。古いファイルが配信され続けて
      // 端末ごとに違う版が動く（＝対戦できない）事故を防ぐ。
      try { reg.update(); } catch (e) { /* noop */ }
      reg.addEventListener("updatefound", function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", function () {
          // 新しい版が入って、既に古い版が動いていた場合は読み込み直す。
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            window.location.reload();
          }
        });
      });
    }).catch(function () {
      // 登録できなくてもオンライン中は普通に遊べるので、静かに諦める。
    });
  });

  // どの版が動いているかを確認できるようにしておく。
  // （端末ごとに違う版が動いていないかの切り分け用）
  window.HR_BUILD = "2026-09-20-a";
  try { console.log("ハイパーロボット build:", window.HR_BUILD); } catch (e) { /* noop */ }

  // スマホのアドレスバーの高さが変わっても画面いっぱいに収まるように、
  // 実際に見えている高さを CSS 変数（--vh）として渡す。
  // 100vh はアドレスバーの分だけはみ出すことがあるため。
  // スマホでスクロールするとアドレスバーが出たり隠れたりして
  // window.innerHeight が数十px単位で変化し、そのたびに resize が飛ぶ。
  // 毎回 --vh を更新すると、それを使っているレイアウトが画面上部・下部
  // に当たるたびに伸び縮みして落ち着かない。
  // そこで「画面の向きが変わった」と言えるくらい大きく変わった時だけ
  // 更新する。アドレスバーの出入り程度（おおむね150px未満）は無視する。
  var lastH = 0;
  function setViewportHeight(force) {
    var h = window.innerHeight;
    if (!force && lastH && Math.abs(h - lastH) < 150) return;
    lastH = h;
    document.documentElement.style.setProperty("--vh", h * 0.01 + "px");
  }
  setViewportHeight(true);
  window.addEventListener("resize", function () { setViewportHeight(false); });
  window.addEventListener("orientationchange", function () {
    // 回転直後はまだ古いサイズが返ることがあるので、少し待ってから測る。
    setTimeout(function () { setViewportHeight(true); }, 200);
  });
})();
