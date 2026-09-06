/*
 * title.js — タイトル画面の構成ファイル（画面遷移の管理）
 * ------------------------------------------------------------
 * タイトル画面は4つの「画面」を持つミニSPAとして構成しています。
 *   1. メインメニュー（ソロ / オンライン対戦 の選択）
 *   2. ソロモード設定（4色/5色・斜め壁・開始ボタン）
 *   3. オンライン対戦ロビー（ルーム作成／参加）
 *   4. ルーム画面（設定・プレイヤー一覧・準備完了・開始）
 * 実際のオンライン対戦のロジック（PeerJS通信・ルーム状態管理）は
 * online.js が担当し、ここでは画面の出し入れとボタン配線だけを行う。
 */

(function () {
  "use strict";

  const TITLE_INFO = {
    title: "ハイパーロボット",
    subtitle: "一人用モード / オンライン対戦モード",
    tagline: "4色のロボットを操り、最短手順でゴールを目指せ。",
    startLabel: "ゲームをはじめる",
    points: [
      "ロボットは壁や他のロボットにぶつかるまで止まれない",
      "他の色のロボットを壁代わりに使ってもOK",
      "コンピュータも裏で最短手順を計算中。答え合わせで比べてみよう",
    ],
  };

  let selectedMode = "four";

  function showScreen(screenId) {
    document.querySelectorAll(".title-screen-panel").forEach((el) => {
      el.classList.toggle("hidden", el.id !== screenId);
    });
  }

  function buildMainMenu() {
    const overlay = document.getElementById("title-screen");
    if (!overlay) return;
    const heading = overlay.querySelector(".title-heading");
    const subtitle = overlay.querySelector(".title-subtitle");
    const tagline = overlay.querySelector(".title-tagline");
    const list = overlay.querySelector(".title-points");

    if (heading) heading.textContent = TITLE_INFO.title;
    if (subtitle) subtitle.textContent = TITLE_INFO.subtitle;
    if (tagline) tagline.textContent = TITLE_INFO.tagline;
    if (list) {
      list.innerHTML = "";
      TITLE_INFO.points.forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        list.appendChild(li);
      });
    }

    const gotoSolo = document.getElementById("btn-goto-solo");
    if (gotoSolo) gotoSolo.addEventListener("click", () => showScreen("screen-solo-settings"));

    const gotoOnline = document.getElementById("btn-goto-online");
    if (gotoOnline) {
      gotoOnline.addEventListener("click", () => {
        showScreen("screen-online-lobby");
        if (typeof window.HROnline === "object" && typeof window.HROnline.onEnterLobby === "function") {
          window.HROnline.onEnterLobby();
        }
      });
    }
  }

  function buildSoloScreen() {
    const modeButtons = Array.from(document.querySelectorAll("#screen-solo-settings .mode-option"));
    const diagonalToggle = document.getElementById("diagonal-toggle");
    const backBtn = document.getElementById("btn-solo-back");
    const startBtn = document.getElementById("btn-solo-start");

    modeButtons.forEach((mbtn) => {
      mbtn.addEventListener("click", () => {
        selectedMode = mbtn.dataset.mode === "five" ? "five" : "four";
        modeButtons.forEach((b) => b.classList.toggle("selected", b === mbtn));
      });
    });

    if (backBtn) backBtn.addEventListener("click", () => showScreen("screen-main-menu"));

    if (startBtn) {
      startBtn.textContent = TITLE_INFO.startLabel;
      startBtn.addEventListener("click", () => {
        const useDiagonals = !!(diagonalToggle && diagonalToggle.checked);
        document.getElementById("title-screen").classList.add("hidden");
        document.body.classList.remove("title-active");
        if (typeof window.startHyperRobotsGame === "function") {
          window.startHyperRobotsGame(selectedMode, useDiagonals);
        }
      });
    }
  }

  function buildOnlineScreens() {
    const backBtn = document.getElementById("btn-online-back");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        showScreen("screen-main-menu");
        if (typeof window.HROnline === "object" && typeof window.HROnline.onLeaveLobby === "function") {
          window.HROnline.onLeaveLobby();
        }
      });
    }

    const roomLeaveBtn = document.getElementById("btn-room-leave");
    if (roomLeaveBtn) {
      roomLeaveBtn.addEventListener("click", () => {
        if (typeof window.HROnline === "object" && typeof window.HROnline.leaveRoom === "function") {
          window.HROnline.leaveRoom();
        }
        showScreen("screen-online-lobby");
      });
    }

    const createBtn = document.getElementById("btn-create-room");
    if (createBtn) {
      createBtn.addEventListener("click", async () => {
        if (typeof window.HROnline !== "object") return;
        createBtn.disabled = true;
        try {
          await window.HROnline.createRoom();
          showScreen("screen-room");
        } catch (e) {
          window.HROnline.setLobbyStatus(e.message || "ルームを作成できませんでした。");
        } finally {
          createBtn.disabled = false;
        }
      });
    }

    const copyRoomIdBtn = document.getElementById("btn-copy-room-id");
    if (copyRoomIdBtn) {
      let copyToastTimer = null;
      copyRoomIdBtn.addEventListener("click", async () => {
        const idEl = document.getElementById("room-id-display");
        const roomId = idEl ? idEl.textContent : "";
        if (!roomId) return;
        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(roomId);
            copied = true;
          }
        } catch (e) {
          copied = false;
        }
        if (!copied) {
          // クリップボードAPIが使えない環境向けのフォールバック
          try {
            const textarea = document.createElement("textarea");
            textarea.value = roomId;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            copied = document.execCommand("copy");
            document.body.removeChild(textarea);
          } catch (e) {
            copied = false;
          }
        }
        const toast = document.getElementById("room-id-copied-toast");
        if (toast && copied) {
          toast.textContent = "コピーしました";
          toast.classList.remove("show");
          // eslint-disable-next-line no-unused-expressions
          void toast.offsetWidth;
          toast.classList.add("show");
          if (copyToastTimer) clearTimeout(copyToastTimer);
          copyToastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
        } else if (toast && !copied) {
          toast.textContent = "コピーできませんでした";
          toast.classList.remove("show");
          void toast.offsetWidth;
          toast.classList.add("show");
          if (copyToastTimer) clearTimeout(copyToastTimer);
          copyToastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
        }
      });
    }

    const joinBtn = document.getElementById("btn-join-room");
    const joinInput = document.getElementById("join-room-id-input");
    if (joinInput) {
      joinInput.addEventListener("input", () => {
        joinInput.value = joinInput.value.replace(/[^0-9]/g, "").slice(0, 5);
      });
    }
    if (joinBtn) {
      joinBtn.addEventListener("click", async () => {
        if (typeof window.HROnline !== "object") return;
        const roomIdValue = joinInput ? joinInput.value : "";
        joinBtn.disabled = true;
        try {
          await window.HROnline.joinRoom(roomIdValue);
          showScreen("screen-room");
        } catch (e) {
          window.HROnline.setLobbyStatus(e.message || "ルームに参加できませんでした。");
        } finally {
          joinBtn.disabled = false;
        }
      });
    }
  }

  function init() {
    buildMainMenu();
    buildSoloScreen();
    buildOnlineScreens();
    showScreen("screen-main-menu");
  }

  init();

  // ゲーム画面の「タイトルへ戻る」ボタンから呼ばれたとき、常にメインメニューへ戻す
  window.addEventListener("hr-return-to-title", () => showScreen("screen-main-menu"));
})();
