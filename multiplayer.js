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
      declared: false, // 自分がこのラウンドで既に宣言したか
      myDeclaredMoves: null, // 宣言した時点の手順のスナップショット
      giveUpVotes: new Set(), // ホスト側のみで使う集計用
      myGiveUpVoted: false,
      countdownInterval: null,
      countdownRemaining: 0,
      locked: false,
    };
    orderedPlayers.forEach((p) => { mp.scores[p.peerId] = 0; });
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

    mp.goalRingEl = document.createElement("div");
    mp.goalRingEl.className = "goal-ring";
    mp.goalRingEl.style.display = "none";
    boardEl.appendChild(mp.goalRingEl);
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

  function placeGoalRing() {
    if (!mp.currentGoal) return;
    const g = mp.currentGoal;
    mp.goalRingEl.style.display = "block";
    mp.goalRingEl.style.left = (g.c / 16) * 100 + "%";
    mp.goalRingEl.style.top = (g.r / 16) * 100 + "%";
    mp.goalRingEl.style.width = 100 / 16 + "%";
    mp.goalRingEl.style.height = 100 / 16 + "%";
    mp.goalRingEl.style.color = g.color === "rainbow" ? "var(--c-rainbow)" : `var(--c-${g.color})`;
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
    if (mp.locked) return;
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
    if (mp.locked) return;
    const myColor = robotColor(idx);
    const result = window.slide(mp.board, mp.robots, idx, dir, myColor);
    const to = { r: result.r, c: result.c };
    const from = { ...mp.robots[idx] };
    if (to.r === from.r && to.c === from.c) return;

    mp.moveHistory = mp.moveHistory.slice(0, mp.historyIndex);
    mp.moveHistory.push({ robot: idx, dir, from, to, bends: result.bends || [] });
    mp.historyIndex++;

    animateAlongPath(idx, [...(result.bends || []), to], () => {
      updateMoveCount();
      clearArrows();
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
  }

  function undo() {
    if (mp.locked || mp.historyIndex <= 0) return;
    const entry = mp.moveHistory[mp.historyIndex - 1];
    mp.historyIndex--;
    const reversed = entry.bends.slice().reverse().concat([entry.from]);
    animateAlongPath(entry.robot, reversed, () => {
      updateMoveCount();
      if (mp.selectedRobot === entry.robot) showArrowsForRobot(entry.robot);
    });
  }

  function redo() {
    if (mp.locked || mp.historyIndex >= mp.moveHistory.length) return;
    const entry = mp.moveHistory[mp.historyIndex];
    mp.historyIndex++;
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
        chip.textContent = `${p.name || "プレイヤー"}: ${mp.scores[p.peerId] || 0}点`;
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
    if (!mp.bestDeclare) {
      raceBox.textContent = "";
      return;
    }
    const p = mp.players.find((x) => x.peerId === mp.bestDeclare.peerId);
    raceBox.textContent = `現在の最短宣言: ${p ? p.name : "?"} が ${mp.bestDeclare.moveCount}手（残り${mp.countdownRemaining}秒）`;
  }

  function nextGoal() {
    if (!mp.isHost || mp.matchOver) return;
    mp.goalIndex++;
    if (mp.goalIndex >= mp.targetQueue.length) {
      mp.targetQueue = shuffle(mp.board.targets);
      mp.goalIndex = 0;
    }
    const goal = mp.targetQueue[mp.goalIndex];
    mp.net.broadcast({ type: "goal-reveal", goal, robots: mp.robots });
    applyGoalReveal(goal, mp.robots);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function applyGoalReveal(goal, robots) {
    mp.currentGoal = goal;
    mp.roundStartSnapshot = robots.map((p) => ({ ...p }));
    mp.robots = robots.map((p) => ({ ...p }));
    mp.bestDeclare = null;
    mp.declared = false;
    mp.myDeclaredMoves = null;
    mp.giveUpVotes = new Set();
    mp.myGiveUpVoted = false;
    setControlsLocked(false);
    const giveUpBtn = document.getElementById("btn-online-giveup");
    if (giveUpBtn) giveUpBtn.disabled = false;
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
    placeGoalRing();
    refreshTargetEmphasis();
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
    setStatus("新しい目標が現れました。ロボットを動かしてゴールしたら「回答する」で宣言しましょう。");
    renderHud();
    renderRaceStatus();
    renderGiveUpStatus();
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

  function declare() {
    if (!mp.currentGoal || mp.declared) return;
    if (!isGoalSatisfiedLocally()) {
      setStatus("まだ目標のマスに到達していません。ロボットを動かしてからもう一度「回答する」を押してください。");
      return;
    }
    // 宣言した時点の手順を確定させ、以降に操作しても提出内容が変わらないようにする
    mp.declared = true;
    mp.myDeclaredMoves = mp.moveHistory.slice(0, mp.historyIndex).map((m) => ({ robot: m.robot, dir: m.dir }));
    setControlsLocked(true);
    const msg = { type: "declare-update", peerId: mp.myPeerId, moveCount: mp.historyIndex };
    if (mp.isHost) {
      applyDeclare(msg);
      mp.net.broadcast(msg);
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

  function applyDeclare(msg) {
    if (!mp.isHost) return;
    if (!mp.bestDeclare || msg.moveCount < mp.bestDeclare.moveCount) {
      mp.bestDeclare = { peerId: msg.peerId, moveCount: msg.moveCount };
      startCountdown();
      mp.net.broadcast({ type: "declare-update", peerId: msg.peerId, moveCount: msg.moveCount, timeLimit: mp.settings.answerTimeLimit });
    }
  }

  function startCountdown() {
    stopCountdown();
    mp.countdownRemaining = mp.settings.answerTimeLimit;
    renderRaceStatus();
    mp.countdownInterval = setInterval(() => {
      mp.countdownRemaining--;
      renderRaceStatus();
      if (mp.countdownRemaining <= 0) {
        stopCountdown();
        if (mp.isHost) requestVerification();
      }
    }, 1000);
  }

  // ゲスト側の表示専用カウントダウン。実際の判定・検証要求はホストの
  // カウントダウン（startCountdown）だけが行うので、ここでは見た目の
  // 秒数を進めるだけ。
  function startDisplayCountdown(initialSeconds) {
    stopCountdown();
    mp.countdownRemaining = initialSeconds;
    renderRaceStatus();
    mp.countdownInterval = setInterval(() => {
      mp.countdownRemaining--;
      renderRaceStatus();
      if (mp.countdownRemaining <= 0) {
        stopCountdown();
      }
    }, 1000);
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
    mp.net.broadcast({
      type: "verify-submit",
      peerId: mp.myPeerId,
      moves: mp.myDeclaredMoves || [],
    });
  }

  // ホスト側: 提出された手順を、ラウンド開始時点の盤面で再生して検証する
  function verifySubmission(msg) {
    if (!mp.isHost || !mp.currentGoal) return;
    const simRobots = mp.roundStartSnapshot.map((p) => ({ ...p }));
    let valid = true;
    msg.moves.forEach((step) => {
      if (!valid) return;
      const color = robotColor(step.robot);
      const dest = window.slide(mp.board, simRobots, step.robot, step.dir, color);
      if (dest.r === simRobots[step.robot].r && dest.c === simRobots[step.robot].c) {
        valid = false; // 実際には動けない手が含まれていた
        return;
      }
      simRobots[step.robot] = dest;
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

    if (valid && reachedGoal && countMatches) {
      mp.scores[msg.peerId] = (mp.scores[msg.peerId] || 0) + 1;
      mp.roundsPlayed++;
      const decided = !mp.settings.playUntilEnd && isOutcomeDecided();
      mp.net.broadcast({
        type: "round-result",
        winnerId: msg.peerId,
        moveCount: msg.moves.length,
        scores: mp.scores,
        roundsPlayed: mp.roundsPlayed,
        matchOver: decided,
      });
      applyRoundResult({ winnerId: msg.peerId, moveCount: msg.moves.length, scores: mp.scores, roundsPlayed: mp.roundsPlayed, matchOver: decided });
      if (decided) {
        mp.matchOver = true;
      } else {
        setTimeout(() => nextGoal(), 1800);
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

  function applyRoundResult(msg) {
    mp.scores = msg.scores;
    if (msg.roundsPlayed != null) mp.roundsPlayed = msg.roundsPlayed;
    const p = mp.players.find((x) => x.peerId === msg.winnerId);
    if (msg.matchOver) {
      mp.matchOver = true;
      const topScore = Math.max(...mp.players.map((pl) => mp.scores[pl.peerId] || 0));
      const winner = mp.players.find((pl) => (mp.scores[pl.peerId] || 0) === topScore);
      setStatus(`🎉 ${p ? p.name : "?"} が ${msg.moveCount}手でクリア！ 逆転不可能のため対戦終了 — 優勝: ${winner ? winner.name : "?"}`);
    } else {
      setStatus(`🎉 ${p ? p.name : "?"} が ${msg.moveCount}手でクリア！`);
    }
    renderHud();
  }

  function applyRoundInvalid(msg) {
    const p = mp.players.find((x) => x.peerId === msg.peerId);
    setStatus(`⚠️ ${p ? p.name : "?"} の宣言は手順を確認できませんでした。他の人はまだ宣言できます。`);
    if (msg.peerId === mp.myPeerId) {
      // 自分の宣言が無効になった場合は、操作を再開できるようにする
      mp.declared = false;
      mp.myDeclaredMoves = null;
      setControlsLocked(false);
    }
    renderRaceStatus();
  }

  // ================= ギブアップ（答えを見る） =================

  function renderGiveUpStatus() {
    const box = document.getElementById("online-hud-giveup");
    if (box) box.textContent = "";
  }

  function applyGiveUpTally(msg) {
    const box = document.getElementById("online-hud-giveup");
    if (box) box.textContent = `🏳️ ギブアップ: ${msg.count}/${msg.total}人`;
  }

  function giveUp() {
    if (!mp.currentGoal || mp.myGiveUpVoted) return;
    mp.myGiveUpVoted = true;
    const btn = document.getElementById("btn-online-giveup");
    if (btn) btn.disabled = true;
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

  function applyGiveUpVote(msg) {
    if (!mp.isHost) return;
    mp.giveUpVotes.add(msg.peerId);
    const active = activePeerIds();
    const total = active.length;
    const count = active.filter((id) => mp.giveUpVotes.has(id)).length;
    if (total > 0 && count >= total) {
      revealGiveUpAnswer();
    } else {
      const tally = { type: "giveup-tally", count, total };
      mp.net.broadcast(tally);
      applyGiveUpTally(tally);
    }
  }

  function revealGiveUpAnswer() {
    if (!mp.isHost) return;
    const goalColorIdx = mp.currentGoal.color === "rainbow" ? "any" : colorIndexOfColor(mp.currentGoal.color);
    const solver = new IncrementalSolver(mp.board, mp.roundStartSnapshot, goalColorIdx, mp.currentGoal.r, mp.currentGoal.c, mp.colors);
    let solved = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const res = solver.step(20);
      if (res.status === "found") { solved = res.path; break; }
      if (res.status === "not_found") break;
    }
    const msg = { type: "giveup-reveal", path: solved || [] };
    mp.net.broadcast(msg);
    applyGiveUpReveal(msg);
  }

  function applyGiveUpReveal(msg) {
    stopCountdown();
    setControlsLocked(true);
    const path = msg.path || [];
    if (path.length === 0) {
      setStatus("😢 コンピュータでも手順を見つけられませんでした。");
      if (mp.isHost) setTimeout(() => nextGoal(), 2200);
      return;
    }
    setStatus(`🤖 コンピュータの最短手順は ${path.length}手 でした。`);
    mp.robots = mp.roundStartSnapshot.map((p) => ({ ...p }));
    mp.robots.forEach((p, i) => setPercentPos(mp.robotEls[i], p.r, p.c));
    let i = 0;
    function step() {
      if (i >= path.length) {
        if (mp.isHost) setTimeout(() => nextGoal(), 1800);
        return;
      }
      const s = path[i++];
      const waypoints = s.bends && s.bends.length > 0 ? [...s.bends, s.to] : [s.to];
      animateAlongPath(s.robot, waypoints, step);
    }
    step();
  }

  // ================= 切断通知（でかでかバナー） =================

  function showDisconnectBanner(peerId) {
    const banner = document.getElementById("disconnect-banner");
    if (!banner || !mp) return;
    const p = mp.players.find((x) => x.peerId === peerId);
    const name = p ? p.name || "プレイヤー" : "プレイヤー";
    banner.innerHTML = `<div class="clear-banner-text">${name}さんが<span class="clear-banner-sub">切断されました</span></div>`;
    banner.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void banner.offsetWidth;
    banner.classList.add("show");
  }

  // ================= online.js からのメッセージ受け口 =================

  window.handleOnlineGameMessage = function (msg) {
    if (!mp) return;
    if (msg.type === "goal-reveal") {
      applyGoalReveal(msg.goal, msg.robots);
    } else if (msg.type === "declare-update") {
      if (mp.isHost) {
        applyDeclare(msg);
      } else if (!mp.bestDeclare || msg.moveCount < mp.bestDeclare.moveCount) {
        mp.bestDeclare = { peerId: msg.peerId, moveCount: msg.moveCount };
        if (msg.timeLimit) {
          startDisplayCountdown(msg.timeLimit);
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
    } else if (msg.type === "giveup-tally") {
      applyGiveUpTally(msg);
    } else if (msg.type === "giveup-reveal") {
      applyGiveUpReveal(msg);
    }
  };

  window.verifyOnlineSubmission = function (msg) {
    verifySubmission(msg);
  };

  let controlsWired = false;

  function regenerateGame() {
    if (!mp.isHost) return;
    const ok = window.confirm("新しいマップを生成すると、現在のゲーム内容（得点・進行状況）はリセットされます。よろしいですか？");
    if (!ok) return;
    const board = window.generateBoard({ useDiagonals: mp.settings.diagonals, colors: mp.colors });
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

  window.startOnlineHyperRobotsGame = function (cfg) {
    resetMpState(cfg);
    window.__HR_ONLINE_ACTIVE = true;
    document.getElementById("solo-controls").classList.add("hidden");
    document.getElementById("online-controls").classList.remove("hidden");
    document.getElementById("online-hud").classList.remove("hidden");
    updateNewMapButtonForOnline();

    renderBoard();
    mp.robots = placeRobotsRandomly();
    renderRobots();
    renderHud();

    if (!controlsWired) {
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
      document.getElementById("btn-new-map").addEventListener("click", () => {
        if (!window.__HR_ONLINE_ACTIVE || !mp || !mp.isHost) return;
        regenerateGame();
      });
      window.HRNet.on("peer-disconnected", (peerId) => {
        if (window.__HR_ONLINE_ACTIVE) showDisconnectBanner(peerId);
      });
    }

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

  // テスト用に内部状態を覗けるようにしておく
  window._HRMultiplayerDebug = {
    getState: () => mp,
  };
})();
