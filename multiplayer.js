/*
 * multiplayer.js — オンライン対戦の対局本体
 * ------------------------------------------------------------
 * online.js から呼び出され、実際の盤面表示・ロボット操作・
 * 「同時に最短手を考えて宣言し合い、検証する」レースの進行を担当します。
 *
 * 設計:
 *   ・盤面はホストが1回だけ生成し、全員に配って共有する（同じ盤面）。
 *   ・各プレイヤーは自分の画面上で自由にロボットを動かして試せる
 *     （ローカルな「考え中」の状態。他の人には見えない）。
 *   ・「回答する」を押すと、その時点の手数をホストに宣言する。
 *   ・ホストは「今のところ一番少ない手数」を管理し、宣言のたびに
 *     制限時間をリセットする。時間切れになったら、その時点で一番
 *     少ない手数を宣言した人に手順の提出を求め、実際に再生して
 *     検証する（本当にその手数でゴールできるか）。成功すれば得点。
 *   ・検証はホストの盤面（ラウンド開始時点のスナップショット）を
 *     基準に行うため、全員が同じ基準で公平に判定される。
 *
 * ※ このファイルはP2P通信を介した「本物の対戦」でのみ完全に検証
 *   できる部分が多く、本サンドボックス環境ではロジック単体のテスト
 *   （宣言の比較・手順の検証など）に留めています。公開後、実際に
 *   2つのブラウザタブ／2台の端末で対戦して動作を確認してください。
 */

(function () {
  "use strict";

  let mp = null; // 対局の状態一式（下の resetMpState 参照）
  let raceFlashBannerBusyUntil = 0; // #race-flash-banner が表示中の間、round-result-banner を待たせるための締切時刻
  let lastKnownHostPeerId = null; // ホスト交代時のバナー文言に「誰が切断してホストが変わったのか」を出すために覚えておく

  function resetMpState(cfg) {
    const colors = cfg.colorMode === "five" ? COLOR_SETS.five : COLOR_SETS.four;
    // players は joinOrder 順（表示・スコア管理のためだけの並び。
    // ロボットの色とプレイヤーは1対1に対応しない — 本家のルール通り、
    // ロボットは誰でも動かせる「共有の駒」で、特定のプレイヤーの
    // 持ち物ではない）。
    const orderedPlayers = cfg.players.slice().sort((a, b) => a.joinOrder - b.joinOrder);

    mp = {
      board: cfg.board,
      colors, // ロボットの色一覧（4色 or 5色）。ロボットの数もこれに一致する。
      players: orderedPlayers,
      myPeerId: cfg.myPeerId,
      isHost: cfg.isHost,
      net: cfg.net,
      settings: cfg.settings,
      targetQueue: cfg.targetOrder,
      goalIndex: -1,
      currentGoal: null,
      robots: [],
      robotEls: [],
      cellEls: [],
      selectedRobot: null,
      arrowEls: [],
      moveHistory: [],
      historyIndex: 0,
      roundStartSnapshot: null,
      scores: {},
      roundsPlayed: 0,
      totalRounds: cfg.targetOrder.length, // 1周分のお題数。「最後まで続ける」がオフの時の決着判定に使う
      matchOver: false,
      bestDeclare: null, // { peerId, moveCount }
      lastChampionRoute: null, // { moves, startSnapshot } -- 直前のラウンドの勝者の手順（準備確認画面のリプレイ用）
      declared: false, // 自分がこのラウンドで既に宣言したか
      myDeclaredMoves: null, // 宣言した時点の手順のスナップショット
      myGiveUpVoted: false,
      giveUpVoters: new Set(), // ホスト側のみで使う集計用（チャンピオンへの降参カウント）
      countdownKind: null, // null | "declare" | "giveup" -- 今動いているカウントダウンの種類
      countdownInterval: null,
      countdownRemaining: 0,
      countdownEndTime: 0, // 絶対時刻（ms）。ホストと他プレイヤーの表示がズレないための基準。
      readyForNext: new Set(), // ホスト側のみで使う集計用（次の問題へ進む準備）
      myReadyForNext: false,
      locked: false,
      aloneTimer: null, // 自分一人になってからソロモード提案までの15秒待ちタイマー
      aloneHandled: false, // 今回の「一人になった期間」について、既に提案済み（待機する/切替済み）かどうか
      soloSuggestOverlayHiddenNextReady: false, // 提案ダイアログを出すために準備確認画面を一時的に隠したかどうか
      suddenDeathActive: false, // サドンデス中かどうか
      rematchVoters: new Set(), // リザルト画面で「もう一度遊ぶ」を押した人（ホスト側のみで使う集計用）
      giveUpRevealInProgress: false, // ギブアップ時の答え合わせ（コンピュータの探索）が実行中かどうか
    };
    orderedPlayers.forEach((p) => { mp.scores[p.peerId] = 0; });
  }

  // 対局中に一度タブを閉じた／タイトルへ戻ったプレイヤーが同じルームIDで
  // 戻ってきた場合に、ロビー画面を経由せず今の対局へ直接合流できるように
  // するためのスナップショット。ホスト側でのみ呼ばれる。
  function buildResumeSnapshot() {
    if (!mp) return null;
    return {
      board: window.HROnline.serializeBoard(mp.board),
      colorMode: mp.colors.length === 5 ? "five" : "four",
      players: mp.players,
      settings: mp.settings,
      totalRounds: mp.totalRounds,
      goalIndex: mp.goalIndex,
      currentGoal: mp.currentGoal,
      robots: mp.robots.map((p) => ({ ...p })),
      scores: { ...mp.scores },
      roundsPlayed: mp.roundsPlayed,
      matchOver: mp.matchOver,
      bestDeclare: mp.bestDeclare ? { ...mp.bestDeclare } : null,
      countdownKind: mp.countdownKind,
      countdownEndTime: mp.countdownEndTime,
      giveUpPeerIds: Array.from(mp.giveUpVoters),
      settingsForAnswerTimer: mp.settings.answerTimeLimit,
    };
  }

  // buildResumeSnapshot() の内容から mp を復元する（新規開始の
  // resetMpState と違い、進行中の状態をそのまま引き継ぐ）。
  function resetMpStateFromSnapshot(cfg, snap) {
    const colors = snap.colorMode === "five" ? COLOR_SETS.five : COLOR_SETS.four;
    const orderedPlayers = snap.players.slice().sort((a, b) => a.joinOrder - b.joinOrder);
    mp = {
      board: cfg.board,
      colors,
      players: orderedPlayers,
      myPeerId: cfg.myPeerId,
      isHost: cfg.isHost,
      net: cfg.net,
      settings: snap.settings,
      targetQueue: [],
      goalIndex: snap.goalIndex,
      currentGoal: snap.currentGoal,
      robots: snap.robots.map((p) => ({ ...p })),
      robotEls: [],
      cellEls: [],
      selectedRobot: null,
      arrowEls: [],
      moveHistory: [],
      historyIndex: 0,
      roundStartSnapshot: snap.robots.map((p) => ({ ...p })),
      scores: { ...snap.scores },
      roundsPlayed: snap.roundsPlayed,
      totalRounds: snap.totalRounds,
      matchOver: snap.matchOver,
      bestDeclare: snap.bestDeclare ? { ...snap.bestDeclare } : null,
      lastChampionRoute: null,
      declared: false,
      myDeclaredMoves: null,
      myGiveUpVoted: (snap.giveUpPeerIds || []).includes(cfg.myPeerId),
      giveUpVoters: new Set(snap.giveUpPeerIds || []),
      countdownKind: snap.countdownKind,
      countdownInterval: null,
      countdownRemaining: 0,
      countdownEndTime: snap.countdownEndTime,
      readyForNext: new Set(),
      myReadyForNext: false,
      locked: false,
      aloneTimer: null,
      aloneHandled: false,
      soloSuggestOverlayHiddenNextReady: false,
      suddenDeathActive: false,
      rematchVoters: new Set(),
      giveUpRevealInProgress: false,
    };
  }

  // ================= 盤面・ロボットの初期配置 =================

  function placeRobotsRandomly() {
    const targetCells = new Set(mp.board.targets.map((t) => `${t.r},${t.c}`));
    const placed = [];
    for (let i = 0; i < mp.colors.length; i++) {
      let r, c, key;
      let tries = 0;
      do {
        r = Math.floor(Math.random() * SIZE);
        c = Math.floor(Math.random() * SIZE);
        key = `${r},${c}`;
        tries++;
      } while (
        tries < 500 &&
        (mp.board.blocked.has(key) ||
          targetCells.has(key) ||
          (mp.board.diagonals && mp.board.diagonals.has(key)) ||
          placed.some((p) => p.r === r && p.c === c))
      );
      placed.push({ r, c });
    }
    return placed;
  }

  function setPercentPos(elm, r, c) {
    elm.style.left = (c / 16) * 100 + "%";
    elm.style.top = (r / 16) * 100 + "%";
  }

  function renderBoard() {
    const boardEl = document.getElementById("board");
    boardEl.innerHTML = "";
    mp.cellEls = [];
    const targetByCell = new Map();
    mp.board.targets.forEach((t) => targetByCell.set(`${t.r},${t.c}`, t));

    function wallBoxShadow(r, c) {
      const shadows = [];
      const t = 3;
      if (mp.board.hWalls.has(`${r},${c}`)) shadows.push(`inset 0 ${t}px 0 0 var(--wall)`);
      if (mp.board.hWalls.has(`${r + 1},${c}`)) shadows.push(`inset 0 -${t}px 0 0 var(--wall)`);
      if (mp.board.vWalls.has(`${r},${c}`)) shadows.push(`inset ${t}px 0 0 0 var(--wall)`);
      if (mp.board.vWalls.has(`${r},${c + 1}`)) shadows.push(`inset -${t}px 0 0 0 var(--wall)`);
      return shadows.join(", ");
    }

    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        if ((Math.floor(r / 2) + Math.floor(c / 2)) % 2 === 0) cell.classList.add("shade");
        const isBlocked = mp.board.blocked.has(`${r},${c}`);
        if (isBlocked) {
          cell.classList.add("blocked");
        } else {
          const shadow = wallBoxShadow(r, c);
          if (shadow) cell.style.boxShadow = shadow;
          if (r === 8) cell.style.borderTop = "1px solid rgba(20,24,40,0.22)";
          if (c === 8) cell.style.borderLeft = "1px solid rgba(20,24,40,0.22)";
          const t = targetByCell.get(`${r},${c}`);
          if (t) {
            const icon = document.createElement("div");
            icon.className = `target-icon shape-${t.shape} tint-${t.color}`;
            icon.dataset.r = r;
            icon.dataset.c = c;
            cell.appendChild(icon);
          }
        }
        boardEl.appendChild(cell);
        row.push(cell);
      }
      mp.cellEls.push(row);
    }

    const core = document.createElement("div");
    core.className = "core";
    boardEl.appendChild(core);

    if (mp.board.diagonals && mp.board.diagonals.size > 0) {
      mp.board.diagonals.forEach((diag) => {
        const dEl = document.createElement("div");
        const orientClass = diag.orientation === "/" ? "orient-slash" : "orient-backslash";
        dEl.className = `diagonal-wall ${orientClass}`;
        dEl.style.setProperty("--diag-color", `var(--c-${diag.color})`);
        setPercentPos(dEl, diag.r, diag.c);
        dEl.style.width = 100 / 16 + "%";
        dEl.style.height = 100 / 16 + "%";
        boardEl.appendChild(dEl);
      });
    }

    mp.goalArrowEl = document.createElement("div");
    mp.goalArrowEl.className = "goal-arrow-indicator";
    mp.goalArrowEl.style.display = "none";
    mp.goalArrowEl.innerHTML =
      '<span class="goal-arrow-indicator-text">ここ</span>' +
      '<div class="goal-arrow-indicator-shape">' +
      '<svg viewBox="0 0 100 44" xmlns="http://www.w3.org/2000/svg">' +
      '<polygon points="2,15 52,15 52,2 98,22 52,42 52,29 2,29" fill="#ff1a2e" stroke="#0a0a0a" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>' +
      "</svg></div>";
    boardEl.appendChild(mp.goalArrowEl);
  }

  function renderRobots() {
    const boardEl = document.getElementById("board");
    mp.robotEls.forEach((e) => e.remove());
    mp.robotEls = [];
    mp.colors.forEach((color, idx) => {
      const el = document.createElement("div");
      el.className = `robot color-${color}`;
      el.innerHTML =
        '<div class="body"><div class="face"><div class="eye"></div><div class="eye"></div></div>' +
        '<div class="mouth"></div>' +
        `<div class="label">${(COLOR_INFO[color] || {}).initial || "?"}</div></div>`;
      el.addEventListener("click", (e2) => {
        e2.stopPropagation();
        onRobotClick(idx);
      });
      boardEl.appendChild(el);
      mp.robotEls.push(el);
      setPercentPos(el, mp.robots[idx].r, mp.robots[idx].c);
    });
  }

  function refreshTargetEmphasis() {
    document.querySelectorAll("#board .target-icon.active").forEach((e) => e.classList.remove("active"));
    if (!mp.currentGoal) return;
    const icon = document.querySelector(`#board .target-icon[data-r="${mp.currentGoal.r}"][data-c="${mp.currentGoal.c}"]`);
    if (icon) icon.classList.add("active");
  }

  function placeGoalIndicator() {
    if (!mp.currentGoal) return;
    const g = mp.currentGoal;
    const p = computeGoalIndicatorPlacement(g.r, g.c);
    mp.goalArrowEl.className = `goal-arrow-indicator dir-${p.dir}`;
    mp.goalArrowEl.style.display = "flex";
    mp.goalArrowEl.style.left = p.left + "%";
    mp.goalArrowEl.style.top = p.top + "%";
    mp.goalArrowEl.style.width = p.width + "%";
    mp.goalArrowEl.style.height = p.height + "%";
  }

  // ================= ロボット移動（ローカルの「考え中」操作） =================

  const ARROW_ROTATION = { N: 0, E: 90, S: 180, W: 270 };

  function clearArrows() {
    mp.arrowEls.forEach((e) => e.remove());
    mp.arrowEls = [];
  }

  function robotColor(idx) {
    return mp.colors[idx];
  }

  function showArrowsForRobot(idx) {
    clearArrows();
    const boardEl = document.getElementById("board");
    const pos = mp.robots[idx];
    const myColor = robotColor(idx);
    ["N", "S", "E", "W"].forEach((dir) => {
      if (!window.canMoveAtAll(mp.board, mp.robots, idx, dir, myColor)) return;
      const { dr, dc } = DIRS[dir];
      const nr = pos.r + dr;
      const nc = pos.c + dc;
      const wrap = document.createElement("div");
      wrap.className = "move-arrow";
      wrap.dataset.dir = dir;
      wrap.style.transform = `rotate(${ARROW_ROTATION[dir]}deg)`;
      wrap.innerHTML = '<div class="badge"><svg viewBox="0 0 24 24"><path d="M12 4 L20 17 L4 17 Z" fill="#ffffff"/></svg></div>';
      setPercentPos(wrap, nr, nc);
      wrap.addEventListener("click", (e) => {
        e.stopPropagation();
        performMove(idx, dir);
      });
      boardEl.appendChild(wrap);
      mp.arrowEls.push(wrap);
    });
  }

  function onRobotClick(idx) {
    if (mp.locked || mp.matchOver) return;
    if (mp.selectedRobot === idx) {
      mp.selectedRobot = null;
      mp.robotEls[idx].classList.remove("selected");
      clearArrows();
      return;
    }
    if (mp.selectedRobot !== null) mp.robotEls[mp.selectedRobot].classList.remove("selected");
    mp.selectedRobot = idx;
    mp.robotEls[idx].classList.add("selected");
    showArrowsForRobot(idx);
  }

  function performMove(idx, dir) {
    if (mp.locked || mp.matchOver) return;
    const myColor = robotColor(idx);
    const result = window.slide(mp.board, mp.robots, idx, dir, myColor);
    const to = { r: result.r, c: result.c };
    const from = { ...mp.robots[idx] };
    if (to.r === from.r && to.c === from.c) return;

    mp.moveHistory = mp.moveHistory.slice(0, mp.historyIndex);
    mp.moveHistory.push({ robot: idx, dir, from, to, bends: result.bends || [] });
    mp.historyIndex++;

    // 動き始める前に一度矢印を消す。アニメーション完了後まで残していると、
    // ロボットが離れた後も元の位置に矢印が居座っているように見えてしまう。
    clearArrows();
    animateAlongPath(idx, [...(result.bends || []), to], () => {
      updateMoveCount();
      if (mp.selectedRobot === idx) showArrowsForRobot(idx);
    });
  }

  function animateAlongPath(idx, waypoints, onDone) {
    mp.locked = true;
    let i = 0;
    function step() {
      if (i >= waypoints.length) {
        mp.locked = false;
        if (onDone) onDone();
        return;
      }
      const wp = waypoints[i++];
      mp.robots[idx] = wp;
      setPercentPos(mp.robotEls[idx], wp.r, wp.c);
      setTimeout(step, 260);
    }
    step();
  }

  function updateMoveCount() {
    const el = document.getElementById("move-count");
    if (el) el.textContent = String(mp.historyIndex);
    refreshDeclareButtonState();
  }

  // 「回答する」ボタンは、目標に到達していない間はグレーアウトしておく
  // （すでに自分が宣言・提出済みの間もロックされたままにする）。
  function refreshDeclareButtonState() {
    const btn = document.getElementById("btn-online-declare");
    if (!btn) return;
    btn.disabled = !isGoalSatisfiedLocally();
  }

  function undo() {
    if (mp.locked || mp.historyIndex <= 0) return;
    const entry = mp.moveHistory[mp.historyIndex - 1];
    mp.historyIndex--;
    const reversed = entry.bends.slice().reverse().concat([entry.from]);
    clearArrows();
    animateAlongPath(entry.robot, reversed, () => {
      updateMoveCount();
      if (mp.selectedRobot === entry.robot) showArrowsForRobot(entry.robot);
    });
  }

  function redo() {
    if (mp.locked || mp.historyIndex >= mp.moveHistory.length) return;
    const entry = mp.moveHistory[mp.historyIndex];
    mp.historyIndex++;
    clearArrows();
    animateAlongPath(entry.robot, [...entry.bends, entry.to], () => {
      updateMoveCount();
      if (mp.selectedRobot === entry.robot) showArrowsForRobot(entry.robot);
    });
  }

  function resetToRoundStart() {
    if (mp.locked) return;
    if (mp.selectedRobot !== null) {
      mp.robotEls[mp.selectedRobot].classList.remove("selected");
      mp.selectedRobot = null;
    }
    clearArrows();
    mp.robots = mp.roundStartSnapshot.map((p) => ({ ...p }));
    mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));
    mp.moveHistory = [];
    mp.historyIndex = 0;
    updateMoveCount();
  }

  // ================= ラウンド進行 =================

  function setStatus(text) {
    const line = document.getElementById("status-line");
    if (line) line.textContent = text || "";
  }

  function renderHud() {
    const playersBox = document.getElementById("online-hud-players");
    if (playersBox) {
      playersBox.innerHTML = "";
      mp.players.forEach((p) => {
        // ロボットは特定のプレイヤーの持ち物ではない（誰でもどの色も動かせる）
        // ため、ここでは色分けせず名前と得点だけを表示する。
        const chip = document.createElement("span");
        chip.className = "online-hud-chip";
        chip.classList.toggle("is-host", p.peerId === (room_hostPeerId()));
        chip.classList.toggle("is-disconnected", !isPlayerConnected(p));
        const avatarBox = document.createElement("div");
        avatarBox.className = "online-hud-chip-avatar";
        if (typeof window.renderProfileAvatar === "function") {
          window.renderProfileAvatar(avatarBox, p.profile);
        }
        chip.appendChild(avatarBox);
        const infoBox = document.createElement("span");
        infoBox.className = "online-hud-chip-info";
        const nameSpan = document.createElement("span");
        nameSpan.className = "online-hud-chip-name";
        const disconnectedLabel = isPlayerConnected(p) ? "" : "［切断中］";
        const hostLabel = p.peerId === room_hostPeerId() ? "［ホスト］" : "";
        nameSpan.textContent = `${p.name || "プレイヤー"}${hostLabel}${disconnectedLabel}: ${mp.scores[p.peerId] || 0}点`;
        infoBox.appendChild(nameSpan);
        if (mp.giveUpVoters.has(p.peerId)) {
          const giveUpTag = document.createElement("span");
          giveUpTag.className = "online-hud-chip-giveup";
          giveUpTag.textContent = "🏳️ ギブアップ済み";
          infoBox.appendChild(giveUpTag);
        }
        chip.appendChild(infoBox);
        playersBox.appendChild(chip);
      });
    }
  }

  function room_hostPeerId() {
    return typeof window.HROnline === "object" && window.HROnline._getRoom()
      ? window.HROnline._getRoom().hostPeerId
      : null;
  }

  function renderRaceStatus() {
    const raceBox = document.getElementById("online-hud-race");
    if (!raceBox) return;
    if (mp.countdownKind === "giveup" && !mp.bestDeclare) {
      raceBox.textContent = `🏳️ 誰かがギブアップしました。残り${mp.countdownRemaining}秒（誰かが回答すれば中断されます）`;
      return;
    }
    if (!mp.bestDeclare) {
      raceBox.textContent = "";
      return;
    }
    const p = mp.players.find((x) => x.peerId === mp.bestDeclare.peerId);
    let text = `現在のチャンピオン: ${p ? p.name : "?"} が ${mp.bestDeclare.moveCount}手（残り${mp.countdownRemaining}秒）`;
    const others = mp.players.filter((pl) => pl.peerId !== mp.bestDeclare.peerId);
    const concedeCount = others.filter((pl) => mp.giveUpVoters.has(pl.peerId)).length;
    if (others.length > 0 && concedeCount > 0) {
      text += ` ／ 降参: ${concedeCount}/${others.length}人`;
    }
    raceBox.textContent = text;
  }

  function nextGoal() {
    if (!mp.isHost || mp.matchOver) return;
    if (mp.suddenDeathActive) {
      // サドンデス中はマップは変えず、これまでのお題と違うものを
      // ランダムに選び続ける。
      const candidates = mp.board.targets.filter(
        (t) => !(mp.currentGoal && t.r === mp.currentGoal.r && t.c === mp.currentGoal.c && t.color === mp.currentGoal.color && t.shape === mp.currentGoal.shape)
      );
      const pool = candidates.length > 0 ? candidates : mp.board.targets;
      const goal = pool[Math.floor(Math.random() * pool.length)];
      mp.goalIndex++;
      mp.net.broadcast({ type: "goal-reveal", goal, robots: mp.robots, goalIndex: mp.goalIndex });
      applyGoalReveal(goal, mp.robots, mp.goalIndex);
      return;
    }
    mp.goalIndex++;
    if (mp.goalIndex >= mp.targetQueue.length) {
      endMatch();
      return;
    }
    const goal = mp.targetQueue[mp.goalIndex];
    mp.net.broadcast({ type: "goal-reveal", goal, robots: mp.robots, goalIndex: mp.goalIndex });
    applyGoalReveal(goal, mp.robots, mp.goalIndex);
  }

  // すべてのゴールが出そろったら対戦終了とする
  function endMatch() {
    if (!mp.isHost) return;
    mp.matchOver = true;
    const { winners, allTied } = determineWinnerInfo();
    if (mp.settings.suddenDeath && winners.length > 1) {
      startSuddenDeath();
      return;
    }
    const winnerIds = winners.map((w) => w.peerId);
    const msg = { type: "match-over", scores: mp.scores, winnerIds, allTied };
    mp.net.broadcast(msg);
    applyMatchOver(msg);
  }

  // サドンデスの開始（1位が複数いた場合）。マップ・盤面はそのまま、
  // 「サドンデス」の大きな告知の後、サドンデス用の準備確認画面へ進む。
  function startSuddenDeath() {
    mp.suddenDeathActive = true;
    mp.matchOver = false;
    mp.net.broadcast({ type: "sudden-death-start" });
    applySuddenDeathStart();
  }

  function applySuddenDeathStart() {
    mp.suddenDeathActive = true;
    mp.matchOver = false;
    const banner = document.getElementById("match-over-banner");
    flashText(banner, "サドンデス");
    setTimeout(() => awaitNextRoundReady(), 2300);
  }

  // 現時点の得点から、1位のプレイヤー（複数なら同点）と、
  // 全員が同点かどうかを求める。
  function determineWinnerInfo() {
    const topScore = Math.max(...mp.players.map((pl) => mp.scores[pl.peerId] || 0));
    const winners = mp.players.filter((pl) => (mp.scores[pl.peerId] || 0) === topScore);
    const allTied = winners.length === mp.players.length && mp.players.length > 1;
    return { winners, allTied };
  }

  function winnerBannerText(winners, allTied) {
    if (allTied) return "引き分け";
    if (winners.length === 1) return `${winners[0].name || "プレイヤー"}さんの勝利！`;
    return winners.map((w) => `${w.name || "プレイヤー"}さん`).join("、") + "の勝利！";
  }

  function applyMatchOver(msg) {
    mp.matchOver = true;
    mp.scores = msg.scores;
    finalizeMatchOverUI();
    const winners = mp.players.filter((p) => (msg.winnerIds || []).includes(p.peerId));
    renderHud();
    showMatchOverSequence(winners, !!msg.allTied);
  }

  // デカデカと勝者を告知したあと、リザルト画面を表示する一連の流れ。
  function showMatchOverSequence(winners, allTied) {
    const banner = document.getElementById("match-over-banner");
    flashText(banner, winnerBannerText(winners, allTied));
    setTimeout(() => showResultScreen(), 2300);
  }

  function showResultScreen() {
    const overlay = document.getElementById("result-screen-overlay");
    const list = document.getElementById("result-screen-list");
    if (!overlay || !list) return;
    list.innerHTML = "";
    const sorted = mp.players.slice().sort((a, b) => (mp.scores[b.peerId] || 0) - (mp.scores[a.peerId] || 0));
    let rank = 0;
    let prevScore = null;
    sorted.forEach((p, idx) => {
      const score = mp.scores[p.peerId] || 0;
      if (score !== prevScore) { rank = idx + 1; prevScore = score; }
      const row = document.createElement("div");
      row.className = "result-screen-row";
      const rankEl = document.createElement("span");
      rankEl.className = "result-screen-rank";
      rankEl.textContent = `${rank}位`;
      const avatar = document.createElement("div");
      avatar.className = "result-screen-avatar";
      if (typeof window.renderProfileAvatar === "function") window.renderProfileAvatar(avatar, p.profile);
      const name = document.createElement("span");
      name.className = "result-screen-name";
      name.textContent = p.name || "プレイヤー";
      const scoreEl = document.createElement("span");
      scoreEl.className = "result-screen-score";
      scoreEl.textContent = `${score}点`;
      row.appendChild(rankEl);
      row.appendChild(avatar);
      row.appendChild(name);
      row.appendChild(scoreEl);
      list.appendChild(row);
    });
    mp.rematchVoters = new Set();
    renderRematchStatus();
    const rematchBtn = document.getElementById("btn-result-rematch");
    if (rematchBtn) rematchBtn.disabled = false;
    overlay.classList.remove("hidden");
  }

  // ================= リザルト画面：もう一度遊ぶ／タイトルへ戻る =================

  function clickRematch() {
    if (mp.rematchVoters.has(mp.myPeerId)) return;
    mp.rematchVoters.add(mp.myPeerId);
    const btn = document.getElementById("btn-result-rematch");
    if (btn) btn.disabled = true;
    renderRematchStatus();
    const msg = { type: "rematch-vote", peerId: mp.myPeerId };
    if (mp.isHost) applyRematchVote(msg);
    else mp.net.broadcast(msg);
  }

  function applyRematchVote(msg) {
    if (!mp.isHost) return;
    mp.rematchVoters.add(msg.peerId);
    const tally = { type: "rematch-tally", voterIds: Array.from(mp.rematchVoters) };
    mp.net.broadcast(tally);
    applyRematchTally(tally);
    const allIds = mp.players.map((p) => p.peerId);
    if (allIds.length > 0 && allIds.every((id) => mp.rematchVoters.has(id))) {
      mp.net.broadcast({ type: "rematch-start" });
      applyRematchStart();
    }
  }

  function applyRematchTally(msg) {
    mp.rematchVoters = new Set(msg.voterIds);
    renderRematchStatus();
  }

  function renderRematchStatus() {
    const el = document.getElementById("result-screen-rematch-status");
    if (!el) return;
    const names = Array.from(mp.rematchVoters).map((id) => {
      const p = mp.players.find((x) => x.peerId === id);
      return p ? p.name || "プレイヤー" : "?";
    });
    el.textContent = names.length > 0 ? `準備OK: ${names.join("、")}` : "";
  }

  // 同じルームID・同じホスト・同じメンバーのまま、ルーム設定画面へ戻る。
  function applyRematchStart() {
    const overlay = document.getElementById("result-screen-overlay");
    if (overlay) overlay.classList.add("hidden");
    window.__HR_ONLINE_ACTIVE = false;
    if (typeof window.HROnline === "object" && typeof window.HROnline.returnToRoomAfterMatch === "function") {
      window.HROnline.returnToRoomAfterMatch();
    }
  }

  function clickBackToTitleFromResult() {
    mp.net.broadcast({ type: "match-back-to-title" });
    applyBackToTitleBroadcast();
  }

  function applyBackToTitleBroadcast() {
    const banner = document.getElementById("return-title-banner");
    flashText(banner, "いずれかのプレイヤーによってタイトルへ戻るボタンが押されました。タイトルへ戻ります。");
    setTimeout(() => {
      const btn = document.getElementById("btn-back-title");
      if (btn) btn.click();
    }, 2000);
  }

  // 対戦終了時の画面まわりの後始末（早期決着・全ゴール消化の両方から呼ばれる）
  function finalizeMatchOverUI() {
    stopCountdown();
    mp.countdownKind = null;
    setControlsLocked(true);
    const giveUpBtn = document.getElementById("btn-online-giveup");
    if (giveUpBtn) giveUpBtn.disabled = true;
    hideNextReadyOverlay();
    updateGoalsRemaining();
  }

  function updateGoalsRemaining() {
    const el = document.getElementById("goals-remaining");
    if (!el) return;
    el.textContent = mp.matchOver ? "0" : String(Math.max(0, mp.totalRounds - mp.goalIndex));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function showGoalRevealBanner(goal, desc) {
    const banner = document.getElementById("goal-reveal-banner");
    const iconBox = document.getElementById("goal-reveal-banner-icon");
    const textEl = document.getElementById("goal-reveal-banner-text");
    if (!banner || !iconBox || !textEl) return;
    iconBox.innerHTML = "";
    const icon = document.createElement("div");
    icon.className = `target-icon shape-${goal.shape} tint-${goal.color} active`;
    iconBox.appendChild(icon);
    textEl.textContent = desc;
    banner.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void banner.offsetWidth; // 連続でゴールが変わってもアニメーションを最初からやり直させる
    banner.classList.add("show");
  }

  function applyGoalReveal(goal, robots, goalIndex) {
    mp.isHost = window.HRNet.isHost(); // ホスト引き継ぎが起きていた場合に備えて毎ラウンド再確認する
    updateNewMapButtonForOnline();
    if (goalIndex != null) mp.goalIndex = goalIndex; // ゲスト側の残りゴール数がホストと食い違わないように同期する
    mp.currentGoal = goal;
    mp.roundStartSnapshot = robots.map((p) => ({ ...p }));
    mp.robots = robots.map((p) => ({ ...p }));
    mp.bestDeclare = null;
    mp.declared = false;
    mp.myDeclaredMoves = null;
    mp.myGiveUpVoted = false;
    mp.giveUpVoters = new Set();
    mp.countdownKind = null;
    setControlsLocked(false);
    const giveUpBtn = document.getElementById("btn-online-giveup");
    if (giveUpBtn) giveUpBtn.disabled = false;
    hideNextReadyOverlay();
    stopCountdown();
    if (mp.selectedRobot !== null) {
      mp.robotEls[mp.selectedRobot].classList.remove("selected");
      mp.selectedRobot = null;
    }
    clearArrows();
    mp.moveHistory = [];
    mp.historyIndex = 0;
    updateMoveCount();
    mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));
    placeGoalIndicator();
    refreshTargetEmphasis();
    updateGoalsRemaining();
    const shapeLabel = SHAPE_INFO[goal.shape].label;
    const desc =
      goal.color === "rainbow"
        ? `いずれかのロボットを${shapeLabel}のマスへ`
        : `${COLOR_INFO[goal.color].label}ロボットを${shapeLabel}のマスへ`;
    const goalDescEl = document.getElementById("goal-desc");
    if (goalDescEl) goalDescEl.textContent = desc;
    const goalIconEl = document.getElementById("goal-icon");
    if (goalIconEl) {
      goalIconEl.innerHTML = "";
      const icon = document.createElement("div");
      icon.className = `target-icon shape-${goal.shape} tint-${goal.color} active`;
      goalIconEl.appendChild(icon);
    }
    showGoalRevealBanner(goal, desc);
    setStatus("新しい目標が現れました。ロボットを動かしてゴールしたら「回答する」で宣言しましょう。");
    renderHud();
    renderRaceStatus();
    refreshGiveUpButtonState();
  }

  function isGoalSatisfiedLocally() {
    if (!mp.currentGoal) return false;
    const g = mp.currentGoal;
    if (g.color === "rainbow") {
      return mp.robots.some((p) => p.r === g.r && p.c === g.c);
    }
    const idx = colorIndexOfColor(g.color);
    return idx >= 0 && mp.robots[idx] && mp.robots[idx].r === g.r && mp.robots[idx].c === g.c;
  }

  const GIVEUP_TIMEOUT_SEC = 60;
  const SOLVER_TIME_BUDGET_MS = 10000; // コンピュータの探索に許す時間（オンライン対戦・ギブアップ後の答え合わせ用）

  function declare() {
    if (!mp.currentGoal || mp.matchOver) return;
    if (!isGoalSatisfiedLocally()) {
      setStatus("まだ目標のマスに到達していません。ロボットを動かしてからもう一度「回答する」を押してください。");
      return;
    }
    // 宣言した時点の手順を記録する（一時的なチャンピオン候補として）。
    // この後さらにロボットを動かしても、この記録自体は変わらない。
    // 押した後も操作はロックしない — このプレイヤー自身も、もっと短い
    // 手順が見つかれば何度でも「回答する」を押し直してチャンピオンを
    // 更新できる。
    mp.myDeclaredMoves = mp.moveHistory.slice(0, mp.historyIndex).map((m) => ({ robot: m.robot, dir: m.dir }));
    const msg = { type: "declare-update", peerId: mp.myPeerId, moveCount: mp.historyIndex };
    if (mp.isHost) {
      applyDeclare(msg);
    } else {
      mp.net.broadcast(msg); // ホストが受け取って採否を判断する
    }
  }

  function setControlsLocked(locked) {
    ["btn-online-undo", "btn-online-redo", "btn-online-reset", "btn-online-declare"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = locked;
    });
  }

  // ホストのみ: 宣言を受け取って採用するかどうかを判定する。
  // 「通常のカウントダウンタイムは、一度作動したら更新されることはない」
  // という仕様のため、カウントダウンを開始するのは最初の宣言（または
  // ギブアップ待ちを割り込んで中断させた時）だけで、その後により良い
  // 宣言が来てもタイマー自体はリセットしない（表示だけ更新する）。
  function applyDeclare(msg) {
    if (!mp.isHost) return;
    const isNewBest = !mp.bestDeclare || msg.moveCount < mp.bestDeclare.moveCount;
    if (!isNewBest) return;
    const isFirst = !mp.bestDeclare;
    mp.bestDeclare = { peerId: msg.peerId, moveCount: msg.moveCount };
    refreshGiveUpButtonState();
    showRaceFlashBanner(isFirst, msg.peerId, msg.moveCount);

    if (mp.countdownKind !== "declare") {
      // ギブアップ待ちだった場合はここで打ち切り、通常カウントダウンに切り替える
      const wasGiveUp = mp.countdownKind === "giveup";
      mp.countdownKind = "declare";
      startCountdown(mp.settings.answerTimeLimit, requestVerification);
      const payload = {
        type: "declare-update",
        peerId: msg.peerId,
        moveCount: msg.moveCount,
        endTime: mp.countdownEndTime,
        isFirst,
      };
      mp.net.broadcast(payload);
      if (wasGiveUp) {
        mp.net.broadcast({ type: "giveup-cancelled" });
        applyGiveUpCancelled();
      }
      // チャンピオンがいなかった時点で、既に他の全員がギブアップ済み
      // だった場合（＝このチャンピオンが最後の一人として答えただけ）は、
      // 新たにカウントダウンを待つ必要はなく、今すぐ決着とする。
      maybeResolveIfAllOthersAlreadyConceded();
    } else {
      renderRaceStatus();
      mp.net.broadcast({ type: "declare-update", peerId: msg.peerId, moveCount: msg.moveCount, isFirst });
    }
  }

  // 初回回答・記録更新を、画面全体にデカデカと一瞬表示する。
  // 表示中は、勝敗判定までの大きな残り時間表示を一時的に透明にする
  // （文字が重なって読みにくくなるのを避けるため）。
  function showRaceFlashBanner(isFirst, peerId, moveCount) {
    const banner = document.getElementById("race-flash-banner");
    const countdownEl = document.getElementById("big-countdown-display");
    if (!banner) return;
    const isSelf = peerId === mp.myPeerId;
    const p = mp.players.find((x) => x.peerId === peerId);
    const name = p ? p.name || "プレイヤー" : "プレイヤー";
    let text;
    if (isFirst) {
      const nameForFirst = isSelf ? "" : `${name}さんが`;
      text = `${nameForFirst}${moveCount}手でゴール！<br>勝敗判定まで${mp.settings.answerTimeLimit}秒`;
    } else {
      const nameForUpdate = isSelf ? "" : `${name}さんが`;
      text = `${nameForUpdate}${moveCount}手で記録更新！`;
    }
    flashText(banner, text);
  }

  // ギブアップを押した瞬間の、デカデカとした一瞬の告知。
  function showGiveUpFlashBanner(peerId) {
    const banner = document.getElementById("race-flash-banner");
    if (!banner) return;
    const p = mp.players.find((x) => x.peerId === peerId);
    const name = p ? p.name || "プレイヤー" : "プレイヤー";
    flashText(banner, `${name}さんがギブアップしました。`);
  }

  // race-flash-banner を指定テキストで一瞬表示する共通処理。表示中は
  // 勝敗判定までの大きな残り時間表示を一時的に透明にする。
  function flashText(banner, html) {
    const countdownEl = document.getElementById("big-countdown-display");
    const textEl = banner.querySelector(".race-flash-banner-text") || (() => {
      const el = document.createElement("div");
      el.className = "race-flash-banner-text";
      banner.appendChild(el);
      return el;
    })();
    textEl.innerHTML = html;
    banner.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void banner.offsetWidth;
    banner.classList.add("show");
    if (countdownEl) {
      countdownEl.classList.add("flash-hidden");
      setTimeout(() => countdownEl.classList.remove("flash-hidden"), 2200);
    }
    // 「初回回答／記録更新」「ギブアップしました」の表示（#race-flash-banner）
    // が終わるまでは、次に呼ばれる可能性のある「〇〇さんが1ポイント
    // ゲット」バナーを表示待ちにしておく。ゴールと同時に決着がつく場合
    // （チャンピオン以外が全員ギブアップした場合など）、両方のバナーが
    // 重なって表示されてしまうのを防ぐため。
    if (banner.id === "race-flash-banner") {
      raceFlashBannerBusyUntil = Date.now() + 2200;
    }
  }

  // seconds: カウントダウンの長さ。onExpire: ホストの権威あるタイマーが
  // 0になった時にだけ呼ばれるコールバック（ゲスト表示専用の場合は省略）。
  function renderCountdownDisplays() {
    if (mp.countdownKind === "nextready") {
      renderNextReadyCountdown();
    } else {
      renderRaceStatus();
    }
    renderBigCountdown();
  }

  // 勝敗判定（回答の宣言・ギブアップ）までの残り時間を、画面中央上側に
  // デカデカと半透明の赤文字で表示する（設定でオフにできる）。
  function renderBigCountdown() {
    const el = document.getElementById("big-countdown-display");
    if (!el) return;
    const shouldShow =
      mp.settings.showBigCountdown &&
      (mp.countdownKind === "declare" || mp.countdownKind === "giveup") &&
      mp.countdownRemaining > 0;
    if (!shouldShow) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.textContent = String(mp.countdownRemaining);
  }

  // 「あと何秒か」は毎回 countdownEndTime（絶対時刻）とのdiffから
  // 計算し直す。setIntervalの1回ごとの減算に頼ると、タブが非アクティブ
  // になった時のブラウザのタイマー間引き（スロットリング）などで
  // ホストと他プレイヤーの表示が少しずつズレていってしまうため。
  function tickCountdown() {
    mp.countdownRemaining = Math.max(0, Math.ceil((mp.countdownEndTime - Date.now()) / 1000));
    renderCountdownDisplays();
  }

  function startCountdown(seconds, onExpire) {
    stopCountdown();
    mp.countdownEndTime = Date.now() + seconds * 1000;
    tickCountdown();
    mp.countdownInterval = setInterval(() => {
      tickCountdown();
      if (Date.now() >= mp.countdownEndTime) {
        stopCountdown();
        if (mp.isHost && onExpire) onExpire();
      }
    }, 300);
  }

  // ゲスト側の表示専用カウントダウン。実際の判定・検証要求はホストの
  // カウントダウンだけが行うので、ここでは見た目の秒数を進めるだけ。
  // endTime はホストから届いた「絶対時刻」で、ホスト側と同じ基準時刻
  // から逆算するので、タイマーの間引きなどがあってもズレが蓄積しない。
  function startDisplayCountdown(endTime) {
    stopCountdown();
    mp.countdownEndTime = endTime;
    tickCountdown();
    mp.countdownInterval = setInterval(() => {
      tickCountdown();
      if (Date.now() >= mp.countdownEndTime) {
        stopCountdown();
      }
    }, 300);
  }

  function stopCountdown() {
    if (mp.countdownInterval) {
      clearInterval(mp.countdownInterval);
      mp.countdownInterval = null;
    }
  }

  function requestVerification() {
    if (!mp.isHost || !mp.bestDeclare) return;
    mp.net.broadcast({ type: "verify-request", peerId: mp.bestDeclare.peerId });
    if (mp.bestDeclare.peerId === mp.myPeerId) {
      submitVerification();
    }
  }

  function submitVerification() {
    const msg = {
      type: "verify-submit",
      peerId: mp.myPeerId,
      moves: mp.myDeclaredMoves || [],
    };
    if (mp.isHost) {
      // broadcastは送信者自身には届かない仕組みなので、提出者がホスト
      // 自身（＝ホストがチャンピオン）の場合はここで直接処理する。
      // でないと検証がいつまでも走らず、対局が進行不能になってしまう。
      verifySubmission(msg);
    } else {
      mp.net.broadcast(msg);
    }
  }

  // ホスト側: 提出された手順を、ラウンド開始時点の盤面で再生して検証する
  function verifySubmission(msg) {
    if (!mp.isHost || !mp.currentGoal) return;
    const simRobots = mp.roundStartSnapshot.map((p) => ({ ...p }));
    let valid = true;
    // msg.moves は {robot, dir} のみ（宣言・検証にはそれで十分）だが、
    // 後で「最短手のリプレイ」として再生する際には、斜め壁で曲がった
    // 場合の経由点（bends）を含む実際の到達先情報が必要になる。
    // ここでslide()を呼んだ時点でその情報が手に入るので、あわせて
    // 記録しておく。
    const replayMoves = [];
    msg.moves.forEach((step) => {
      if (!valid) return;
      const color = robotColor(step.robot);
      const dest = window.slide(mp.board, simRobots, step.robot, step.dir, color);
      if (dest.r === simRobots[step.robot].r && dest.c === simRobots[step.robot].c) {
        valid = false; // 実際には動けない手が含まれていた
        return;
      }
      simRobots[step.robot] = dest;
      replayMoves.push({ robot: step.robot, dir: step.dir, to: { r: dest.r, c: dest.c }, bends: dest.bends || [] });
    });
    const g = mp.currentGoal;
    let reachedGoal = false;
    if (valid) {
      if (g.color === "rainbow") {
        reachedGoal = simRobots.some((p) => p.r === g.r && p.c === g.c);
      } else {
        const idx = colorIndexOfColor(g.color);
        reachedGoal = idx >= 0 && simRobots[idx] && simRobots[idx].r === g.r && simRobots[idx].c === g.c;
      }
    }
    const countMatches = msg.moves.length === mp.bestDeclare.moveCount;
    mp.countdownKind = null;

    if (valid && reachedGoal && countMatches) {
      mp.scores[msg.peerId] = (mp.scores[msg.peerId] || 0) + 1;
      mp.roundsPlayed++;
      // チャンピオン（宣言が承認されたプレイヤー）の検証済みの最終位置を
      // ホスト自身のロボット状態にも反映しておく。これをしないと、
      // ホスト自身がラウンド中に別の手を試していた場合、次のお題が
      // 「チャンピオンがゴールした位置」ではなく「たまたまホストの
      // 画面に残っていた位置」から始まってしまう。
      mp.robots = simRobots;
      // 次の準備確認画面で「最短手のリプレイ」として再生できるよう、
      // チャンピオンの手順とゴール直前の開始位置を記録しておく。
      mp.lastChampionRoute = {
        moves: replayMoves,
        startSnapshot: mp.roundStartSnapshot.map((p) => ({ ...p })),
      };
      let decided = !mp.settings.playUntilEnd && isOutcomeDecided();
      let winnerIds = null;
      let allTied = false;
      let suddenDeathContinues = false;
      if (mp.suddenDeathActive) {
        // サドンデス中は「逆転不可能かどうか」ではなく、この時点で
        // 1位が一人に決まったかどうかで終了判定を行う。
        const info = determineWinnerInfo();
        if (info.winners.length === 1) {
          decided = true;
          mp.suddenDeathActive = false;
          winnerIds = info.winners.map((w) => w.peerId);
          allTied = info.allTied;
        } else {
          decided = false;
          suddenDeathContinues = true;
        }
      } else if (decided) {
        const info = determineWinnerInfo();
        winnerIds = info.winners.map((w) => w.peerId);
        allTied = info.allTied;
      }
      const payload = {
        type: "round-result",
        winnerId: msg.peerId,
        moveCount: msg.moves.length,
        scores: mp.scores,
        roundsPlayed: mp.roundsPlayed,
        matchOver: decided,
        championRoute: mp.lastChampionRoute,
        winnerIds,
        allTied,
        suddenDeathContinues,
      };
      mp.net.broadcast(payload);
      applyRoundResult(payload);
      if (decided) {
        mp.matchOver = true;
      }
    } else {
      mp.net.broadcast({ type: "round-invalid", peerId: msg.peerId });
      mp.bestDeclare = null;
      applyRoundInvalid({ peerId: msg.peerId });
    }
  }

  // 「最後まで続ける」がオフのとき、残りのお題数を考えても順位が
  // 逆転できない状況になったかどうかを判定する。
  function isOutcomeDecided() {
    const sorted = mp.players
      .map((p) => mp.scores[p.peerId] || 0)
      .sort((a, b) => b - a);
    if (sorted.length < 2) return false;
    const leadOverSecond = sorted[0] - sorted[1];
    const remaining = Math.max(0, mp.totalRounds - mp.roundsPlayed);
    return leadOverSecond > remaining;
  }

  function colorIndexOfColor(color) {
    return mp.colors.indexOf(color);
  }

  function showRoundResultBanner(text, callback) {
    // ゴールと同時に決着がついた場合（初回回答／記録更新／ギブアップの
    // デカデカ表示と重なるタイミング）は、そちらの表示が終わってから
    // このバナーを出す。
    const now = Date.now();
    if (now < raceFlashBannerBusyUntil) {
      setTimeout(() => showRoundResultBanner(text, callback), raceFlashBannerBusyUntil - now);
      return;
    }
    const banner = document.getElementById("round-result-banner");
    const textEl = banner ? banner.querySelector(".round-result-banner-text") : null;
    if (!banner || !textEl) {
      callback();
      return;
    }
    textEl.textContent = text;
    banner.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void banner.offsetWidth; // 連続クリアでもアニメーションを最初からやり直させる
    banner.classList.add("show");
    setTimeout(() => {
      banner.classList.remove("show");
      callback();
    }, 2200);
  }

  function applyRoundResult(msg) {
    mp.scores = msg.scores;
    if (msg.roundsPlayed != null) mp.roundsPlayed = msg.roundsPlayed;
    if (msg.championRoute) mp.lastChampionRoute = msg.championRoute; // ゲスト側にもリプレイ用に伝わるようにする
    const p = mp.players.find((x) => x.peerId === msg.winnerId);
    if (msg.matchOver) {
      mp.matchOver = true;
      mp.suddenDeathActive = false;
      finalizeMatchOverUI();
      setStatus(`🎉 ${p ? p.name : "?"} が ${msg.moveCount}手でクリア！`);
      renderHud();
      const winners = mp.players.filter((pl) => (msg.winnerIds || []).includes(pl.peerId));
      showRoundResultBanner(`${p ? p.name : "?"}さんが1ポイント獲得！`, () => showMatchOverSequence(winners, !!msg.allTied));
    } else {
      setStatus(`🎉 ${p ? p.name : "?"} が ${msg.moveCount}手でクリア！`);
      renderHud();
      showRoundResultBanner(`${p ? p.name : "?"}さんが1ポイント獲得！`, awaitNextRoundReady);
    }
  }

  function applyRoundInvalid(msg) {
    const p = mp.players.find((x) => x.peerId === msg.peerId);
    setStatus(`⚠️ ${p ? p.name : "?"} の宣言は手順を確認できませんでした。他の人はまだ宣言できます。`);
    mp.bestDeclare = null; // ゲスト側でも「チャンピオン不在」に戻す（ホスト側は既にverifySubmission()内で行っている）
    if (msg.peerId === mp.myPeerId) {
      mp.myDeclaredMoves = null;
      refreshDeclareButtonState();
    }
    renderRaceStatus();
    refreshGiveUpButtonState();
  }

  // ================= ギブアップ（答えを見る） =================
  // 誰か一人が押すだけで60秒のカウントダウンが始まる。その間に誰かが
  // 「回答する」を押せば通常の回答レースに切り替わり、誰も回答しな
  // ければ60秒後にコンピュータが答えを見せる。

  // 現時点のチャンピオン（宣言中の最有力者）は「自分に降参する」ことが
  // できないので、ギブアップボタンを非活性にしておく。チャンピオンが
  // 変わった（＝別の人に更新された、または宣言が無効化されて誰も
  // いなくなった）タイミングで、このボタンの状態を必ず更新し直す。
  function refreshGiveUpButtonState() {
    const btn = document.getElementById("btn-online-giveup");
    if (!btn) return;
    if (mp.matchOver) return; // 対戦終了時は finalizeMatchOverUI() 側で常に非活性にする
    const iAmChampion = mp.bestDeclare && mp.bestDeclare.peerId === mp.myPeerId;
    btn.disabled = !!iAmChampion || mp.myGiveUpVoted;
  }

  function giveUp() {
    if (!mp.currentGoal || mp.myGiveUpVoted || mp.matchOver) return;
    // チャンピオン自身は「自分に降参する」ことはできない
    if (mp.bestDeclare && mp.bestDeclare.peerId === mp.myPeerId) return;
    mp.myGiveUpVoted = true;
    const btn = document.getElementById("btn-online-giveup");
    if (btn) btn.disabled = true;
    renderHud(); // 自分の名前の下に「ギブアップ済み」マークを出す
    const msg = { type: "giveup-vote", peerId: mp.myPeerId };
    if (mp.isHost) {
      applyGiveUpVote(msg);
    } else {
      mp.net.broadcast(msg);
    }
  }

  function activePeerIds() {
    const list = window.HRNet.getPeerList().filter((p) => p.connected).map((p) => p.peerId);
    list.push(mp.myPeerId);
    return list;
  }

  // ギブアップボタンは文脈によって意味が変わる:
  //   ・まだ誰もチャンピオンになっていない -> 「誰も分からない、コンピュータに見せてほしい」(60秒タイマー)
  //   ・すでにチャンピオンがいる -> 「このチャンピオンに降参する」(チャンピオン以外全員が降参したら即決着)
  // 現在のチャンピオン以外の「アクティブな全員」が既にギブアップ済み
  // なら、カウントダウンを待たずに今すぐ決着とする。
  // ・ギブアップの投票が増えた時（applyGiveUpVote）
  // ・チャンピオンがいなかった状態から新たにチャンピオンが生まれた時
  //   （applyDeclare。既に他の全員がギブアップ済みだったケース）
  // の両方から呼ばれる。
  function maybeResolveIfAllOthersAlreadyConceded() {
    if (!mp.bestDeclare) return false;
    const championId = mp.bestDeclare.peerId;
    const others = activePeerIds().filter((id) => id !== championId);
    const total = others.length;
    const count = others.filter((id) => mp.giveUpVoters.has(id)).length;
    if (total > 0 && count >= total) {
      stopCountdown();
      requestVerification();
      return true;
    }
    return false;
  }

  function applyGiveUpVote(msg) {
    if (!mp.isHost) return;
    mp.giveUpVoters.add(msg.peerId);
    renderHud(); // ホスト自身の画面にもすぐ反映する
    const flash = { type: "giveup-flash", peerId: msg.peerId };
    mp.net.broadcast(flash);
    showGiveUpFlashBanner(msg.peerId);

    if (mp.bestDeclare) {
      const tally = { type: "giveup-concede-tally", giveUpPeerIds: Array.from(mp.giveUpVoters) };
      mp.net.broadcast(tally);
      applyGiveUpConcedeTally(tally);
      maybeResolveIfAllOthersAlreadyConceded();
    } else if (mp.countdownKind === null) {
      applyGiveUpStart(msg);
    } else if (mp.countdownKind === "giveup") {
      // 既にギブアップ待ち中に、別の人がさらにギブアップを押した場合。
      // 全員分がそろったら、60秒を待たずに今すぐ答えを見せる。
      const active = activePeerIds();
      const total = active.length;
      const count = active.filter((id) => mp.giveUpVoters.has(id)).length;
      const tally = { type: "giveup-concede-tally", giveUpPeerIds: Array.from(mp.giveUpVoters) };
      mp.net.broadcast(tally);
      applyGiveUpConcedeTally(tally);
      if (total > 0 && count >= total) {
        stopCountdown();
        revealGiveUpAnswer();
      }
    }
  }

  function applyGiveUpConcedeTally(msg) {
    mp.giveUpVoters = new Set(msg.giveUpPeerIds || []);
    renderRaceStatus();
    renderHud();
  }

  function applyGiveUpStart(msg) {
    if (!mp.isHost || mp.countdownKind !== null) return;
    mp.countdownKind = "giveup";
    startCountdown(GIVEUP_TIMEOUT_SEC, revealGiveUpAnswer);
    const payload = { type: "giveup-countdown-start", endTime: mp.countdownEndTime, giveUpPeerIds: Array.from(mp.giveUpVoters) };
    mp.net.broadcast(payload);
    applyGiveUpCountdownStart(payload);
  }

  function applyGiveUpCountdownStart(msg) {
    // 全員に大きなバナーを出したり操作をロックしたりはしない。
    // 「誰かがギブアップして待っている」ことは online-hud-race の
    // カウントダウン表示と、各プレイヤーのHUD表示で全員に伝わるようにする。
    mp.giveUpVoters = new Set(msg.giveUpPeerIds || []);
    renderHud();
    if (!mp.isHost) {
      startDisplayCountdown(msg.endTime);
    }
  }

  // 誰かが回答してギブアップ待ちが打ち切られた場合
  function applyGiveUpCancelled() {
    // ギブアップを押していた本人はロックを解除して再び操作できるようにする
    // （押していなかった人には影響しない）
    if (mp.myGiveUpVoted) setControlsLocked(false);
    renderRaceStatus();
  }

  function revealGiveUpAnswer() {
    if (!mp.isHost) return;
    // 万一何らかの経路で二重に呼ばれてしまうと、それぞれが独立した
    // IncrementalSolver を並行して動かすことになり、片方が（本来の
    // 10秒に満たないタイミングで）先に「見つからなかった」という
    // 結果をブロードキャストしてしまう恐れがある。念のため多重実行を
    // 防いでおく。
    if (mp.giveUpRevealInProgress) return;
    mp.giveUpRevealInProgress = true;
    mp.countdownKind = null;
    setStatus("🤖 コンピュータが思考中です。しばらくお待ちください…");
    const goalColorIdx = mp.currentGoal.color === "rainbow" ? "any" : colorIndexOfColor(mp.currentGoal.color);
    const solver = new IncrementalSolver(mp.board, mp.roundStartSnapshot, goalColorIdx, mp.currentGoal.r, mp.currentGoal.c, mp.colors);
    const deadline = Date.now() + SOLVER_TIME_BUDGET_MS;
    // ブロッキングのwhileループにすると、難しい盤面ではUIが最大10秒
    // 固まってしまう。setTimeoutで少しずつ刻みながら進める
    // （ソロモードの探索と同じ考え方）。
    function tick() {
      const res = solver.step(20);
      if (res.status === "found") {
        mp.giveUpRevealInProgress = false;
        const msg = { type: "giveup-reveal", path: res.path };
        mp.net.broadcast(msg);
        applyGiveUpReveal(msg);
        return;
      }
      if (res.status === "not_found" || Date.now() > deadline) {
        mp.giveUpRevealInProgress = false;
        const msg = { type: "giveup-reveal", path: [] };
        mp.net.broadcast(msg);
        applyGiveUpReveal(msg);
        return;
      }
      setTimeout(tick, 0);
    }
    tick();
  }

  function applyGiveUpReveal(msg) {
    mp.countdownKind = null;
    stopCountdown();
    setControlsLocked(true);
    const path = msg.path || [];
    if (path.length === 0) {
      // コンピュータでも見つけられなかった場合は、このラウンドが始まった
      // 時点の位置までロボットを戻しておく（誰かの試行錯誤の跡を
      // 残したまま次のお題に進んでしまわないようにする）。
      mp.robots = mp.roundStartSnapshot.map((p) => ({ ...p }));
      mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));
      // コンピュータも見つけられなかった手順は記録しない
      // （＝リプレイボタンを出さない）。
      mp.lastChampionRoute = null;
      setStatus("😢 コンピュータもゴールできませんでした！");
      showRoundResultBanner("コンピュータもゴールできませんでした！引き分け！", awaitNextRoundReady);
      return;
    }
    // コンピュータが見つけた手順も、後で「最短手のリプレイ」として
    // 見られるように記録しておく。
    mp.lastChampionRoute = {
      moves: path.map((s) => ({ ...s })),
      startSnapshot: mp.roundStartSnapshot.map((p) => ({ ...p })),
    };
    setStatus(`🤖 コンピュータの最短手順は ${path.length}手 でした。`);
    mp.robots = mp.roundStartSnapshot.map((p) => ({ ...p }));
    mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));
    let i = 0;
    function step() {
      if (i >= path.length) {
        showRoundResultBanner("引き分け！", awaitNextRoundReady);
        return;
      }
      const s = path[i++];
      const waypoints = s.bends && s.bends.length > 0 ? [...s.bends, s.to] : [s.to];
      animateAlongPath(s.robot, waypoints, step);
    }
    step();
  }

  // ================= 次の問題への準備確認 =================
  // ラウンドが終わった直後（コンピュータの答え合わせ、または誰かの得点の
  // 後）にだけ、でかでかとしたオーバーレイでプレイヤー一覧と準備状況を
  // 表示し、全員が「準備完了」を押すのを待ってから次のゴールを表示する。

  function isPlayerConnected(p) {
    if (p.peerId === mp.myPeerId) return true;
    const netP = window.HRNet.getPeerList().find((x) => x.peerId === p.peerId);
    return netP ? netP.connected : false;
  }

  // ================= 残り一人になった時のソロモード提案 =================

  function isHostAlone() {
    if (!mp.isHost) return false;
    const others = mp.players.filter((p) => p.peerId !== mp.myPeerId);
    return others.length > 0 && others.every((p) => !isPlayerConnected(p));
  }

  function checkAloneStatus() {
    if (!mp.isHost) return;
    const alone = isHostAlone();
    if (alone) {
      if (mp.aloneTimer || mp.aloneHandled) return; // 既にタイマー中、または既に提案済み
      mp.aloneTimer = setTimeout(() => {
        mp.aloneTimer = null;
        if (!isHostAlone()) return; // タイマーの間に誰かが戻ってきていた
        showSoloSuggestOverlay();
      }, 15000);
    } else {
      // 誰かが戻ってきた：待機中のタイマー・表示中の提案・常設の切替ボタンを片付ける
      if (mp.aloneTimer) { clearTimeout(mp.aloneTimer); mp.aloneTimer = null; }
      mp.aloneHandled = false;
      const overlay = document.getElementById("solo-suggest-overlay");
      if (overlay) overlay.classList.add("hidden");
      const switchBtn = document.getElementById("btn-switch-to-solo");
      if (switchBtn) switchBtn.classList.add("hidden");
    }
  }

  function showSoloSuggestOverlay() {
    if (!isHostAlone()) return;
    mp.aloneHandled = true;
    // 準備確認画面が出ていた場合は、提案ダイアログの邪魔になるので
    // 一旦隠しておく。「待機する」を選んだ時だけ再表示する。
    const readyOverlay = document.getElementById("next-ready-overlay");
    if (readyOverlay && !readyOverlay.classList.contains("hidden")) {
      readyOverlay.classList.add("hidden");
      mp.soloSuggestOverlayHiddenNextReady = true;
    } else {
      mp.soloSuggestOverlayHiddenNextReady = false;
    }
    const overlay = document.getElementById("solo-suggest-overlay");
    if (overlay) overlay.classList.remove("hidden");
  }

  function onSoloSuggestWait() {
    const overlay = document.getElementById("solo-suggest-overlay");
    if (overlay) overlay.classList.add("hidden");
    if (mp.soloSuggestOverlayHiddenNextReady) {
      const readyOverlay = document.getElementById("next-ready-overlay");
      if (readyOverlay) readyOverlay.classList.remove("hidden");
      mp.soloSuggestOverlayHiddenNextReady = false;
    }
    // ホストが一人のままである限りだけ表示する常設の切替ボタン
    const switchBtn = document.getElementById("btn-switch-to-solo");
    if (switchBtn) switchBtn.classList.toggle("hidden", !isHostAlone());
  }

  function onSoloSuggestSwitch() {
    const overlay = document.getElementById("solo-suggest-overlay");
    if (overlay) overlay.classList.add("hidden");
    switchToSoloMode();
  }

  // 現在の問題が始まった時点の配置に戻し、盤面・ロボット配置・残り目標数を
  // 一時的に保存したうえで、その情報をもとにソロモード画面を開く。
  function switchToSoloMode() {
    if (mp.aloneTimer) { clearTimeout(mp.aloneTimer); mp.aloneTimer = null; }
    const remainingGoalsCount = Math.max(1, mp.totalRounds - mp.goalIndex);
    const presetState = {
      board: mp.board,
      robots: mp.roundStartSnapshot ? mp.roundStartSnapshot.map((p) => ({ ...p })) : mp.robots.map((p) => ({ ...p })),
      currentGoal: mp.currentGoal ? { ...mp.currentGoal } : null,
      remainingGoalsCount,
    };
    const colorMode = mp.colors && mp.colors.length >= 5 ? "five" : "four";
    const useDiagonals = !!(mp.settings && mp.settings.diagonals);
    if (typeof window.HROnline === "object" && typeof window.HROnline.leaveRoomPermanently === "function") {
      window.HROnline.leaveRoomPermanently();
    }
    window.startHyperRobotsGame(colorMode, useDiagonals, presetState);
  }

  function renderNextReadyPlayerList() {
    const list = document.getElementById("next-ready-player-list");
    if (!list) return;
    list.innerHTML = "";
    mp.players.forEach((p) => {
      const row = document.createElement("div");
      row.className = "next-ready-player-row" + (isPlayerConnected(p) ? "" : " disconnected");

      const avatar = document.createElement("div");
      avatar.className = "next-ready-player-avatar";
      if (typeof window.renderProfileAvatar === "function") {
        window.renderProfileAvatar(avatar, p.profile);
      }
      row.appendChild(avatar);

      const name = document.createElement("span");
      name.className = "next-ready-player-name";
      const hostLabel = p.peerId === room_hostPeerId() ? "［ホスト］" : "";
      name.textContent = (p.name || "プレイヤー") + hostLabel + (isPlayerConnected(p) ? "" : "［切断中］");
      row.appendChild(name);

      const status = document.createElement("span");
      const isReady = mp.readyForNext.has(p.peerId);
      status.className = "next-ready-player-status" + (isReady ? " is-ready" : "");
      status.textContent = isReady ? "準備完了" : "未準備";
      row.appendChild(status);

      list.appendChild(row);
    });
  }

  function renderNextReadyCountdown() {
    const el = document.getElementById("next-ready-countdown");
    if (!el) return;
    el.textContent = mp.countdownKind === "nextready" ? `残り${mp.countdownRemaining}秒` : "";
  }

  function awaitNextRoundReady() {
    if (mp.settings.nextReadyTimeout === "off") {
      // 準備確認をスキップして、すぐ次の目標へ（実際に進行させるのはホストだけ）
      if (mp.isHost) nextGoal();
      return;
    }
    mp.readyForNext = new Set();
    mp.myReadyForNext = false;
    const overlay = document.getElementById("next-ready-overlay");
    if (overlay) overlay.classList.remove("hidden");
    const heading = document.querySelector(".next-ready-heading");
    if (heading) {
      heading.textContent = mp.suddenDeathActive
        ? "サドンデス！準備はいいですか？"
        : "次の問題へ進む準備はいいですか？";
    }
    const btn = document.getElementById("btn-online-next-ready");
    if (btn) btn.disabled = false;
    const replayBtn = document.getElementById("btn-watch-champion-replay");
    if (replayBtn) {
      replayBtn.classList.toggle("hidden", !mp.lastChampionRoute);
      replayBtn.disabled = false;
    }
    const veil = document.getElementById("next-ready-replay-veil");
    if (veil) veil.classList.add("hidden");
    renderNextReadyPlayerList();

    if (mp.settings.nextReadyTimeout === "unlimited") {
      mp.countdownKind = null;
      renderNextReadyCountdown();
      return;
    }

    // 全員が押さなくても、設定した時間が経てば自動的に次へ進む
    const seconds = Number(mp.settings.nextReadyTimeout);
    mp.countdownKind = "nextready";
    if (mp.isHost) {
      startCountdown(seconds, () => {
        hideNextReadyOverlay();
        nextGoal();
      });
      mp.net.broadcast({ type: "nextready-countdown-start", endTime: mp.countdownEndTime });
    }
    // ゲスト側は、ここでは独立にタイマーを開始しない。ホストからの
    // nextready-countdown-start メッセージに含まれる絶対時刻を受け取って
    // から始めることで、ホストとのズレが生まれないようにする。
  }

  function hideNextReadyOverlay() {
    const overlay = document.getElementById("next-ready-overlay");
    if (overlay) overlay.classList.add("hidden");
    mp.countdownKind = null;
  }

  // 準備確認画面の「最短手のリプレイを見る」。カード全体を半透明にして
  // 操作できないようにしたうえで、直前のラウンドの勝者の手順を最初から
  // 再生する。終わったら、実際の（＝チャンピオンの最終到達位置である）
  // ロボット状態に戻し、操作を再開できるようにする。
  function watchChampionReplay() {
    if (!mp.lastChampionRoute) return;
    // 再生中は準備確認画面自体が盤面を隠してしまい見えないので、
    // 半透明にするだけでなく、画面ごと一時的に非表示にする。
    // 終わったら再表示する。
    const overlay = document.getElementById("next-ready-overlay");
    const wasHidden = overlay ? overlay.classList.contains("hidden") : true;
    if (overlay) overlay.classList.add("hidden");
    const replayBtn = document.getElementById("btn-watch-champion-replay");
    const readyBtn = document.getElementById("btn-online-next-ready");
    if (replayBtn) replayBtn.disabled = true;
    if (readyBtn) readyBtn.disabled = true;

    const route = mp.lastChampionRoute;
    const positionToRestore = mp.robots.map((p) => ({ ...p })); // 再生前の（＝チャンピオンの最終到達位置のはずの）状態を退避
    mp.robots = route.startSnapshot.map((p) => ({ ...p }));
    mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));

    let i = 0;
    function step() {
      if (i >= route.moves.length) {
        mp.robots = positionToRestore.map((p) => ({ ...p }));
        mp.robots.forEach((p, idx) => setPercentPos(mp.robotEls[idx], p.r, p.c));
        if (overlay && !wasHidden) overlay.classList.remove("hidden");
        if (replayBtn) replayBtn.disabled = false;
        if (readyBtn) readyBtn.disabled = mp.myReadyForNext;
        return;
      }
      const s = route.moves[i++];
      const waypoints = s.bends && s.bends.length > 0 ? [...s.bends, s.to] : [s.to];
      animateAlongPath(s.robot, waypoints, step);
    }
    step();
  }

  function nextRoundReady() {
    if (mp.myReadyForNext) return;
    mp.myReadyForNext = true;
    const btn = document.getElementById("btn-online-next-ready");
    if (btn) btn.disabled = true;
    const msg = { type: "next-ready", peerId: mp.myPeerId };
    if (mp.isHost) {
      applyNextReady(msg);
    } else {
      mp.net.broadcast(msg);
    }
  }

  function applyNextReady(msg) {
    if (!mp.isHost) return;
    mp.readyForNext.add(msg.peerId);
    const active = activePeerIds();
    const total = active.length;
    const count = active.filter((id) => mp.readyForNext.has(id)).length;
    const tally = { type: "next-ready-tally", readyPeerIds: Array.from(mp.readyForNext) };
    mp.net.broadcast(tally);
    applyNextReadyTally(tally);
    if (total > 0 && count >= total) {
      stopCountdown();
      hideNextReadyOverlay();
      nextGoal();
    }
  }

  function applyNextReadyTally(msg) {
    mp.readyForNext = new Set(msg.readyPeerIds || []);
    renderNextReadyPlayerList();
  }

  // ================= 切断通知（でかでかバナー） =================

  function showDisconnectBanner(peerId) {
    const banner = document.getElementById("disconnect-banner");
    if (!banner || !mp) return;
    const p = mp.players.find((x) => x.peerId === peerId);
    const name = p ? p.name || "プレイヤー" : "プレイヤー";
    banner.innerHTML = `<div class="clear-banner-text"><span class="clear-banner-text-inner">${name}さんが<span class="clear-banner-sub">切断されました</span></span></div>`;
    banner.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void banner.offsetWidth;
    banner.classList.add("show");
  }

  function showHostChangedBanner(oldHostPeerId, newHostPeerId) {
    const banner = document.getElementById("disconnect-banner");
    if (!banner || !mp) return;
    const oldP = mp.players.find((x) => x.peerId === oldHostPeerId);
    const oldName = oldP ? oldP.name || "プレイヤー" : "プレイヤー";
    const iAmNewHost = newHostPeerId === mp.myPeerId;
    const whoBecameHost = iAmNewHost
      ? "あなたがホストになりました"
      : (() => {
          const newP = mp.players.find((x) => x.peerId === newHostPeerId);
          const newName = newP ? newP.name || "プレイヤー" : "プレイヤー";
          return `${newName}さんがホストになりました`;
        })();
    banner.innerHTML = `<div class="clear-banner-text"><span class="clear-banner-text-inner">${oldName}さんが切断されました。<span class="clear-banner-sub">${whoBecameHost}</span></span></div>`;
    banner.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void banner.offsetWidth;
    banner.classList.add("show");
  }

  // ================= online.js からのメッセージ受け口 =================

  window.handleOnlineGameMessage = function (msg) {
    if (!mp) return;
    if (msg.type === "goal-reveal") {
      applyGoalReveal(msg.goal, msg.robots, msg.goalIndex);
    } else if (msg.type === "declare-update") {
      if (mp.isHost) {
        applyDeclare(msg);
      } else if (!mp.bestDeclare || msg.moveCount < mp.bestDeclare.moveCount) {
        const isFirst = msg.isFirst != null ? msg.isFirst : !mp.bestDeclare;
        mp.bestDeclare = { peerId: msg.peerId, moveCount: msg.moveCount };
        refreshGiveUpButtonState();
        showRaceFlashBanner(isFirst, msg.peerId, msg.moveCount);
        if (msg.endTime) {
          mp.countdownKind = "declare";
          startDisplayCountdown(msg.endTime);
        }
        renderRaceStatus();
      }
    } else if (msg.type === "verify-request") {
      if (msg.peerId === mp.myPeerId) submitVerification();
    } else if (msg.type === "round-result") {
      applyRoundResult(msg);
    } else if (msg.type === "round-invalid") {
      applyRoundInvalid(msg);
    } else if (msg.type === "giveup-vote") {
      if (mp.isHost) applyGiveUpVote(msg);
    } else if (msg.type === "giveup-flash") {
      if (!mp.isHost) showGiveUpFlashBanner(msg.peerId); // ホストは投票処理時に自分で既に表示済み
    } else if (msg.type === "giveup-concede-tally") {
      applyGiveUpConcedeTally(msg);
    } else if (msg.type === "giveup-countdown-start") {
      mp.countdownKind = "giveup";
      applyGiveUpCountdownStart(msg);
    } else if (msg.type === "giveup-cancelled") {
      applyGiveUpCancelled();
    } else if (msg.type === "giveup-reveal") {
      applyGiveUpReveal(msg);
    } else if (msg.type === "next-ready") {
      if (mp.isHost) applyNextReady(msg);
    } else if (msg.type === "next-ready-tally") {
      applyNextReadyTally(msg);
    } else if (msg.type === "nextready-countdown-start") {
      if (!mp.isHost) startDisplayCountdown(msg.endTime);
    } else if (msg.type === "match-over") {
      applyMatchOver(msg);
    } else if (msg.type === "sudden-death-start") {
      applySuddenDeathStart();
    } else if (msg.type === "rematch-vote") {
      if (mp.isHost) applyRematchVote(msg);
    } else if (msg.type === "rematch-tally") {
      applyRematchTally(msg);
    } else if (msg.type === "rematch-start") {
      applyRematchStart();
    } else if (msg.type === "match-back-to-title") {
      applyBackToTitleBroadcast();
    }
  };

  window.verifyOnlineSubmission = function (msg) {
    verifySubmission(msg);
  };

  function regenerateGame() {
    if (!mp.isHost) return;
    const ok = window.confirm("新しいマップを生成すると、現在のゲーム内容（得点・進行状況）はリセットされます。よろしいですか？");
    if (!ok) return;
    if (typeof window.showMapGenOverlay === "function") window.showMapGenOverlay();
    const generator = window.createIncrementalBoardGenerator({ useDiagonals: mp.settings.diagonals, colors: mp.colors });
    function step() {
      const res = generator.step(80);
      if (res.status !== "done") {
        setTimeout(step, 0);
        return;
      }
      if (typeof window.hideMapGenOverlay === "function") window.hideMapGenOverlay();
      const board = res.board;
      const targetQueue = shuffle(board.targets);
      const payload = {
        type: "start-game",
        board: window.HROnline.serializeBoard(board),
        colorMode: mp.settings.colorMode,
        diagonals: mp.settings.diagonals,
        targetOrder: targetQueue,
        settings: mp.settings,
        players: mp.players,
      };
      mp.net.broadcast(payload);
      applyStartGamePayload(payload);
    }
    step();
  }

  function deserializeBoardLocal(data) {
    return {
      hWalls: new Set(data.hWalls),
      vWalls: new Set(data.vWalls),
      blocked: new Set(data.blocked),
      diagonals: new Map(data.diagonals || []),
      targets: data.targets,
    };
  }

  // ホストが対局中に broadcast した start-game を、自分自身にも同じ形で適用する
  function applyStartGamePayload(payload) {
    window.startOnlineHyperRobotsGame({
      board: deserializeBoardLocal(payload.board),
      colorMode: payload.colorMode,
      players: payload.players,
      targetOrder: payload.targetOrder,
      settings: payload.settings,
      myPeerId: mp.myPeerId,
      isHost: mp.isHost,
      net: mp.net,
    });
  }

  function updateNewMapButtonForOnline() {
    const btn = document.getElementById("btn-new-map");
    if (!btn) return;
    btn.classList.toggle("hidden", !mp.isHost);
  }

  // 対局中に一度タブを閉じた／タイトルへ戻ったプレイヤーが、同じ
  // ルームIDで戻ってきたときに、ロビー画面を経由せず今の対局へ
  // そのまま合流するための入り口。startOnlineHyperRobotsGame との違いは
  // 「盤面・ロボット位置・得点などを新規に作らず、ホストから届いた
  // スナップショットをそのまま復元する」点だけ。
  window.resumeOnlineHyperRobotsGame = function (cfg, snap) {
    resetMpStateFromSnapshot(cfg, snap);
    lastKnownHostPeerId = window.HRNet.getHostPeerId();
    window.__HR_ONLINE_ACTIVE = true;
    document.getElementById("solo-controls").classList.add("hidden");
    document.getElementById("online-controls").classList.remove("hidden");
    document.getElementById("online-hud").classList.remove("hidden");
    const playerBadge = document.getElementById("player-badge");
    if (playerBadge) playerBadge.classList.remove("hidden");
    updateNewMapButtonForOnline();

    const playModeBadge = document.getElementById("play-mode-badge");
    if (playModeBadge) playModeBadge.textContent = "オンライン対戦モード";
    const colorModeBadge = document.getElementById("color-mode-badge");
    if (colorModeBadge) colorModeBadge.textContent = snap.colorMode === "five" ? "5色モード" : "4色モード";
    const diagonalBadge = document.getElementById("diagonal-mode-badge");
    if (diagonalBadge) diagonalBadge.style.display = mp.settings && mp.settings.diagonals ? "" : "none";
    const roomIdBadge = document.getElementById("room-id-badge");
    if (roomIdBadge && window.HRNet && window.HRNet.getRoomId()) {
      roomIdBadge.textContent = `ルームID: ${window.HRNet.getRoomId()}`;
      roomIdBadge.classList.remove("hidden");
    }

    renderBoard();
    renderRobots();
    renderHud();
    wireOnlineControlsOnce();

    mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));
    if (mp.currentGoal) {
      placeGoalIndicator();
      refreshTargetEmphasis();
      const shapeLabel = SHAPE_INFO[mp.currentGoal.shape].label;
      const desc = mp.currentGoal.color === "rainbow"
        ? `いずれかのロボットを${shapeLabel}のマスへ`
        : `${COLOR_INFO[mp.currentGoal.color].label}ロボットを${shapeLabel}のマスへ`;
      const goalDescEl = document.getElementById("goal-desc");
      if (goalDescEl) goalDescEl.textContent = desc;
      const goalIconEl = document.getElementById("goal-icon");
      if (goalIconEl) {
        // applyGoalReveal() と同じ組み立て方に揃える。goalIconEl 自身に
        // 形のクラスを付けてしまうと、次に新しい目標が出た時（通常の
        // applyGoalReveal 経由）は中の子要素だけが更新され、この枠自体の
        // 形は古いまま残ってしまう。
        goalIconEl.className = "goal-icon";
        goalIconEl.style.background = "";
        goalIconEl.innerHTML = "";
        const icon = document.createElement("div");
        icon.className = `target-icon shape-${mp.currentGoal.shape} tint-${mp.currentGoal.color} active`;
        goalIconEl.appendChild(icon);
      }
    }
    updateGoalsRemaining();
    updateMoveCount();
    renderRaceStatus();
    if (mp.countdownKind && mp.countdownEndTime > Date.now()) {
      startCountdown(Math.ceil((mp.countdownEndTime - Date.now()) / 1000), mp.countdownKind === "declare" ? requestVerification : undefined);
    }

    const overlay = document.getElementById("title-screen");
    if (overlay) overlay.classList.add("hidden");
    document.body.classList.remove("title-active");
  };

  let controlsWired = false;
  function wireOnlineControlsOnce() {
    if (controlsWired) return;
    controlsWired = true;
    document.getElementById("board").addEventListener("click", () => {
      if (mp.locked || mp.selectedRobot === null) return;
      mp.robotEls[mp.selectedRobot].classList.remove("selected");
      mp.selectedRobot = null;
      clearArrows();
    });

    document.getElementById("btn-online-undo").addEventListener("click", undo);
    document.getElementById("btn-online-redo").addEventListener("click", redo);
    document.getElementById("btn-online-reset").addEventListener("click", resetToRoundStart);
    document.getElementById("btn-online-declare").addEventListener("click", declare);
    document.getElementById("btn-online-giveup").addEventListener("click", giveUp);
    document.getElementById("btn-online-next-ready").addEventListener("click", nextRoundReady);
    document.getElementById("btn-watch-champion-replay").addEventListener("click", watchChampionReplay);
    document.getElementById("btn-switch-to-solo").addEventListener("click", switchToSoloMode);
    document.getElementById("btn-solo-suggest-wait").addEventListener("click", onSoloSuggestWait);
    document.getElementById("btn-solo-suggest-switch").addEventListener("click", onSoloSuggestSwitch);
    document.getElementById("btn-result-rematch").addEventListener("click", clickRematch);
    document.getElementById("btn-result-back-title").addEventListener("click", clickBackToTitleFromResult);
    document.getElementById("btn-new-map").addEventListener("click", () => {
      if (!window.__HR_ONLINE_ACTIVE || !mp || !mp.isHost) return;
      regenerateGame();
    });
    window.HRNet.on("peer-disconnected", (peerId) => {
      if (window.__HR_ONLINE_ACTIVE) showDisconnectBanner(peerId);
    });
    window.HRNet.on("host-changed", (newHostPeerId) => {
      // 対局中にホストが切断し、別のプレイヤーへ引き継がれた場合に、
      // 誰でも見えるようにその旨を知らせる。
      if (window.__HR_ONLINE_ACTIVE && mp) {
        const oldHostPeerId = lastKnownHostPeerId;
        mp.isHost = window.HRNet.isHost();
        showHostChangedBanner(oldHostPeerId, newHostPeerId);
        renderHud();
      }
      lastKnownHostPeerId = newHostPeerId;
    });
    window.HRNet.on("peer-list-changed", () => {
      // 対局中に誰かが切断／復帰した時、HUDと（表示中なら）準備確認の
      // オーバーレイの表示をその場で最新の接続状況に合わせて更新する
      if (!window.__HR_ONLINE_ACTIVE || !mp) return;
      renderHud();
      const overlay = document.getElementById("next-ready-overlay");
      if (overlay && !overlay.classList.contains("hidden")) {
        renderNextReadyPlayerList();
      }
      checkAloneStatus();
    });
  }

  window.startOnlineHyperRobotsGame = function (cfg) {
    resetMpState(cfg);
    lastKnownHostPeerId = window.HRNet.getHostPeerId();
    window.__HR_ONLINE_ACTIVE = true;
    document.getElementById("solo-controls").classList.add("hidden");
    document.getElementById("online-controls").classList.remove("hidden");
    document.getElementById("online-hud").classList.remove("hidden");
    const playerBadge = document.getElementById("player-badge");
    if (playerBadge) playerBadge.classList.remove("hidden");
    updateNewMapButtonForOnline();

    const playModeBadge = document.getElementById("play-mode-badge");
    if (playModeBadge) playModeBadge.textContent = "オンライン対戦モード";
    const colorModeBadge = document.getElementById("color-mode-badge");
    if (colorModeBadge) colorModeBadge.textContent = cfg.colorMode === "five" ? "5色モード" : "4色モード";
    const diagonalBadge = document.getElementById("diagonal-mode-badge");
    if (diagonalBadge) diagonalBadge.style.display = cfg.settings && cfg.settings.diagonals ? "" : "none";
    const roomIdBadge = document.getElementById("room-id-badge");
    if (roomIdBadge && window.HRNet && window.HRNet.getRoomId()) {
      roomIdBadge.textContent = `ルームID: ${window.HRNet.getRoomId()}`;
      roomIdBadge.classList.remove("hidden");
    }

    renderBoard();
    mp.robots = placeRobotsRandomly();
    renderRobots();
    renderHud();
    wireOnlineControlsOnce();

    if (mp.isHost) {
      nextGoal();
    }
  };

  // ソロモードに戻る／タイトルへ戻るときに、進行中のオンライン対局の
  // タイマー等をきちんと止めておくための後始末関数
  window.stopOnlineGame = function () {
    if (mp) {
      stopCountdown();
      mp = null;
    }
  };

  // 切断していたプレイヤーが（新しいpeerIdで）復帰した時、online.js側で
  // 「本人の再接続」だと判定できたら呼ばれる。得点などpeerId紐づけの
  // 状態を、古いIDから新しいIDへ引き継ぐ。
  window.remapOnlinePlayerId = function (oldPeerId, newPeerId) {
    if (!mp || oldPeerId === newPeerId) return;
    if (mp.scores[oldPeerId] !== undefined) {
      mp.scores[newPeerId] = mp.scores[oldPeerId];
      delete mp.scores[oldPeerId];
    }
    const player = mp.players.find((p) => p.peerId === oldPeerId);
    if (player) player.peerId = newPeerId;
    if (mp.bestDeclare && mp.bestDeclare.peerId === oldPeerId) {
      mp.bestDeclare.peerId = newPeerId;
    }
    if (mp.giveUpVoters.has(oldPeerId)) {
      mp.giveUpVoters.delete(oldPeerId);
      mp.giveUpVoters.add(newPeerId);
    }
    if (mp.readyForNext.has(oldPeerId)) {
      mp.readyForNext.delete(oldPeerId);
      mp.readyForNext.add(newPeerId);
    }
    if (window.__HR_ONLINE_ACTIVE) {
      renderHud();
      renderRaceStatus();
    }
  };

  // テスト用に内部状態を覗けるようにしておく
  // 対局中に一度離脱したプレイヤーが同じルームで戻ってきたとき、
  // ホスト側がロビーを経由せず今の対局へ直接合流させるために使う。
  window.getOnlineResumeSnapshot = function () {
    return buildResumeSnapshot();
  };
  window.isOnlineGameActive = function () {
    return !!(mp && window.__HR_ONLINE_ACTIVE);
  };
  // online.js側の「参加者一覧が変わった」処理から、HUDの接続状況表示を
  // 最新化してもらうための入り口。resumeOnlineHyperRobotsGame() 内で
  // 登録するリスナーだけに頼ると、再接続直後にメッシュ接続がちょうど
  // 確立したタイミングのイベントを取りこぼし、実際にはつながっている
  // 相手がいつまでも［切断中］のまま表示され続けることがある。
  window.refreshOnlineHud = function () {
    if (!window.__HR_ONLINE_ACTIVE || !mp) return;
    renderHud();
    const overlay = document.getElementById("next-ready-overlay");
    if (overlay && !overlay.classList.contains("hidden")) {
      renderNextReadyPlayerList();
    }
    checkAloneStatus();
  };

  window._HRMultiplayerDebug = {
    getState: () => mp,
    tickCountdownForTest: () => tickCountdown(),
    triggerEndMatchForTest: () => endMatch(),
  };
})();
