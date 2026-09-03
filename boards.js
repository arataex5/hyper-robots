/*
 * boards.js — 構成ファイル（設定データ）
 * ------------------------------------------------------------
 * ハイパーロボットの盤面を組み立てるための「部品」を定義します。
 * 本家と同様に、8x8の区画（クアドラント）を4枚組み合わせて
 * 16x16の盤面を作ります。新しい盤面を作るたびに、4つの角それぞれに
 * ランダムな区画とランダムな回転（0/90/180/270度）が選ばれます。
 *
 * walls:   { r, c, dir } … ローカル座標 (0-7,0-7) のマス (r,c) の
 *          dir 側の辺に壁を1枚設置する。dir は 'N'/'S'/'E'/'W'。
 * targets: { r, c, color, shape } … そのマスに目標チップを1つ置く。
 * rainbowSlot: { r, c, walls: [dir, dir] } … 「レインボー」ゴール用の
 *          予備の設置場所。4つの区画のうち毎回ランダムに1つだけが
 *          実際に使われる（＝レインボーゴールも他のゴールと同じように
 *          盤面ごとに位置が変わる）。
 *
 * COLOR_SETS: 何色のロボットを使うか（4色モード／5色モード）。
 *          5色モードで加わる「黒」は専用の目標チップを持たない
 *          （＝盤面生成のルールは一切変えない）。黒ロボットは他の
 *          ロボットと同じように移動でき、壁代わりに使ったり、
 *          レインボーゴールを達成したりすることはできる。
 */

const COLOR_SETS = {
  four: ["red", "blue", "green", "yellow"],
  five: ["red", "blue", "green", "yellow", "black"],
};

const COLOR_INFO = {
  red: { label: "赤", cssVar: "--c-red", initial: "R" },
  blue: { label: "青", cssVar: "--c-blue", initial: "B" },
  green: { label: "緑", cssVar: "--c-green", initial: "G" },
  yellow: { label: "黄", cssVar: "--c-yellow", initial: "Y" },
  black: { label: "黒", cssVar: "--c-black", initial: "K" },
  rainbow: { label: "レインボー", cssVar: "--c-rainbow" },
};

const SHAPE_INFO = {
  circle: { label: "丸" },
  triangle: { label: "三角" },
  square: { label: "四角" },
  star: { label: "星" },
};

const BOARD_TEMPLATES = [
  // --- Template A ---
  {
    walls: [
      { r: 1, c: 2, dir: "S" }, { r: 1, c: 2, dir: "E" },
      { r: 3, c: 6, dir: "N" }, { r: 3, c: 6, dir: "W" },
      { r: 5, c: 1, dir: "S" }, { r: 5, c: 1, dir: "W" },
      { r: 6, c: 5, dir: "N" }, { r: 6, c: 5, dir: "E" },
    ],
    targets: [
      { r: 1, c: 2, color: "red", shape: "circle" },
      { r: 3, c: 6, color: "blue", shape: "triangle" },
      { r: 5, c: 1, color: "green", shape: "square" },
      { r: 6, c: 5, color: "yellow", shape: "star" },
    ],
    rainbowSlot: { r: 4, c: 4, walls: ["N", "W"] },
  },
  // --- Template B ---
  {
    walls: [
      { r: 2, c: 1, dir: "S" }, { r: 2, c: 1, dir: "W" },
      { r: 1, c: 5, dir: "S" }, { r: 1, c: 5, dir: "E" },
      { r: 6, c: 6, dir: "N" }, { r: 6, c: 6, dir: "W" },
      { r: 4, c: 3, dir: "N" }, { r: 4, c: 3, dir: "E" },
    ],
    targets: [
      { r: 2, c: 1, color: "blue", shape: "circle" },
      { r: 1, c: 5, color: "green", shape: "triangle" },
      { r: 6, c: 6, color: "yellow", shape: "square" },
      { r: 4, c: 3, color: "red", shape: "star" },
    ],
    rainbowSlot: { r: 5, c: 2, walls: ["N", "E"] },
  },
  // --- Template C ---
  {
    walls: [
      { r: 1, c: 1, dir: "S" }, { r: 1, c: 1, dir: "E" },
      { r: 2, c: 6, dir: "S" }, { r: 2, c: 6, dir: "W" },
      { r: 5, c: 4, dir: "N" }, { r: 5, c: 4, dir: "E" },
      { r: 6, c: 2, dir: "N" }, { r: 6, c: 2, dir: "W" },
    ],
    targets: [
      { r: 1, c: 1, color: "green", shape: "circle" },
      { r: 2, c: 6, color: "yellow", shape: "triangle" },
      { r: 5, c: 4, color: "red", shape: "square" },
      { r: 6, c: 2, color: "blue", shape: "star" },
    ],
    rainbowSlot: { r: 3, c: 5, walls: ["S", "W"] },
  },
  // --- Template D ---
  {
    walls: [
      { r: 1, c: 6, dir: "S" }, { r: 1, c: 6, dir: "W" },
      { r: 3, c: 3, dir: "S" }, { r: 3, c: 3, dir: "E" },
      { r: 5, c: 1, dir: "N" }, { r: 5, c: 1, dir: "W" },
      { r: 6, c: 2, dir: "N" }, { r: 6, c: 2, dir: "E" },
    ],
    targets: [
      { r: 1, c: 6, color: "yellow", shape: "circle" },
      { r: 3, c: 3, color: "red", shape: "triangle" },
      { r: 5, c: 1, color: "blue", shape: "square" },
      { r: 6, c: 2, color: "green", shape: "star" },
    ],
    rainbowSlot: { r: 4, c: 5, walls: ["N", "W"] },
  },
];
