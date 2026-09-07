// サービスワーカーの登録。file:// で直接開いた場合や、対応していない
// ブラウザでは何もしない（登録に失敗しても、ゲーム自体は普通に動く）。
(function () {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("./sw.js").catch(function () {
      // 登録できなくてもオンライン中は普通に遊べるので、静かに諦める。
    });
  });

  // スマホのアドレスバーの高さが変わっても画面いっぱいに収まるように、
  // 実際に見えている高さを CSS 変数（--vh）として渡す。
  // 100vh はアドレスバーの分だけはみ出すことがあるため。
  function setViewportHeight() {
    document.documentElement.style.setProperty("--vh", window.innerHeight * 0.01 + "px");
  }
  setViewportHeight();
  window.addEventListener("resize", setViewportHeight);
  window.addEventListener("orientationchange", function () {
    // 回転直後はまだ古いサイズが返ることがあるので、少し待ってから測る。
    setTimeout(setViewportHeight, 200);
  });
})();
