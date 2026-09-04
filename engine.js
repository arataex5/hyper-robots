/*
 * engine.js — 盤面生成・移動判定・最短手数の探索エンジン
 * ------------------------------------------------------------
 * boards.js の区画データ（BOARD_TEMPLATES）を組み合わせて16x16の
 * 盤面を作り、壁の当たり判定・ロボットのスライド移動・コンピュータの
 * 最短手数探索（BFS）を提供します。UI（game.js）からのみ呼び出されます。
 */

const SIZE = 16;
const COLORS = ["red", "blue", "green", "yellow"];
const SHAPES = ["circle", "triangle", "square", "star"];
const DIRS = {
  N: { dr: -1, dc: 0 },
  S: { dr: 1, dc: 0 },
  E: { dr: 0, dc: 1 },
  W: { dr: 0, dc: -1 },
};
const DIR_ROT_CW = { N: "E", E: "S", S: "W", W: "N" };

// ゴールの位置を示す矢印＋「ここ」ラベルを、盤面からはみ出さない向きに
// 配置するための計算。r,c から見て一番余裕のある方向（上下左右のうち
// 空きマスが一番多い側）にラベル側を置き、矢印はゴールのマスを指す形に
// する。返り値はパーセンテージ単位（盤面基準）の配置情報。
// game.js（ソロ）・multiplayer.js（オンライン）の両方から呼ばれる共通処理。
function computeGoalIndicatorPlacement(r, c) {
  const topClear = r;
  const bottomClear = SIZE - 1 - r;
  const leftClear = c;
  const rightClear = SIZE - 1 - c;
  const maxClear = Math.max(topClear, bottomClear, leftClear, rightClear);

  let dir;
  if (maxClear === topClear) dir = "down"; // 矢印はゴールの上に置き、下向きに指す
  else if (maxClear === bottomClear) dir = "up";
  else if (maxClear === leftClear) dir = "right";
  else dir = "left";

  const cell = 100 / SIZE;
  const length = cell * 1.5; // 矢印+文字の、指す方向に沿った長さ
  const thickness = cell * 0.55; // 指す方向と垂直な太さ
  const cellLeft = c * cell;
  const cellTop = r * cell;

  let left, top, width, height;
  if (dir === "down") {
    width = thickness;
    height = length;
    left = cellLeft + cell / 2 - width / 2;
    top = cellTop - height;
  } else if (dir === "up") {
    width = thickness;
    height = length;
    left = cellLeft + cell / 2 - width / 2;
    top = cellTop + cell;
  } else if (dir === "right") {
    width = length;
    height = thickness;
    left = cellLeft - width;
    top = cellTop + cell / 2 - height / 2;
  } else {
    width = length;
    height = thickness;
    left = cellLeft + cell;
    top = cellTop + cell / 2 - height / 2;
  }
  return { dir, left, top, width, height };
}

function rotateDir(dir, k) {
  let d = dir;
  for (let i = 0; i < k; i++) d = DIR_ROT_CW[d];
  return d;
}

// 8x8ローカル座標を時計回りに k*90度 回転させる
function rotateCell(r, c, k) {
  let rr = r;
  let cc = c;
  for (let i = 0; i < k; i++) {
    const nr = cc;
    const nc = 7 - rr;
    rr = nr;
    cc = nc;
  }
  return [rr, cc];
}

const CORNERS = [
  { key: "TL", rowOff: 0, colOff: 0 },
  { key: "TR", rowOff: 0, colOff: 8 },
  { key: "BR", rowOff: 8, colOff: 8 },
  { key: "BL", rowOff: 8, colOff: 0 },
];

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// hWalls: `${r},${c}` = セル(r,c)の北側の辺に壁がある
// vWalls: `${r},${c}` = セル(r,c)の西側の辺に壁がある
function addWall(hWalls, vWalls, r, c, dir) {
  if (r < 0 || r > 15 || c < 0 || c > 15) return;
  if (dir === "N") hWalls.add(`${r},${c}`);
  else if (dir === "S") hWalls.add(`${r + 1},${c}`);
  else if (dir === "W") vWalls.add(`${r},${c}`);
  else if (dir === "E") vWalls.add(`${r},${c + 1}`);
}

// 盤面の中央(2x2)を「コア」として塞ぐための固定壁の位置。
const CORE_CELLS = [[7, 7], [7, 8], [8, 7], [8, 8]];

// 各区画の外周（盤面の外枠と接する辺）に設置する短い壁（ノッチ）の設定。
// 8マスの区画のどの位置に置くかを、以下の内訳でランダムに割り当てる：
//   中央付近（3・4）        … 8本中3本
//   端から1マス空けた（1・6） … 8本中1本
//   端から2マス空けた（2・5） … 8本中4本
// 1つの区画が持つ2本のノッチ（横の辺・縦の辺）が同じ位置になると、
// コーナーを中心に左右対称な「四角形」っぽい配置になってしまうため、
// その場合はどちらかをカテゴリ内の別の値にずらして非対称にする。
//
// 「端から1マス空けた」ノッチは、盤面の実際の四隅（右上・右下・左下・左上の
// 角そのもの）のすぐ近くには置かないようにする。8つの設置場所（各コーナーの
// 上下左右の辺）ごとに、値1と値6のどちらが「盤面の角に近い側」かが異なる
// （ローカル座標の基準がコーナーごとに変わるため）ので、near/far として
// 明示しておき、gap1が選ばれた場合は必ず far 側の値を使う。
const NOTCH_CATEGORY_VALUES = {
  center: [3, 4],
  gap1: [1, 6],
  gap2: [2, 5],
};
const NOTCH_CATEGORY_POOL = [
  "center", "center", "center",
  "gap1",
  "gap2", "gap2", "gap2", "gap2",
];

// near: 盤面の実際の角に近い側の値／far: 角から離れた側（中央寄り）の値
const NOTCH_SLOTS = [
  { key: "TL-top", build: (v) => [0, v, "E"], near: 1, far: 6 },
  { key: "TL-left", build: (v) => [v, 0, "S"], near: 1, far: 6 },
  { key: "TR-top", build: (v) => [0, 8 + v, "E"], near: 6, far: 1 },
  { key: "TR-right", build: (v) => [v, 15, "S"], near: 1, far: 6 },
  { key: "BR-bottom", build: (v) => [15, 8 + v, "E"], near: 6, far: 1 },
  { key: "BR-right", build: (v) => [8 + v, 15, "S"], near: 6, far: 1 },
  { key: "BL-bottom", build: (v) => [15, v, "E"], near: 1, far: 6 },
  { key: "BL-left", build: (v) => [8 + v, 0, "S"], near: 6, far: 1 },
];

function pickNotchValue(category, slot) {
  if (category === "gap1") return slot.far; // 角に近い側(near)は使わない
  const values = NOTCH_CATEGORY_VALUES[category];
  return values[randInt(values.length)];
}

// 2本セット（1コーナー分）の位置を決める。同じカテゴリになった場合は
// カテゴリ内の異なる2値をそれぞれに割り当てて重複を避ける。
function pickNotchPairValues(catA, slotA, catB, slotB) {
  const a = pickNotchValue(catA, slotA);
  let b;
  if (catA === catB && catA !== "gap1") {
    const values = NOTCH_CATEGORY_VALUES[catA];
    b = values.find((v) => v !== a);
    if (b === undefined) b = pickNotchValue(catB, slotB);
  } else {
    b = pickNotchValue(catB, slotB);
  }
  return [a, b];
}

function buildOuterNotchDefs() {
  const pool = shuffle(NOTCH_CATEGORY_POOL); // 8本ぶんのカテゴリをシャッフルして配分
  const defs = [];
  for (let i = 0; i < 4; i++) {
    const slotA = NOTCH_SLOTS[i * 2];
    const slotB = NOTCH_SLOTS[i * 2 + 1];
    const catA = pool[i * 2];
    const catB = pool[i * 2 + 1];
    const [vA, vB] = pickNotchPairValues(catA, slotA, catB, slotB);
    defs.push(slotA.build(vA), slotB.build(vB));
  }
  return defs;
}

// 縦・横それぞれの1列に置いてよいゴールの最大数（本家同様、偏りすぎを防ぐ）
const MAX_TARGETS_PER_LINE = 2;

// 1回分の盤面候補を組み立てる。壁ごとに「どのグループ（L字1組・ノッチ1本・
// コア全体）に属するか」を記録し、異なるグループの壁が同じ格子点で
// 接してしまっていないかを最後にチェックできるようにする。
function buildCandidateBoard() {
  const hWalls = new Set();
  const vWalls = new Set();
  const targets = [];
  const vertexGroups = new Map(); // "i,j" -> Set<groupId>
  const lCorners = []; // { r, c, dirs: [dir,dir] } for the 形チェック（意図して作ったL字のみ）

  function touchVertex(i, j, groupId) {
    const key = `${i},${j}`;
    let set = vertexGroups.get(key);
    if (!set) {
      set = new Set();
      vertexGroups.set(key, set);
    }
    set.add(groupId);
  }

  function addWallG(r, c, dir, groupId) {
    if (r < 0 || r > 15 || c < 0 || c > 15) return;
    addWall(hWalls, vWalls, r, c, dir);
    if (dir === "N") { touchVertex(r, c, groupId); touchVertex(r, c + 1, groupId); }
    else if (dir === "S") { touchVertex(r + 1, c, groupId); touchVertex(r + 1, c + 1, groupId); }
    else if (dir === "W") { touchVertex(r, c, groupId); touchVertex(r + 1, c, groupId); }
    else if (dir === "E") { touchVertex(r, c + 1, groupId); touchVertex(r + 1, c + 1, groupId); }
  }

  // 2方向の壁を一度に登録し、意図して作られたL字コーナーとして記録する。
  function addLCornerG(r, c, dirA, dirB, groupIdPrefix) {
    addWallG(r, c, dirA, `${groupIdPrefix}`);
    addWallG(r, c, dirB, `${groupIdPrefix}`);
    lCorners.push({ r, c, dirs: [dirA, dirB] });
  }

  const templatePool = shuffle(BOARD_TEMPLATES);
  // どの区画に「レインボー」ゴールを持たせるかを毎回ランダムに選ぶ。
  // ＝レインボーゴールも他のゴールと同じく、盤面ごとに位置が変わる。
  const rainbowCornerIndex = randInt(4);

  CORNERS.forEach((corner, ci) => {
    const tpl = templatePool[ci % templatePool.length];
    const k = randInt(4);

    tpl.targets.forEach((t) => {
      const [lr, lc] = rotateCell(t.r, t.c, k);
      targets.push({
        r: lr + corner.rowOff,
        c: lc + corner.colOff,
        color: t.color,
        shape: t.shape,
      });
    });

    // テンプレート内の壁は「同じローカル座標(r,c)」ごとに1組のL字として
    // まとまっている（ターゲット1個につき2辺）。そのペアをグループ化する。
    const wallsByCell = new Map();
    tpl.walls.forEach((w) => {
      const key = `${w.r},${w.c}`;
      if (!wallsByCell.has(key)) wallsByCell.set(key, []);
      wallsByCell.get(key).push(w);
    });
    let li = 0;
    wallsByCell.forEach((wallList) => {
      const groupId = `${corner.key}-L${li++}`;
      const rotated = wallList.map((w) => {
        const [lr, lc] = rotateCell(w.r, w.c, k);
        return { r: lr + corner.rowOff, c: lc + corner.colOff, dir: rotateDir(w.dir, k) };
      });
      rotated.forEach((w) => addWallG(w.r, w.c, w.dir, groupId));
      if (rotated.length === 2 && rotated[0].r === rotated[1].r && rotated[0].c === rotated[1].c) {
        lCorners.push({ r: rotated[0].r, c: rotated[0].c, dirs: [rotated[0].dir, rotated[1].dir] });
      }
    });

    if (ci === rainbowCornerIndex && tpl.rainbowSlot) {
      const slot = tpl.rainbowSlot;
      const [lr, lc] = rotateCell(slot.r, slot.c, k);
      const gr = lr + corner.rowOff;
      const gc = lc + corner.colOff;
      targets.push({ r: gr, c: gc, color: "rainbow", shape: "circle" });
      const groupId = `${corner.key}-rainbow`;
      const rDirs = slot.walls.map((dir) => rotateDir(dir, k));
      rDirs.forEach((ldir) => addWallG(gr, gc, ldir, groupId));
      if (rDirs.length === 2) lCorners.push({ r: gr, c: gc, dirs: rDirs });
    }
  });

  // 中央2x2の「コア」。内部で壁同士が接するのは問題ないので、
  // まとめて1つのグループとして扱う（＝コア自身との整合性は常にOK）。
  // ※ コア自体はこの形チェックの対象外（lCornersには入れない）。
  const blocked = new Set(CORE_CELLS.map(([r, c]) => `${r},${c}`));
  CORE_CELLS.forEach(([r, c]) => {
    ["N", "S", "E", "W"].forEach((dir) => addWallG(r, c, dir, "core"));
  });

  // 各区画の外周付近のノッチ（中央寄りだが毎回位置が変わる）。1本ずつ完全に
  // 独立したグループとする。外枠に接しているため、外枠の暗黙の壁と合わせて
  // 実質的に2方向のL字コーナーとして扱う（形チェックの対象に含める）。
  buildOuterNotchDefs().forEach(([r, c, dir], idx) => {
    addWallG(r, c, dir, `notch${idx}`);
    const impliedEdgeDir = r === 0 ? "N" : r === 15 ? "S" : c === 0 ? "W" : "E";
    lCorners.push({ r, c, dirs: [dir, impliedEdgeDir] });
  });

  // 検証1: どの格子点でも「異なるグループ」が同時に接していないこと。
  // （同一グループ内でのL字や、コア自身の内部構造は問題なし）
  let valid = true;
  for (const groupSet of vertexGroups.values()) {
    if (groupSet.size > 1) {
      valid = false;
      break;
    }
  }

  // 検証2: 縦・横それぞれの1列に並ぶゴールの数が偏りすぎていないこと。
  if (valid) {
    const rowCounts = new Map();
    const colCounts = new Map();
    for (const t of targets) {
      rowCounts.set(t.r, (rowCounts.get(t.r) || 0) + 1);
      colCounts.set(t.c, (colCounts.get(t.c) || 0) + 1);
    }
    for (const n of rowCounts.values()) {
      if (n > MAX_TARGETS_PER_LINE) { valid = false; break; }
    }
    if (valid) {
      for (const n of colCounts.values()) {
        if (n > MAX_TARGETS_PER_LINE) { valid = false; break; }
      }
    }
  }

  // 検証3: 同じ行・同じ列の軸上（外枠のノッチも含む）にある意図的なL字
  // コーナー同士が、距離に関係なく「コの字／Cの字／冠／受け皿」の向きに
  // なっていないこと。
  if (valid) {
    const boxes = findAxisShapeViolations(lCorners);
    if (boxes.length > 0) valid = false;
  }

  return { valid, hWalls, vWalls, blocked, targets };
}

// 「コの字／Cの字／冠の形／受け皿の形」判定 ---------------------------------
// 同じ行（横方向）または同じ列（縦方向）の軸上にある2つの「意図して
// 作られたL字コーナー」（ターゲットのL字・レインボーのL字・外枠に接する
// ノッチ＋外枠の暗黙の壁）が、距離に関係なく【冠】【受け皿】【コ】【C】
// いずれかの向きの組み合わせになっていないかを調べる。
// lCorners: buildCandidateBoard 側で意図的に作られたコーナーだけを集めた
// リスト（{ r, c, dirs: [dir, dir] } の配列）。単一の壁を隣のマスから見た
// ときの「もう片側」のような、意図しない組み合わせを誤検出しないよう、
// 生の壁データを再スキャンするのではなくこのリストを直接使う。
function findAxisShapeViolations(lCorners) {
  const violations = [];

  // 横方向の軸（同じ行）: 【冠】(N,N) と 【受け皿】(S,S)
  const byRow = new Map();
  lCorners.forEach((corner) => {
    if (!byRow.has(corner.r)) byRow.set(corner.r, []);
    byRow.get(corner.r).push(corner);
  });
  byRow.forEach((list, r) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const left = list[i].c < list[j].c ? list[i] : list[j];
        const right = list[i].c < list[j].c ? list[j] : list[i];
        if (left.c === right.c) continue;
        if (!left.dirs.includes("E") || !right.dirs.includes("W")) continue;
        const vDir = ["N", "S"].find((d) => left.dirs.includes(d) && right.dirs.includes(d));
        if (vDir) {
          violations.push({
            shape: vDir === "N" ? "冠" : "受け皿",
            axis: "row", r, cLeft: left.c, cRight: right.c,
          });
        }
      }
    }
  });

  // 縦方向の軸（同じ列）: 【コ】(E,E) と 【C】(W,W)
  const byCol = new Map();
  lCorners.forEach((corner) => {
    if (!byCol.has(corner.c)) byCol.set(corner.c, []);
    byCol.get(corner.c).push(corner);
  });
  byCol.forEach((list, c) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const top = list[i].r < list[j].r ? list[i] : list[j];
        const bottom = list[i].r < list[j].r ? list[j] : list[i];
        if (top.r === bottom.r) continue;
        if (!top.dirs.includes("N") || !bottom.dirs.includes("S")) continue;
        const hDir = ["E", "W"].find((d) => top.dirs.includes(d) && bottom.dirs.includes(d));
        if (hDir) {
          violations.push({
            shape: hDir === "E" ? "コ" : "C",
            axis: "col", c, rTop: top.r, rBottom: bottom.r,
          });
        }
      }
    }
  });

  return violations;
}

// 斜め壁（ミラー） --------------------------------------------------------
// 外周に隣接しない範囲（各区画のローカル座標2〜5）にランダムに配置する。
const DIAGONAL_LOCAL_RANGE = [2, 3, 4, 5];

function generateDiagonals(targets, colorPalette) {
  const diagonals = new Map(); // "r,c" -> {orientation, color}
  const occupiedCells = new Set(targets.map((t) => `${t.r},${t.c}`));
  const globalUsage = new Map(); // color -> 使用回数

  CORNERS.forEach((corner) => {
    // 1つの8×8区画あたり1個か2個（2個の方を多めにする）
    const count = randInt(100) < 25 ? 1 : 2;
    const usedInQuadrant = new Set();

    for (let n = 0; n < count; n++) {
      const candidateColors = colorPalette.filter(
        (c) => !usedInQuadrant.has(c) && (globalUsage.get(c) || 0) < 2
      );
      if (candidateColors.length === 0) break; // これ以上使える色が無い

      for (let tries = 0; tries < 40; tries++) {
        const lr = DIAGONAL_LOCAL_RANGE[randInt(DIAGONAL_LOCAL_RANGE.length)];
        const lc = DIAGONAL_LOCAL_RANGE[randInt(DIAGONAL_LOCAL_RANGE.length)];
        const r = lr + corner.rowOff;
        const c = lc + corner.colOff;
        const key = `${r},${c}`;
        if (occupiedCells.has(key)) continue;

        const color = candidateColors[randInt(candidateColors.length)];
        const orientation = randInt(2) === 0 ? "/" : "\\";
        diagonals.set(key, { orientation, color, r, c });
        occupiedCells.add(key);
        usedInQuadrant.add(color);
        globalUsage.set(color, (globalUsage.get(color) || 0) + 1);
        break;
      }
    }
  });

  return diagonals;
}

// options: { useDiagonals: boolean, colors: string[] } — colors は斜め壁に
// 使ってよい色のパレット（4色/5色モードに応じて呼び出し側が渡す）。
// テスト等、同期的な呼び出しで問題ない場面向け。時間の許す限り（最大
// GENERATE_TIME_BUDGET_MS）リトライし続け、有効な盤面を探す。
const GENERATE_TIME_BUDGET_MS = 5000;

function finalizeBoard(candidate, opts) {
  const diagonals = opts.useDiagonals
    ? generateDiagonals(candidate.targets, opts.colors || COLORS)
    : new Map();
  return {
    hWalls: candidate.hWalls,
    vWalls: candidate.vWalls,
    blocked: candidate.blocked,
    targets: candidate.targets,
    diagonals,
  };
}

function generateBoard(options) {
  const opts = options || {};
  const deadline = Date.now() + GENERATE_TIME_BUDGET_MS;
  let candidate = buildCandidateBoard();
  while (!candidate.valid && Date.now() < deadline) {
    candidate = buildCandidateBoard();
  }
  return finalizeBoard(candidate, opts);
}

// UIをフリーズさせずに盤面生成するための、中断・再開可能なバージョン。
// IncrementalSolverと同じ考え方で、step(budgetMs)を setTimeout 越しに
// 繰り返し呼び出すことで、ブラウザに描画の機会を与えながら探索を進める。
// 「マップ生成中」の表示を出している間にこれを使う。
function createIncrementalBoardGenerator(options) {
  const opts = options || {};
  const deadline = Date.now() + GENERATE_TIME_BUDGET_MS;
  let done = false;
  let result = null;
  return {
    step(budgetMs) {
      if (done) return { status: "done", board: result };
      const stepDeadline = Date.now() + (budgetMs || 20);
      let candidate = buildCandidateBoard();
      while (!candidate.valid && Date.now() < stepDeadline && Date.now() < deadline) {
        candidate = buildCandidateBoard();
      }
      if (candidate.valid || Date.now() >= deadline) {
        done = true;
        result = finalizeBoard(candidate, opts);
        return { status: "done", board: result };
      }
      return { status: "continue" };
    },
  };
}

function isBlockedCrossing(board, r, c, dir) {
  const { dr, dc } = DIRS[dir];
  const nr = r + dr;
  const nc = c + dc;
  if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) return true;
  if (dir === "N" && board.hWalls.has(`${r},${c}`)) return true;
  if (dir === "S" && board.hWalls.has(`${nr},${nc}`)) return true;
  if (dir === "W" && board.vWalls.has(`${r},${c}`)) return true;
  if (dir === "E" && board.vWalls.has(`${nr},${nc}`)) return true;
  if (board.blocked.has(`${nr},${nc}`)) return true;
  return false;
}

function occupiedBy(robots, r, c, excludeIdx) {
  for (let i = 0; i < robots.length; i++) {
    if (i === excludeIdx) continue;
    if (robots[i].r === r && robots[i].c === c) return i;
  }
  return -1;
}

// 斜め壁（ミラー）に当たったときの方向転換テーブル。
// "/" は N<->E, S<->W を入れ替え、"\\" は N<->W, S<->E を入れ替える
// （鏡に反射するのと同じ考え方）。
const DIAGONAL_DEFLECT = {
  "/": { N: "E", E: "N", S: "W", W: "S" },
  "\\": { N: "W", W: "N", S: "E", E: "S" },
};

// myColor: 動かしているロボット自身の色。斜め壁と同じ色なら素通りする。
// 戻り値の bends は、斜め壁で方向転換した地点の一覧（アニメーション用）。
function slide(board, robots, idx, dir, myColor) {
  let { r, c } = robots[idx];
  let curDir = dir;
  const bends = [];
  while (true) {
    if (isBlockedCrossing(board, r, c, curDir)) break;
    const { dr, dc } = DIRS[curDir];
    const nr = r + dr;
    const nc = c + dc;
    if (occupiedBy(robots, nr, nc, idx) !== -1) break;
    r = nr;
    c = nc;
    if (board.diagonals) {
      const diag = board.diagonals.get(`${r},${c}`);
      if (diag && diag.color !== myColor) {
        curDir = DIAGONAL_DEFLECT[diag.orientation][curDir];
        bends.push({ r, c });
      }
    }
  }
  return { r, c, bends };
}

function canMoveAtAll(board, robots, idx, dir, myColor) {
  const dest = slide(board, robots, idx, dir, myColor);
  return dest.r !== robots[idx].r || dest.c !== robots[idx].c;
}

function stateKey(robots) {
  return robots.map((p) => p.r * 16 + p.c).join("|");
}

// 中断・再開が可能なBFS探索器。ブラウザのUIをフリーズさせないよう、
// step(budgetMs) を少しずつ何度も呼び出して探索を進める。
class IncrementalSolver {
  // targetIdx: a robot index (0-3) to move onto the goal, or the string
  // "any" for a "rainbow" goal that any robot may satisfy.
  // colors: 各ロボットの色（robots配列と同じ並び）。斜め壁の判定に使う。
  constructor(board, initialRobots, targetIdx, goalR, goalC, colors) {
    this.board = board;
    this.targetIdx = targetIdx;
    this.goalR = goalR;
    this.goalC = goalC;
    this.colors = colors || [];
    this.visited = new Set([stateKey(initialRobots)]);
    this.currentLayer = [{ robots: initialRobots, path: [] }];
    this.currentIndex = 0;
    this.nextLayer = [];
    this.depth = 0;
    this.done = false;
    this.result = null;
    const alreadyThere =
      targetIdx === "any"
        ? initialRobots.some((p) => p.r === goalR && p.c === goalC)
        : initialRobots[targetIdx].r === goalR && initialRobots[targetIdx].c === goalC;
    if (alreadyThere) {
      this.done = true;
      this.result = [];
    }
  }

  step(budgetMs) {
    if (this.done) {
      return this.result !== null ? { status: "found", path: this.result } : { status: "not_found" };
    }
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (this.currentIndex >= this.currentLayer.length) {
        if (this.nextLayer.length === 0) {
          this.done = true;
          return { status: "not_found" };
        }
        this.currentLayer = this.nextLayer;
        this.nextLayer = [];
        this.currentIndex = 0;
        this.depth++;
        if (this.depth > 20) {
          this.done = true;
          return { status: "not_found" };
        }
        continue;
      }
      const node = this.currentLayer[this.currentIndex++];
      for (let ri = 0; ri < node.robots.length; ri++) {
        for (const dir of ["N", "S", "E", "W"]) {
          const dest = slide(this.board, node.robots, ri, dir, this.colors[ri]);
          if (dest.r === node.robots[ri].r && dest.c === node.robots[ri].c) continue;
          const newRobots = node.robots.slice();
          newRobots[ri] = dest;
          const key = stateKey(newRobots);
          if (this.visited.has(key)) continue;
          this.visited.add(key);
          const path = node.path.concat([{ robot: ri, dir, to: dest, bends: dest.bends }]);
          const isTargetRobot = this.targetIdx === "any" || ri === this.targetIdx;
          if (isTargetRobot && dest.r === this.goalR && dest.c === this.goalC) {
            this.done = true;
            this.result = path;
            return { status: "found", path };
          }
          this.nextLayer.push({ robots: newRobots, path });
        }
      }
    }
    return { status: "continue" };
  }
}
