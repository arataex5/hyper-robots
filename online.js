/*
 * online.js — オンライン対戦モードの進行を担当します。
 * ------------------------------------------------------------
 * network.js（P2P通信）の上に乗る「アプリケーション層」です。
 * ロビー画面・ルーム画面のUI、ルーム設定・プレイヤー一覧・準備完了/
 * ゲーム開始の流れ、切断時のホスト自動引き継ぎとCPU代打ち、そして
 * 実際の対戦（同時に最短手を考え、宣言し合い、検証する）ラウンドの
 * 進行を管理します。
 *
 * 通信そのもの（PeerJSのメッシュ接続・切断検知・ホスト選出）は
 * network.js が持っており、ここではその上でやり取りする「アプリ
 * メッセージ」の意味づけと、それに応じた画面表示だけを担当します。
 */

(function () {
  "use strict";

  const TIME_LIMIT_OPTIONS = [30, 60, 90, 120, 180, 300];
  const DEFAULT_SETTINGS = {
    colorMode: "four",
    diagonals: false,
    answerTimeLimit: 60,
    playUntilEnd: true,
    disconnectMode: "wait", // "wait" | "cpu"
  };
  const WAIT_MODE_TIMEOUT_SEC = 60;

  let room = null; // { roomId, roomName, hostPeerId, settings, players: [...], phase }
  let myPeerId = null;
  let iAmHost = false;
  let waitTimers = {}; // peerId -> intervalId（プレイヤー待機モードの60秒カウント）

  // ================= ユーティリティ =================

  function myProfile() {
    return typeof window.getPlayerProfile === "function"
      ? window.getPlayerProfile()
      : { name: "プレイヤー", parts: {} };
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setLobbyStatus(text) {
    const line = el("online-status-line");
    if (line) line.textContent = text || "";
  }

  function setRoomStatus(text) {
    const line = el("room-status-line");
    if (line) line.textContent = text || "";
  }

  function defaultPlayerName(joinOrder) {
    return `プレイヤー${joinOrder + 1}`;
  }

  // ================= ルーム状態の構築・同期（ホスト側が権威を持つ） =================

  function buildInitialRoomState(roomId, hostProfile) {
    return {
      roomId,
      roomName: `${hostProfile.name || "プレイヤー"}の部屋`,
      hostPeerId: myPeerId,
      settings: { ...DEFAULT_SETTINGS },
      players: [
        {
          peerId: myPeerId,
          joinOrder: 0,
          name: hostProfile.name,
          profile: hostProfile,
          ready: false,
          connected: true,
          isCpu: false,
        },
      ],
      phase: "lobby",
    };
  }

  function broadcastRoomState() {
    if (!room) return;
    window.HRNet.broadcastApp({ type: "room-state", state: room });
    renderRoom();
  }

  function findPlayer(peerId) {
    return room ? room.players.find((p) => p.peerId === peerId) : null;
  }

  // ================= 画面描画 =================

  function renderRoom() {
    if (!room) return;
    const nameDisplay = el("room-name-display");
    if (nameDisplay) nameDisplay.textContent = room.roomName;
    const idDisplay = el("room-id-display");
    if (idDisplay) idDisplay.textContent = room.roomId;

    renderSettingsPanel();
    renderPlayerList();
    renderDisconnectControls();
    renderActionButtons();
  }

  function renderSettingsPanel() {
    const panel = el("room-settings-panel");
    if (!panel) return;
    const editable = iAmHost;
    panel.querySelectorAll(".mini-option").forEach((btn) => {
      btn.disabled = !editable;
      btn.classList.toggle("readonly", !editable);
    });

    const colorGroup = el("room-setting-colormode");
    if (colorGroup) {
      Array.from(colorGroup.children).forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.value === room.settings.colorMode);
      });
    }
    const diagGroup = el("room-setting-diagonals");
    if (diagGroup) {
      const val = room.settings.diagonals ? "on" : "off";
      Array.from(diagGroup.children).forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.value === val);
      });
    }
    const timeGroup = el("room-setting-timelimit");
    if (timeGroup) {
      Array.from(timeGroup.children).forEach((btn) => {
        btn.classList.toggle("selected", Number(btn.dataset.value) === room.settings.answerTimeLimit);
      });
    }
    const endGroup = el("room-setting-playuntilend");
    if (endGroup) {
      const val = room.settings.playUntilEnd ? "on" : "off";
      Array.from(endGroup.children).forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.value === val);
      });
    }
  }

  function renderPlayerList() {
    const list = el("room-player-list");
    if (!list) return;
    list.innerHTML = "";
    room.players.forEach((p) => {
      const row = document.createElement("div");
      row.className = "room-player-row" + (p.connected ? "" : " disconnected");

      const avatarBox = document.createElement("div");
      avatarBox.className = "room-player-avatar";
      if (typeof window.renderProfileAvatar === "function") {
        window.renderProfileAvatar(avatarBox, p.profile);
      }
      row.appendChild(avatarBox);

      const nameSpan = document.createElement("span");
      nameSpan.className = "room-player-name";
      nameSpan.textContent = p.name || defaultPlayerName(p.joinOrder);
      if (p.peerId === room.hostPeerId) nameSpan.textContent += "（ホスト）";
      if (p.isCpu) nameSpan.textContent += "［CPU代打ち］";
      if (!p.connected && !p.isCpu) nameSpan.textContent += "［切断中］";
      row.appendChild(nameSpan);

      const readyBadge = document.createElement("span");
      readyBadge.className = "room-player-ready" + (p.ready ? " is-ready" : "");
      readyBadge.textContent = p.ready ? "準備完了" : "未準備";
      row.appendChild(readyBadge);

      list.appendChild(row);
    });
  }

  function renderDisconnectControls() {
    const box = el("room-disconnect-controls");
    if (!box) return;
    const anyDisconnected = room.players.some((p) => !p.connected && p.peerId !== myPeerId);
    box.classList.toggle("hidden", !(iAmHost && anyDisconnected));
    if (!(iAmHost && anyDisconnected)) return;

    const label = el("room-disconnect-label");
    const toggleBtn = el("btn-disconnect-mode-toggle");
    if (room.settings.disconnectMode === "wait") {
      if (label) label.textContent = "切断中のプレイヤーがいます。プレイヤー待機モード中（60秒待って戻らなければCPUが代打ちします）。";
      if (toggleBtn) toggleBtn.textContent = "CPU代打ちモードに切り替え";
    } else {
      if (label) label.textContent = "切断中のプレイヤーがいます。CPU代打ちモード中です。";
      if (toggleBtn) toggleBtn.textContent = "プレイヤー待機モードに切り替え";
    }
  }

  function renderActionButtons() {
    const readyBtn = el("btn-room-ready");
    const startBtn = el("btn-room-start");
    const me = findPlayer(myPeerId);
    if (readyBtn) {
      // ホストは準備完了ボタンを押す必要がない（対戦相手ではなく進行役なので）
      readyBtn.classList.toggle("hidden", iAmHost);
      if (me && !iAmHost) readyBtn.textContent = me.ready ? "準備解除" : "準備完了";
    }
    if (startBtn) {
      startBtn.classList.toggle("hidden", !iAmHost);
      startBtn.disabled = !(iAmHost && allNonHostReady());
    }
  }

  // ================= メッセージ処理 =================

  function handleAppMessage(from, msg) {
    if (msg.type === "room-state") {
      room = msg.state;
      iAmHost = window.HRNet.isHost();
      renderRoom();
    } else if (msg.type === "ready-toggle" && iAmHost) {
      const p = findPlayer(msg.peerId);
      if (p) p.ready = !p.ready;
      broadcastRoomState();
    } else if (msg.type === "leave-room" && iAmHost) {
      room.players = room.players.filter((p) => p.peerId !== msg.peerId);
      broadcastRoomState();
    } else if (msg.type === "start-game") {
      beginOnlineGame(msg);
    } else if (
      msg.type === "goal-reveal" ||
      msg.type === "declare-update" ||
      msg.type === "round-result" ||
      msg.type === "round-invalid" ||
      msg.type === "verify-request" ||
      msg.type === "giveup-vote" ||
      msg.type === "giveup-tally" ||
      msg.type === "giveup-reveal"
    ) {
      handleGameMessage(msg);
    } else if (msg.type === "verify-submit" && iAmHost) {
      verifySubmission(msg);
    }
  }

  // ================= ロビー・ルーム操作 =================

  function onEnterLobby() {
    setLobbyStatus("");
    const input = el("join-room-id-input");
    if (input) input.value = "";
  }

  function onLeaveLobby() {
    // ルームに入っていなければ何もしない
  }

  async function createRoom() {
    const profile = myProfile();
    setLobbyStatus("ルームを作成しています…");
    const { roomId } = await window.HRNet.hostRoom(profile);
    myPeerId = window.HRNet.getMyPeerId();
    iAmHost = true;
    room = buildInitialRoomState(roomId, profile);
    wireNetworkEvents();
    renderRoom();
    setLobbyStatus("");
  }

  async function joinRoom(inputRoomId) {
    const profile = myProfile();
    setLobbyStatus("ルームに接続しています…");
    const result = await window.HRNet.joinRoom(inputRoomId, profile);
    myPeerId = result.peerId;
    iAmHost = false;
    wireNetworkEvents();
    setLobbyStatus("");
    // room-state はホストから届き次第 renderRoom() される
  }

  function leaveRoom() {
    if (room) {
      window.HRNet.broadcastApp({ type: "leave-room", peerId: myPeerId });
    }
    window.HRNet.leaveRoom();
    room = null;
    iAmHost = false;
    Object.values(waitTimers).forEach((t) => clearInterval(t));
    waitTimers = {};
  }

  function toggleMyReady() {
    if (!room) return;
    const me = findPlayer(myPeerId);
    if (!me) return;
    if (iAmHost) {
      me.ready = !me.ready;
      broadcastRoomState();
    } else {
      window.HRNet.broadcastApp({ type: "ready-toggle", peerId: myPeerId });
    }
  }

  function updateSetting(key, value) {
    if (!room || !iAmHost) return;
    room.settings[key] = value;
    broadcastRoomState();
  }

  function toggleDisconnectMode() {
    if (!room || !iAmHost) return;
    room.settings.disconnectMode = room.settings.disconnectMode === "wait" ? "cpu" : "wait";
    if (room.settings.disconnectMode === "cpu") {
      // 切断中の全員をその場でCPU代打ちに切り替える
      room.players.forEach((p) => {
        if (!p.connected) p.isCpu = true;
      });
      Object.values(waitTimers).forEach((t) => clearInterval(t));
      waitTimers = {};
    }
    broadcastRoomState();
  }

  function allNonHostReady() {
    if (!room) return false;
    const others = room.players.filter((p) => p.peerId !== room.hostPeerId && p.connected && !p.isCpu);
    return others.length > 0 && others.every((p) => p.ready);
  }

  function startGameFromRoom() {
    if (!room || !iAmHost) return;
    if (!allNonHostReady()) {
      setRoomStatus("全員が準備完了するまでゲームを開始できません。");
      return;
    }
    const colors = room.settings.colorMode === "five" ? COLOR_SETS.five : COLOR_SETS.four;
    const board = window.generateBoard({ useDiagonals: room.settings.diagonals, colors });
    const targetQueue = shuffleArray(board.targets);
    const payload = {
      type: "start-game",
      board: serializeBoard(board),
      colorMode: room.settings.colorMode,
      diagonals: room.settings.diagonals,
      targetOrder: targetQueue,
      settings: room.settings,
      players: room.players,
    };
    room.phase = "in-game";
    window.HRNet.broadcastApp(payload);
    beginOnlineGame(payload);
  }

  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function serializeBoard(board) {
    return {
      hWalls: Array.from(board.hWalls),
      vWalls: Array.from(board.vWalls),
      blocked: Array.from(board.blocked),
      diagonals: Array.from(board.diagonals ? board.diagonals.entries() : []),
      targets: board.targets,
    };
  }

  function deserializeBoard(data) {
    return {
      hWalls: new Set(data.hWalls),
      vWalls: new Set(data.vWalls),
      blocked: new Set(data.blocked),
      diagonals: new Map(data.diagonals || []),
      targets: data.targets,
    };
  }

  // ================= 切断・ホスト引き継ぎへの対応 =================

  function onPeerListChanged(peerList) {
    if (!room) return;
    peerList.forEach((netP) => {
      const p = findPlayer(netP.peerId);
      if (p) {
        const wasConnected = p.connected;
        p.connected = netP.connected;
        if (wasConnected && !p.connected) onPlayerDisconnected(p);
        if (!wasConnected && p.connected) onPlayerReconnected(p);
      } else if (netP.connected) {
        room.players.push({
          peerId: netP.peerId,
          joinOrder: netP.joinOrder,
          name: (netP.profile && netP.profile.name) || defaultPlayerName(netP.joinOrder),
          profile: netP.profile,
          ready: false,
          connected: true,
          isCpu: false,
        });
        room.players.sort((a, b) => a.joinOrder - b.joinOrder);
      }
    });
    if (iAmHost) broadcastRoomState();
    else renderRoom();
  }

  function onPlayerDisconnected(p) {
    if (!iAmHost || !room) return;
    if (room.settings.disconnectMode === "cpu") {
      p.isCpu = true;
      return;
    }
    // プレイヤー待機モード：60秒待って戻らなければCPU代打ちにする
    if (waitTimers[p.peerId]) clearInterval(waitTimers[p.peerId]);
    let remaining = WAIT_MODE_TIMEOUT_SEC;
    waitTimers[p.peerId] = setInterval(() => {
      remaining--;
      if (remaining <= 0 || p.connected) {
        clearInterval(waitTimers[p.peerId]);
        delete waitTimers[p.peerId];
        if (!p.connected) {
          p.isCpu = true;
          broadcastRoomState();
        }
      }
    }, 1000);
  }

  function onPlayerReconnected(p) {
    if (waitTimers[p.peerId]) {
      clearInterval(waitTimers[p.peerId]);
      delete waitTimers[p.peerId];
    }
    p.isCpu = false;
  }

  function onHostChanged(newHostPeerId) {
    iAmHost = newHostPeerId === myPeerId;
    if (room) {
      room.hostPeerId = newHostPeerId;
      if (iAmHost) broadcastRoomState();
      else renderRoom();
    }
  }

  function wireNetworkEvents() {
    window.HRNet.on("app-message", (m) => handleAppMessage(m.from, m.payload));
    window.HRNet.on("peer-list-changed", onPeerListChanged);
    window.HRNet.on("host-changed", onHostChanged);
  }

  // ================= ゲーム本編（宣言・検証レース） =================
  // このセクションはオンライン対戦の核となる部分ですが、実機（2つの
  // ブラウザタブ間）でのテストは本サンドボックス環境では行えないため、
  // 公開後の実地での動作確認を特におすすめします。

  function beginOnlineGame(payload) {
    const board = deserializeBoard(payload.board);
    if (typeof window.startOnlineHyperRobotsGame === "function") {
      window.startOnlineHyperRobotsGame({
        board,
        colorMode: payload.colorMode,
        players: payload.players || (room ? room.players : []),
        targetOrder: payload.targetOrder,
        settings: payload.settings || (room ? room.settings : DEFAULT_SETTINGS),
        myPeerId,
        isHost: iAmHost,
        net: {
          broadcast: (m) => window.HRNet.broadcastApp(m),
        },
      });
    }
    const overlay = el("title-screen");
    if (overlay) overlay.classList.add("hidden");
    document.body.classList.remove("title-active");
  }

  function handleGameMessage(msg) {
    if (typeof window.handleOnlineGameMessage === "function") {
      window.handleOnlineGameMessage(msg);
    }
  }

  function verifySubmission(msg) {
    if (typeof window.verifyOnlineSubmission === "function") {
      window.verifyOnlineSubmission(msg);
    }
  }

  // ================= UIイベント配線 =================

  function wireRoomSettingButtons() {
    [
      ["room-setting-colormode", "colorMode", (v) => v],
      ["room-setting-diagonals", "diagonals", (v) => v === "on"],
      ["room-setting-timelimit", "answerTimeLimit", (v) => Number(v)],
      ["room-setting-playuntilend", "playUntilEnd", (v) => v === "on"],
    ].forEach(([groupId, key, transform]) => {
      const group = el(groupId);
      if (!group) return;
      Array.from(group.children).forEach((btn) => {
        btn.addEventListener("click", () => {
          if (!iAmHost) return;
          updateSetting(key, transform(btn.dataset.value));
        });
      });
    });

    const readyBtn = el("btn-room-ready");
    if (readyBtn) readyBtn.addEventListener("click", toggleMyReady);
    const startBtn = el("btn-room-start");
    if (startBtn) startBtn.addEventListener("click", startGameFromRoom);
    const disconnectToggleBtn = el("btn-disconnect-mode-toggle");
    if (disconnectToggleBtn) disconnectToggleBtn.addEventListener("click", toggleDisconnectMode);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireRoomSettingButtons);
  } else {
    wireRoomSettingButtons();
  }

  window.HROnline = {
    onEnterLobby,
    onLeaveLobby,
    createRoom,
    joinRoom,
    leaveRoom,
    setLobbyStatus,
    setRoomStatus,
    serializeBoard,
    // テスト・デバッグ用に内部状態を覗けるようにしておく
    _getRoom: () => room,
    _isHost: () => iAmHost,
    TIME_LIMIT_OPTIONS,
  };
})();
