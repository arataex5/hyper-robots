/*
 * online.js — オンライン対戦モードの進行を担当します。
 * ------------------------------------------------------------
 * network.js（P2P通信）の上に乗る「アプリケーション層」です。
 * ロビー画面・ルーム画面のUI、ルーム設定・プレイヤー一覧・準備完了/
 * ゲーム開始の流れ、切断時のホスト自動引き継ぎと再接続、そして
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
    nextReadyTimeout: 30, // 秒数 | "unlimited"（時間制限なし） | "off"（準備確認自体をしない）
    showBigCountdown: true, // 勝敗判定までの残り時間を、画面中央上側にデカデカと表示するかどうか
  };

  let room = null; // { roomId, roomName, hostPeerId, settings, players: [...], phase }
  let myPeerId = null;
  let iAmHost = false;

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
          token: window.HRNet.getMyToken(),
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
    const nextReadyGroup = el("room-setting-nextready");
    if (nextReadyGroup) {
      const val = String(room.settings.nextReadyTimeout);
      Array.from(nextReadyGroup.children).forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.value === val);
      });
    }
    const bigCountdownGroup = el("room-setting-bigcountdown");
    if (bigCountdownGroup) {
      const val = room.settings.showBigCountdown ? "on" : "off";
      Array.from(bigCountdownGroup.children).forEach((btn) => {
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
      if (!p.connected) nameSpan.textContent += "［切断中］";
      row.appendChild(nameSpan);

      const readyBadge = document.createElement("span");
      const isHostRow = p.peerId === room.hostPeerId;
      readyBadge.className = "room-player-ready" + (p.ready || isHostRow ? " is-ready" : "");
      readyBadge.textContent = isHostRow ? "ホスト" : p.ready ? "準備完了" : "未準備";
      row.appendChild(readyBadge);

      list.appendChild(row);
    });
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
      const isFreshJoin = room === null;
      room = msg.state;
      iAmHost = window.HRNet.isHost();
      if (isFreshJoin && room.phase === "in-game" && !window.__HR_ONLINE_ACTIVE) {
        // 対局中のルームに、ロビーを経由せず参加しようとしている
        // （タブを閉じた／タイトルへ戻った後の再合流）。ロビー画面は
        // 出さず、ホストからの resume-game を待つ。
        setLobbyStatus("対局に合流しています…");
      } else {
        renderRoom();
      }
    } else if (msg.type === "resume-game") {
      resumeOnlineGame(msg);
    } else if (msg.type === "player-remapped") {
      if (typeof window.remapOnlinePlayerId === "function") {
        window.remapOnlinePlayerId(msg.oldPeerId, msg.newPeerId);
      }
    } else if (msg.type === "ready-toggle" && iAmHost) {
      const p = findPlayer(msg.peerId);
      if (p) p.ready = !p.ready;
      broadcastRoomState();
    } else if (msg.type === "leave-room" && iAmHost) {
      // 対局中の場合は完全に削除せず「切断」扱いにしておく。こうしないと
      // トークンが紐づくエントリごと消えてしまい、後で同じ相手が
      // 戻ってきた時に再接続と認識できず、別人として扱われてしまう。
      // まだロビー段階（対局が始まっていない）なら、素直に一覧から外す。
      if (room.phase === "in-game") {
        const p = findPlayer(msg.peerId);
        if (p) p.connected = false;
      } else {
        room.players = room.players.filter((p) => p.peerId !== msg.peerId);
      }
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
      msg.type === "giveup-concede-tally" ||
      msg.type === "giveup-countdown-start" ||
      msg.type === "giveup-cancelled" ||
      msg.type === "giveup-reveal" ||
      msg.type === "next-ready" ||
      msg.type === "next-ready-tally" ||
      msg.type === "nextready-countdown-start" ||
      msg.type === "match-over"
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
    // welcome の直後（対局中の再合流なら resume-game も）が届く前に
    // ハンドラを確実に登録しておく。HRNet.joinRoom() の完了を待ってから
    // 配線すると、その間に届いたメッセージを取りこぼす恐れがある。
    wireNetworkEvents();
    const result = await window.HRNet.joinRoom(inputRoomId, profile);
    myPeerId = result.peerId;
    iAmHost = false;
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
    // myPeerId をリセットし忘れると、タブを閉じずに（＝ページを再読み込み
    // せずに）「タイトルへ戻る→再度参加する」を行った時、joinRoom()の
    // 中で新しいpeerIdが代入されるより前に届いたゲーム関連メッセージ
    // （"resume-game"等）の処理で、この古い値のまま mp.myPeerId が
    // 組み立てられてしまう。その結果、mp.players のどのエントリとも
    // 一致しない「透明人間」状態になる
    // （操作はできるが、誰からも自分として認識されない）。
    myPeerId = null;
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


  function allNonHostReady() {
    if (!room) return false;
    const others = room.players.filter((p) => p.peerId !== room.hostPeerId && p.connected);
    return others.length > 0 && others.every((p) => p.ready);
  }

  function startGameFromRoom() {
    if (!room || !iAmHost) return;
    if (!allNonHostReady()) {
      setRoomStatus("全員が準備完了するまでゲームを開始できません。");
      return;
    }
    const colors = room.settings.colorMode === "five" ? COLOR_SETS.five : COLOR_SETS.four;
    if (typeof window.showMapGenOverlay === "function") window.showMapGenOverlay();
    const generator = window.createIncrementalBoardGenerator({ useDiagonals: room.settings.diagonals, colors });
    function step() {
      const res = generator.step(80);
      if (res.status !== "done") {
        setTimeout(step, 0);
        return;
      }
      if (typeof window.hideMapGenOverlay === "function") window.hideMapGenOverlay();
      const board = res.board;
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
    step();
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

  function mergeGhostInto(target, oldPeerId) {
    if (typeof window.remapOnlinePlayerId === "function") {
      window.remapOnlinePlayerId(oldPeerId, target.peerId);
    }
  }

  function onPeerListChanged(peerList) {
    if (!room) return;
    peerList.forEach((netP) => {
      const p = findPlayer(netP.peerId);
      if (p) {
        const wasConnected = p.connected;
        p.connected = netP.connected;
        // プロフィール（名前・アイコン）が後から届いた場合（"hello"メッセージ経由）は反映する
        if (netP.profile && netP.profile.name) {
          p.profile = netP.profile;
          p.name = netP.profile.name;
        }
        if (netP.token && !p.token) {
          p.token = netP.token;
          // tokenが後から分かった時点で、同じtokenを持つ「切断中」の
          // 別エントリ（＝先に接続イベントだけ処理されて出来た別人扱いの
          // ゴースト）が無いか確認し、あれば統合する。
          const ghost = room.players.find((pl) => pl !== p && pl.token === netP.token && !pl.connected);
          if (ghost) {
            const oldPeerId = ghost.peerId;
            room.players = room.players.filter((pl) => pl !== ghost);
            mergeGhostInto(p, oldPeerId);
            if (iAmHost) {
              window.HRNet.broadcastApp({ type: "player-remapped", oldPeerId, newPeerId: p.peerId });
            }
          }
        }
        // 切断・復帰しても特別なモード切り替えは行わない。無操作のまま
        // 置いておくだけで、戻ってくれば通常通り操作を再開できる。
      } else if (netP.connected) {
        // 同じ token を持つ「切断中」のプレイヤーがいれば、新規参加では
        // なく本人の再接続として扱う（PeerJSは参加のたびに新しいpeerIdを
        // 振るため、tokenで見分けないと毎回「別人」に見えてしまう）
        const ghost = netP.token
          ? room.players.find((pl) => pl.token && pl.token === netP.token && !pl.connected)
          : null;
        if (ghost) {
          const oldPeerId = ghost.peerId;
          ghost.peerId = netP.peerId;
          ghost.connected = true;
          ghost.joinOrder = netP.joinOrder;
          if (netP.profile && netP.profile.name) {
            ghost.profile = netP.profile;
            ghost.name = netP.profile.name;
          }
          room.players.sort((a, b) => a.joinOrder - b.joinOrder);
          mergeGhostInto(ghost, oldPeerId);
          // ホストは、この付け替え（旧peerId→新peerId）を全員に明示的に
          // 知らせる。room-state のブロードキャストは room オブジェクトを
          // まるごと上書きするだけで、それを受け取った側の
          // multiplayer.js（mp.players・mp.scores等）までは連動して
          // 書き換えてくれない。そのため、自分では再接続を検知できな
          // かった（room-stateで結果だけを受け取った）他のプレイヤーの
          // 画面では、対局中の得点や接続状態がいつまでも古いpeerIdの
          // ままになってしまう。
          if (iAmHost) {
            window.HRNet.broadcastApp({ type: "player-remapped", oldPeerId, newPeerId: netP.peerId });
          }
          // 対局中にホストがこの再接続を検知した場合、ロビーへは通さず
          // 今の対局のスナップショットをこの相手にだけ直接送る。
          if (iAmHost && room.phase === "in-game" && typeof window.isOnlineGameActive === "function" && window.isOnlineGameActive()) {
            const snap = window.getOnlineResumeSnapshot ? window.getOnlineResumeSnapshot() : null;
            if (snap) window.HRNet.sendAppTo(netP.peerId, { type: "resume-game", ...snap });
          }
        } else {
          room.players.push({
            peerId: netP.peerId,
            joinOrder: netP.joinOrder,
            name: (netP.profile && netP.profile.name) || defaultPlayerName(netP.joinOrder),
            profile: netP.profile,
            token: netP.token || null,
            ready: false,
            connected: true,
            isCpu: false,
          });
          room.players.sort((a, b) => a.joinOrder - b.joinOrder);
        }
      }
    });
    if (iAmHost) broadcastRoomState();
    else renderRoom();
    // 対局中の場合、multiplayer.js側のHUDにも接続状況の変化を反映させる。
    // multiplayer.js が独自に登録する "peer-list-changed" リスナーは
    // resumeOnlineHyperRobotsGame() の中で（=ゲーム画面に切り替わって
    // 初めて）登録されるため、再接続直後にメッシュ接続がちょうど確立
    // した瞬間のイベントを取りこぼすことがある。online.js側のこの
    // ハンドラは参加処理の最初から確実に登録されているので、ここでも
    // 呼んでおくことで、その取りこぼしを防ぐ。
    if (typeof window.refreshOnlineHud === "function") {
      window.refreshOnlineHud();
    }
  }

  function onHostChanged(newHostPeerId) {
    iAmHost = newHostPeerId === myPeerId;
    if (room) {
      const oldHostPeerId = room.hostPeerId;
      room.hostPeerId = newHostPeerId;
      // 対局が始まる前（待機画面）でホストが切り替わった場合は、
      // ここでその旨を知らせる。対局中はmultiplayer.js側のバナーで
      // 知らせるので、二重に出さないようにする。
      const gameActive = typeof window.isOnlineGameActive === "function" && window.isOnlineGameActive();
      if (room.phase !== "in-game" && !gameActive) {
        const oldHostPlayer = findPlayer(oldHostPeerId);
        const oldName = oldHostPlayer ? oldHostPlayer.name : "プレイヤー";
        const whoBecameHost = iAmHost
          ? "あなたがホストになりました"
          : (() => {
              const newHostPlayer = findPlayer(newHostPeerId);
              const newName = newHostPlayer ? newHostPlayer.name : "プレイヤー";
              return `${newName}さんがホストになりました`;
            })();
        setRoomStatus(`${oldName}さんが切断されました。${whoBecameHost}。`);
      }
      if (iAmHost) broadcastRoomState();
      else renderRoom();
    }
  }

  let networkEventsWired = false;
  function wireNetworkEvents() {
    // HRNet はページ読み込み中ずっと生き続ける単一のオブジェクトなので、
    // ルームの作成・参加のたびに呼んでも重複登録しないようにする
    // （そうしないと、退室→再参加を繰り返すたびにイベントハンドラが
    // 積み重なり、メッセージが何重にも処理されて再接続がおかしくなる）。
    if (networkEventsWired) return;
    networkEventsWired = true;
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
    // welcome の直後（対局中なら resume-game も）が届くタイミングでは
    // まだ myPeerId 変数がセットされていない可能性があるため、
    // network.js側の値を直接確認しておく（自分のIDを取り違えない）。
    if (!myPeerId) myPeerId = window.HRNet.getMyPeerId();
    // 自分がゲスト側で受け取った場合、自分自身の room オブジェクトにも
    // 「対局中」を反映しておく。これをしないと、後でホスト引き継ぎが
    // 起きた時（このゲストが新ホストになった時）に、まだロビー段階だと
    // 誤認して、再接続してきた相手をロビーへ通してしまう。
    if (room) room.phase = "in-game";
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

  // 対局中に一度離脱し、同じルームIDで戻ってきたプレイヤーを、ロビーを
  // 経由せず今の対局へ直接合流させる。ホストが resume-game で送って
  // くれたスナップショットをそのまま復元するだけで、盤面やスコアを
  // 新規に作り直したりはしない。
  function resumeOnlineGame(payload) {
    const board = deserializeBoard(payload.board);
    if (!myPeerId) myPeerId = window.HRNet.getMyPeerId();
    if (room) room.phase = "in-game";
    if (typeof window.resumeOnlineHyperRobotsGame === "function") {
      window.resumeOnlineHyperRobotsGame(
        {
          board,
          myPeerId,
          isHost: iAmHost,
          net: { broadcast: (m) => window.HRNet.broadcastApp(m) },
        },
        payload
      );
    }
    setLobbyStatus("");
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
      ["room-setting-nextready", "nextReadyTimeout", (v) => (v === "unlimited" || v === "off" ? v : Number(v))],
      ["room-setting-bigcountdown", "showBigCountdown", (v) => v === "on"],
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
