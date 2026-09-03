/*
 * game.js — 画面表示とゲーム進行を担当します。
 * boards.js（設定データ）と engine.js（判定・探索ロジック）を利用します。
 */

(function () {
  "use strict";

  const MOVE_ANIM_MS = 300;
  const SOLVE_STEP_ANIM_MS = 340;
  const SOLVER_TIME_BUDGET_MS = 10000; // 10秒探索

  // ---------- DOM refs ----------
  const boardEl = document.getElementById("board");
  const goalIconEl = document.getElementById("goal-icon");
  const goalDescEl = document.getElementById("goal-desc");
  const moveCountEl = document.getElementById("move-count");
  const statusLineEl = document.getElementById("status-line");
  const clearedBadgeEl = document.getElementById("cleared-badge");
  const clearBannerEl = document.getElementById("clear-banner");

  const btnNewMap = document.getElementById("btn-new-map");
  const btnBackTitle = document.getElementById("btn-back-title");
  const btnUndo = document.getElementById("btn-undo");
  const btnRedo = document.getElementById("btn-redo");
  const btnReset = document.getElementById("btn-reset");
  const btnCheck = document.getElementById("btn-check");
  const btnNext = document.getElementById("btn-next");

  // ---------- game state ----------
  let ACTIVE_COLORS = COLOR_SETS.four; // 4色モード（デフォルト）／5色モードで切り替え
  let USE_DIAGONALS = false; // 斜め壁（任意）
  let board = null;
  let robots = []; // [{r,c}] indexed by ACTIVE_COLORS
  let cellEls = []; // [r][c] -> DOM element
  let robotEls = []; // indexed by ACTIVE_COLORS -> DOM element
  let arrowEls = []; // currently displayed arrow elements
  let goalRingEl = null;

  let targetQueue = [];
  let goalIndex = -1;
  let currentGoal = null;

  let moveHistory = []; // {robot, from, to}
  let historyIndex = 0;

  let selectedRobot = null;
  let locked = false; // true while an animation is in-flight

  let roundState = { cleared: false, answerRevealed: false };
  let clearedCount = 0;

  let solver = null;
  let solverStatus = "idle"; // idle | searching | found | not_found
  let solverPath = null;
  let solverDeadline = 0;
  let solverStartSnapshot = null;
  let checkPollTimer = null;

  // ---------- helpers ----------
  function cloneRobots(list) {
    return list.map((p) => ({ r: p.r, c: p.c }));
  }

  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setPercentPos(el, r, c) {
    el.style.left = (c / 16) * 100 + "%";
    el.style.top = (r / 16) * 100 + "%";
  }

  function colorIndexOf(color) {
    return ACTIVE_COLORS.indexOf(color);
  }

  function setStatus(text, kind) {
    statusLineEl.textContent = text || "";
    statusLineEl.className = "status-line" + (kind ? " " + kind : "");
  }

  function updateMoveCount() {
    moveCountEl.textContent = String(historyIndex);
  }

  function updateUndoRedoButtons() {
    btnUndo.disabled = locked || historyIndex <= 0;
    btnRedo.disabled = locked || historyIndex >= moveHistory.length;
  }

  // ---------- board rendering ----------
  function buildShapeIcon(color, shape, extraClass) {
    const el = document.createElement("div");
    el.className = `target-icon shape-${shape} tint-${color} ${extraClass || ""}`.trim();
    return el;
  }

  function wallBoxShadow(r, c) {
    const shadows = [];
    const t = 3; // px
    if (board.hWalls.has(`${r},${c}`)) shadows.push(`inset 0 ${t}px 0 0 var(--wall)`);
    if (board.hWalls.has(`${r + 1},${c}`)) shadows.push(`inset 0 -${t}px 0 0 var(--wall)`);
    if (board.vWalls.has(`${r},${c}`)) shadows.push(`inset ${t}px 0 0 0 var(--wall)`);
    if (board.vWalls.has(`${r},${c + 1}`)) shadows.push(`inset -${t}px 0 0 0 var(--wall)`);
    return shadows.join(", ");
  }

  function renderBoardStatic() {
    boardEl.innerHTML = "";
    cellEls = [];

    const targetByCell = new Map();
    board.targets.forEach((t) => targetByCell.set(`${t.r},${t.c}`, t));

    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement("div");
        cell.className = "cell";
        if ((Math.floor(r / 2) + Math.floor(c / 2)) % 2 === 0) cell.classList.add("shade");

        const isBlocked = board.blocked.has(`${r},${c}`);
        if (isBlocked) {
          cell.classList.add("blocked");
        } else {
          const shadow = wallBoxShadow(r, c);
          if (shadow) cell.style.boxShadow = shadow;

          // cosmetic seam between the four 8x8 quadrants
          if (r === 8) cell.style.borderTop = "1px solid #9aa0b3";
          if (c === 8) cell.style.borderLeft = "1px solid #9aa0b3";

          const t = targetByCell.get(`${r},${c}`);
          if (t) {
            const icon = buildShapeIcon(t.color, t.shape);
            icon.dataset.r = r;
            icon.dataset.c = c;
            cell.appendChild(icon);
          }
        }
        boardEl.appendChild(cell);
        row.push(cell);
      }
      cellEls.push(row);
    }

    const core = document.createElement("div");
    core.className = "core";
    boardEl.appendChild(core);

    if (board.diagonals && board.diagonals.size > 0) {
      board.diagonals.forEach((diag) => {
        const el = document.createElement("div");
        const orientClass = diag.orientation === "/" ? "orient-slash" : "orient-backslash";
        el.className = `diagonal-wall ${orientClass}`;
        el.style.setProperty("--diag-color", `var(--c-${diag.color})`);
        setPercentPos(el, diag.r, diag.c);
        el.style.width = 100 / 16 + "%";
        el.style.height = 100 / 16 + "%";
        boardEl.appendChild(el);
      });
    }

    goalRingEl = document.createElement("div");
    goalRingEl.className = "goal-ring";
    goalRingEl.style.display = "none";
    boardEl.appendChild(goalRingEl);
  }

  function renderRobots() {
    robotEls.forEach((el) => el.remove());
    robotEls = [];
    ACTIVE_COLORS.forEach((color, idx) => {
      const el = document.createElement("div");
      el.className = `robot color-${color}`;
      el.innerHTML =
        '<div class="body"><div class="face"><div class="eye"></div><div class="eye"></div></div>' +
        '<div class="mouth"></div>' +
        `<div class="label">${COLOR_INFO[color].initial}</div></div>`;
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `${COLOR_INFO[color].label}のロボット`);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onRobotClick(idx);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRobotClick(idx);
        }
      });
      boardEl.appendChild(el);
      robotEls.push(el);
      setPercentPos(el, robots[idx].r, robots[idx].c);
    });
  }

  function placeGoalRing(r, c) {
    const color = currentGoal ? currentGoal.color : null;
    goalRingEl.style.display = "block";
    goalRingEl.style.left = (c / 16) * 100 + "%";
    goalRingEl.style.top = (r / 16) * 100 + "%";
    goalRingEl.style.width = 100 / 16 + "%";
    goalRingEl.style.height = 100 / 16 + "%";
    goalRingEl.style.color = color ? `var(--c-${color})` : "#fff";
  }

  function refreshTargetEmphasis() {
    document.querySelectorAll(".target-icon.active").forEach((el) => el.classList.remove("active"));
    if (!currentGoal) return;
    const icon = boardEl.querySelector(
      `.target-icon[data-r="${currentGoal.r}"][data-c="${currentGoal.c}"]`
    );
    if (icon) icon.classList.add("active");
  }

  // ---------- arrows ----------
  const ARROW_ROTATION = { N: 0, E: 90, S: 180, W: 270 };

  function arrowSvg() {
    return (
      '<div class="badge"><svg viewBox="0 0 24 24"><path d="M12 4 L20 17 L4 17 Z" fill="#ffffff"/></svg></div>'
    );
  }

  function clearArrows() {
    arrowEls.forEach((el) => el.remove());
    arrowEls = [];
  }

  function showArrowsForRobot(idx) {
    clearArrows();
    const pos = robots[idx];
    ["N", "S", "E", "W"].forEach((dir) => {
      if (!canMoveAtAll(board, robots, idx, dir, ACTIVE_COLORS[idx])) return;
      const { dr, dc } = DIRS[dir];
      const nr = pos.r + dr;
      const nc = pos.c + dc;
      const el = document.createElement("div");
      el.className = "move-arrow";
      el.innerHTML = arrowSvg();
      el.style.transform = `rotate(${ARROW_ROTATION[dir]}deg)`;
      el.setAttribute("tabindex", "0");
      el.setAttribute("role", "button");
      const dirLabel = { N: "上", S: "下", E: "右", W: "左" }[dir];
      el.setAttribute("aria-label", `${dirLabel}へ移動`);
      setPercentPos(el, nr, nc);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        performUserMove(idx, dir);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          performUserMove(idx, dir);
        }
      });
      boardEl.appendChild(el);
      arrowEls.push(el);
    });
  }

  // ---------- selection ----------
  function onRobotClick(idx) {
    if (locked) return;
    if (selectedRobot === idx) {
      selectedRobot = null;
      robotEls[idx].classList.remove("selected");
      clearArrows();
      return;
    }
    if (selectedRobot !== null) robotEls[selectedRobot].classList.remove("selected");
    selectedRobot = idx;
    robotEls[idx].classList.add("selected");
    showArrowsForRobot(idx);
  }

  boardEl.addEventListener("click", () => {
    // clicking empty board space deselects
    if (locked || selectedRobot === null) return;
    robotEls[selectedRobot].classList.remove("selected");
    selectedRobot = null;
    clearArrows();
  });

  document.addEventListener("keydown", (e) => {
    if (locked || selectedRobot === null) return;
    const map = { ArrowUp: "N", ArrowDown: "S", ArrowLeft: "W", ArrowRight: "E" };
    const dir = map[e.key];
    if (!dir) return;
    if (canMoveAtAll(board, robots, selectedRobot, dir, ACTIVE_COLORS[selectedRobot])) {
      e.preventDefault();
      performUserMove(selectedRobot, dir);
    }
  });

  // ---------- movement ----------
  function performUserMove(idx, dir) {
    if (locked) return;
    const from = { ...robots[idx] };
    const result = slide(board, robots, idx, dir, ACTIVE_COLORS[idx]);
    const to = { r: result.r, c: result.c };
    if (to.r === from.r && to.c === from.c) return;

    // truncate redo tail
    moveHistory = moveHistory.slice(0, historyIndex);
    moveHistory.push({ robot: idx, from, to, bends: result.bends || [] });
    historyIndex++;

    const onArrival = () => {
      updateMoveCount();
      updateUndoRedoButtons();
      if (selectedRobot === idx) showArrowsForRobot(idx);
      checkGoalSuccess();
    };
    if (result.bends && result.bends.length > 0) {
      animateMoveAlongPath(idx, [...result.bends, to], onArrival);
    } else {
      animateMove(idx, to, onArrival);
    }
  }

  function animateMove(idx, to, onDone) {
    locked = true;
    clearArrows();
    robots[idx] = to;
    setPercentPos(robotEls[idx], to.r, to.c);
    setTimeout(() => {
      locked = false;
      if (onDone) onDone();
    }, MOVE_ANIM_MS);
  }

  // 斜め壁で方向転換したときに、実際に曲がって進んだように見せるための
  // アニメーション。waypoints は途中の折れ点＋最終地点の配列。
  function animateMoveAlongPath(idx, waypoints, onDone) {
    locked = true;
    clearArrows();
    let i = 0;
    const step = () => {
      if (i >= waypoints.length) {
        locked = false;
        if (onDone) onDone();
        return;
      }
      const wp = waypoints[i++];
      robots[idx] = wp;
      setPercentPos(robotEls[idx], wp.r, wp.c);
      setTimeout(step, MOVE_ANIM_MS);
    };
    step();
  }

  function undoMove() {
    if (locked || historyIndex <= 0) return;
    const entry = moveHistory[historyIndex - 1];
    historyIndex--;
    if (roundState.cleared) {
      roundState.cleared = false;
      setStatus("", "");
    }
    const onDone = () => {
      updateMoveCount();
      updateUndoRedoButtons();
      if (selectedRobot === entry.robot) showArrowsForRobot(entry.robot);
      checkGoalSuccess();
    };
    if (entry.bends && entry.bends.length > 0) {
      const reversed = entry.bends.slice().reverse().concat([entry.from]);
      animateMoveAlongPath(entry.robot, reversed, onDone);
    } else {
      animateMove(entry.robot, entry.from, onDone);
    }
  }

  function redoMove() {
    if (locked || historyIndex >= moveHistory.length) return;
    const entry = moveHistory[historyIndex];
    historyIndex++;
    const onDone = () => {
      updateMoveCount();
      updateUndoRedoButtons();
      if (selectedRobot === entry.robot) showArrowsForRobot(entry.robot);
      checkGoalSuccess();
    };
    if (entry.bends && entry.bends.length > 0) {
      animateMoveAlongPath(entry.robot, [...entry.bends, entry.to], onDone);
    } else {
      animateMove(entry.robot, entry.to, onDone);
    }
  }

  // 現在の目標が現れた時点の位置まで、全ロボットをまとめて戻す。
  function resetRound() {
    if (locked || !solverStartSnapshot) return;
    if (selectedRobot !== null) {
      robotEls[selectedRobot].classList.remove("selected");
      selectedRobot = null;
    }
    clearArrows();
    if (checkPollTimer) {
      clearInterval(checkPollTimer);
      checkPollTimer = null;
    }

    locked = true;
    robots = cloneRobots(solverStartSnapshot);
    ACTIVE_COLORS.forEach((_, idx) => setPercentPos(robotEls[idx], robots[idx].r, robots[idx].c));

    moveHistory = [];
    historyIndex = 0;
    roundState = { cleared: false, answerRevealed: false };

    btnCheck.disabled = false;
    setStatus("リセットしました。もう一度考えてみましょう。", "");

    setTimeout(() => {
      locked = false;
      updateMoveCount();
      updateUndoRedoButtons();
    }, MOVE_ANIM_MS);
  }

  function isAtGoal() {
    if (!currentGoal) return false;
    if (currentGoal.color === "rainbow") {
      return robots.some((p) => p.r === currentGoal.r && p.c === currentGoal.c);
    }
    const p = robots[colorIndexOf(currentGoal.color)];
    return p.r === currentGoal.r && p.c === currentGoal.c;
  }

  // ロボットが目標マスに到達した瞬間、自動的にクリア扱いにする。
  let clearBannerTimer = null;
  function showClearBanner(moves) {
    if (!clearBannerEl) return;
    clearBannerEl.innerHTML = `<div class="clear-banner-text">${moves}手でゴール！<span class="clear-banner-sub">🎉 クリア！</span></div>`;
    // クラスを一度外してから付け直すことで、連続クリア時もアニメーションを
    // 最初からやり直させる。
    clearBannerEl.classList.remove("show");
    // eslint-disable-next-line no-unused-expressions
    void clearBannerEl.offsetWidth; // reflow を強制してアニメーションをリスタート
    clearBannerEl.classList.add("show");
    if (clearBannerTimer) clearTimeout(clearBannerTimer);
    clearBannerTimer = setTimeout(() => {
      clearBannerEl.classList.remove("show");
    }, 1600);
  }

  function checkGoalSuccess() {
    if (!currentGoal || roundState.cleared || roundState.answerRevealed) return;
    if (isAtGoal()) {
      roundState.cleared = true;
      clearedCount++;
      clearedBadgeEl.textContent = `クリア: ${clearedCount}`;
      setStatus(`🎉 クリア！ ${historyIndex}手でゴールに到達しました。`, "success");
      showClearBanner(historyIndex);
    }
  }

  // ---------- background solver ----------
  function startSolverForGoal(goal) {
    solverStartSnapshot = cloneRobots(robots);
    const idx = goal.color === "rainbow" ? "any" : colorIndexOf(goal.color);
    solver = new IncrementalSolver(board, solverStartSnapshot, idx, goal.r, goal.c, ACTIVE_COLORS);
    solverStatus = "searching";
    solverPath = null;
    solverDeadline = Date.now() + SOLVER_TIME_BUDGET_MS;
    scheduleSolverTick();
  }

  function scheduleSolverTick() {
    setTimeout(() => {
      if (solverStatus !== "searching") return;
      const res = solver.step(15);
      if (res.status === "found") {
        solverStatus = "found";
        solverPath = res.path;
        return;
      }
      if (res.status === "not_found" || Date.now() > solverDeadline) {
        solverStatus = "not_found";
        return;
      }
      scheduleSolverTick();
    }, 0);
  }

  function onCheckClick() {
    if (locked || roundState.answerRevealed) return;
    btnCheck.disabled = true;

    if (solverStatus === "found") {
      revealAnswer(solverPath);
      return;
    }
    if (solverStatus === "not_found") {
      setStatus("コンピュータの回答は見つかりませんでした。", "warn");
      btnCheck.disabled = false;
      return;
    }

    setStatus("🤖 コンピュータが思考中です。しばらくお待ちください…", "info");
    if (checkPollTimer) clearInterval(checkPollTimer);
    checkPollTimer = setInterval(() => {
      if (solverStatus === "found") {
        clearInterval(checkPollTimer);
        checkPollTimer = null;
        revealAnswer(solverPath);
      } else if (solverStatus === "not_found" || Date.now() > solverDeadline) {
        solverStatus = "not_found";
        clearInterval(checkPollTimer);
        checkPollTimer = null;
        setStatus("コンピュータの回答は見つかりませんでした。", "warn");
        btnCheck.disabled = false;
      }
    }, 300);
  }

  async function revealAnswer(path) {
    locked = true;
    if (selectedRobot !== null) {
      robotEls[selectedRobot].classList.remove("selected");
      selectedRobot = null;
    }
    clearArrows();

    // reset to the position robots were in when this goal first appeared
    robots = cloneRobots(solverStartSnapshot);
    ACTIVE_COLORS.forEach((_, idx) => setPercentPos(robotEls[idx], robots[idx].r, robots[idx].c));
    await sleep(260);

    if (path.length === 0) {
      setStatus("この目標のロボットは、最初からゴールの位置にいました。", "info");
    } else {
      for (const step of path) {
        const waypoints = (step.bends && step.bends.length > 0) ? [...step.bends, step.to] : [step.to];
        for (const wp of waypoints) {
          robots[step.robot] = wp;
          setPercentPos(robotEls[step.robot], wp.r, wp.c);
          // eslint-disable-next-line no-await-in-loop
          await sleep(SOLVE_STEP_ANIM_MS);
        }
      }
      setStatus(`🤖 コンピュータの最短手順は ${path.length}手 でした。`, "info");
    }

    moveHistory = [];
    historyIndex = 0;
    updateMoveCount();
    roundState.answerRevealed = true;
    updateUndoRedoButtons();
    locked = false;
  }

  // ---------- goal / round progression ----------
  function goalIcon(color, shape) {
    return buildShapeIcon(color, shape, "active");
  }

  function nextGoal() {
    if (checkPollTimer) {
      clearInterval(checkPollTimer);
      checkPollTimer = null;
    }
    solverStatus = "idle";
    solverPath = null;

    goalIndex++;
    if (goalIndex >= targetQueue.length) {
      targetQueue = shuffleArrayLocal(board.targets);
      goalIndex = 0;
    }
    currentGoal = targetQueue[goalIndex];

    moveHistory = [];
    historyIndex = 0;
    selectedRobot = null;
    clearArrows();
    robotEls.forEach((el) => el.classList.remove("selected"));
    roundState = { cleared: false, answerRevealed: false };

    goalIconEl.innerHTML = "";
    goalIconEl.appendChild(goalIcon(currentGoal.color, currentGoal.shape));
    const shapeLabel = SHAPE_INFO[currentGoal.shape].label;
    goalDescEl.textContent =
      currentGoal.color === "rainbow"
        ? `いずれかのロボットを${shapeLabel}のマスへ`
        : `${COLOR_INFO[currentGoal.color].label}ロボットを${shapeLabel}のマスへ`;

    placeGoalRing(currentGoal.r, currentGoal.c);
    refreshTargetEmphasis();

    btnCheck.disabled = false;
    updateMoveCount();
    updateUndoRedoButtons();
    setStatus("新しい目標が現れました。ロボットをクリックして動かしてみましょう。", "");

    startSolverForGoal(currentGoal);
  }

  function shuffleArrayLocal(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- new map / init ----------
  function placeRobotsRandomly() {
    const targetCells = new Set(board.targets.map((t) => `${t.r},${t.c}`));
    const placed = [];
    for (let i = 0; i < ACTIVE_COLORS.length; i++) {
      let r, c, key;
      do {
        r = randInt(SIZE);
        c = randInt(SIZE);
        key = `${r},${c}`;
      } while (
        board.blocked.has(key) ||
        targetCells.has(key) ||
        (board.diagonals && board.diagonals.has(key)) ||
        placed.some((p) => p.r === r && p.c === c)
      );
      placed.push({ r, c });
    }
    return placed;
  }

  function newMap() {
    if (checkPollTimer) {
      clearInterval(checkPollTimer);
      checkPollTimer = null;
    }
    solverStatus = "idle";
    locked = false;
    selectedRobot = null;

    board = generateBoard({ useDiagonals: USE_DIAGONALS, colors: ACTIVE_COLORS });
    robots = placeRobotsRandomly();
    targetQueue = shuffleArrayLocal(board.targets);
    goalIndex = -1;

    renderBoardStatic();
    renderRobots();
    nextGoal();
  }

  // ---------- wire up buttons ----------
  btnNewMap.addEventListener("click", () => {
    if (window.__HR_ONLINE_ACTIVE) return; // オンライン対戦中はこのハンドラを無効化する（multiplayer.js側で処理）
    if (locked) return;
    newMap();
  });
  if (btnBackTitle) {
    btnBackTitle.addEventListener("click", () => {
      const overlay = document.getElementById("title-screen");
      if (overlay) {
        overlay.classList.remove("hidden");
        document.body.classList.add("title-active");
      }
      // オンライン対戦中にタイトルへ戻る場合は、ルームからきちんと退出しておく
      if (window.__HR_ONLINE_ACTIVE) {
        window.__HR_ONLINE_ACTIVE = false;
        if (typeof window.stopOnlineGame === "function") window.stopOnlineGame();
        if (typeof window.HROnline === "object" && typeof window.HROnline.leaveRoom === "function") {
          window.HROnline.leaveRoom();
        }
        const onlineControls = document.getElementById("online-controls");
        const onlineHud = document.getElementById("online-hud");
        const soloControls = document.getElementById("solo-controls");
        if (onlineControls) onlineControls.classList.add("hidden");
        if (onlineHud) onlineHud.classList.add("hidden");
        if (soloControls) soloControls.classList.remove("hidden");
        const newMapBtn = document.getElementById("btn-new-map");
        if (newMapBtn) newMapBtn.classList.remove("hidden");
      }
      window.dispatchEvent(new CustomEvent("hr-return-to-title"));
    });
  }
  btnUndo.addEventListener("click", undoMove);
  btnRedo.addEventListener("click", redoMove);
  btnReset.addEventListener("click", resetRound);
  btnCheck.addEventListener("click", onCheckClick);
  btnNext.addEventListener("click", () => {
    if (locked) return;
    nextGoal();
  });

  // ---------- boot ----------
  // タイトル画面（title.js）の「ゲームをはじめる」ボタンから呼び出される。
  // mode: "four"（デフォルト）または "five"（黒ロボットを追加）
  // useDiagonals: true の場合、斜め壁（任意設定）を有効にする
  window.startHyperRobotsGame = function (mode, useDiagonals) {
    // オンライン対戦から遷移してきた場合に備えて、オンライン専用の
    // 画面状態・進行中のタイマーなどを確実にリセットしておく
    window.__HR_ONLINE_ACTIVE = false;
    if (typeof window.stopOnlineGame === "function") window.stopOnlineGame();
    const soloControls = document.getElementById("solo-controls");
    const onlineControls = document.getElementById("online-controls");
    const onlineHud = document.getElementById("online-hud");
    if (soloControls) soloControls.classList.remove("hidden");
    if (onlineControls) onlineControls.classList.add("hidden");
    if (onlineHud) onlineHud.classList.add("hidden");
    const newMapBtn = document.getElementById("btn-new-map");
    if (newMapBtn) newMapBtn.classList.remove("hidden");

    ACTIVE_COLORS = mode === "five" ? COLOR_SETS.five : COLOR_SETS.four;
    USE_DIAGONALS = !!useDiagonals;
    const colorModeBadge = document.getElementById("color-mode-badge");
    if (colorModeBadge) {
      colorModeBadge.textContent = mode === "five" ? "5色モード" : "4色モード";
    }
    const diagonalBadge = document.getElementById("diagonal-mode-badge");
    if (diagonalBadge) {
      diagonalBadge.style.display = USE_DIAGONALS ? "" : "none";
    }
    newMap();
  };
})();
