/*
 * profile.js — プロフィール（プレイヤー名・アイコン）の構成ファイル
 * ------------------------------------------------------------
 * タイトル画面から編集できる「プレイヤー名」と「ロボット風アイコン」を
 * 管理します。アイコンは 頭・目・鼻・口・耳・アクセサリー の6パーツで
 * 構成され、各パーツごとに 15色 × 25種類（うち1種類は「なし」）から
 * 自由に選べます。
 *
 * 実装方針: 150種類（6パーツ×25種類）をすべて別々に描くのではなく、
 * 「24種類の共通シルエット＋なし」を1つのライブラリとして用意し、
 * どのパーツにも同じライブラリを使い回しています。パーツごとに置く
 * 場所・大きさだけを変えることで、組み合わせ数はそのままに実装量を
 * 抑えています。
 */

(function () {
  "use strict";

  const MAX_NAME_LENGTH = 7;
  const DEFAULT_NAME = "プレイヤー";

  // 16色パレット（全パーツ共通）。白を追加。
  const AVATAR_COLORS = [
    "#e2543f", "#e08a3f", "#e0b23f", "#a7c93f", "#4bb679",
    "#3fc9a0", "#3fc4c9", "#4c8fe0", "#6b7ae0", "#9a5fe0",
    "#cf5fe0", "#e05fa8", "#8a5a3f", "#6b7280", "#1c1f28",
    "#ffffff",
  ];

  // 30種類のシルエット（0番目は「なし」）。全パーツ共通ライブラリ。
  // shape:"none" は非表示、それ以外は avatar-shape-XX クラス（style.css側で
  // clip-path / border-radius を定義）に対応する。
  const AVATAR_SHAPES = [
    { id: "none", label: "なし" },
    { id: "circle", label: "まる" },
    { id: "square", label: "しかく" },
    { id: "rounded-square", label: "角丸しかく" },
    { id: "triangle", label: "さんかく" },
    { id: "triangle-inv", label: "逆さんかく" },
    { id: "diamond", label: "ひし形" },
    { id: "pentagon", label: "ごかく形" },
    { id: "hexagon", label: "ろっかく形" },
    { id: "star5", label: "星(5)" },
    { id: "star4", label: "星(4)" },
    { id: "heart", label: "ハート" },
    { id: "arch-top", label: "半円(上)" },
    { id: "arch-bottom", label: "半円(下)" },
    { id: "leaf", label: "葉っぱ" },
    { id: "leaf2", label: "葉っぱ2" },
    { id: "teardrop", label: "しずく" },
    { id: "teardrop2", label: "しずく2" },
    { id: "cross", label: "十字" },
    { id: "bolt", label: "いなずま" },
    { id: "trapezoid", label: "台形" },
    { id: "trapezoid-inv", label: "逆台形" },
    { id: "parallelogram", label: "平行四辺形" },
    { id: "octagon", label: "はっかく形" },
    { id: "oval", label: "たまご形" },
    { id: "cat-mouth", label: "ねこ口" },
    { id: "dog-mouth", label: "いぬ口" },
    { id: "bar", label: "横棒" },
    { id: "smile-line", label: "上向き曲線" },
    { id: "frown-line", label: "下向き曲線" },
  ];

  const PART_DEFS = [
    { key: "background", label: "背景", colorOnly: true },
    { key: "head", label: "頭" },
    { key: "eyes", label: "目" },
    { key: "nose", label: "鼻" },
    { key: "mouth", label: "口" },
    { key: "ears", label: "耳" },
    { key: "accessory", label: "アクセサリー" },
  ];

  function defaultProfile() {
    return {
      name: DEFAULT_NAME,
      parts: {
        background: { color: AVATAR_COLORS[13] },
        head: { shape: "rounded-square", color: AVATAR_COLORS[7] },
        eyes: { shape: "circle", color: AVATAR_COLORS[14] },
        nose: { shape: "triangle-inv", color: AVATAR_COLORS[13] },
        mouth: { shape: "arch-bottom", color: AVATAR_COLORS[14] },
        ears: { shape: "none", color: AVATAR_COLORS[7] },
        accessory: { shape: "none", color: AVATAR_COLORS[2] },
      },
    };
  }

  function cloneProfile(p) {
    return {
      name: p.name,
      parts: {
        background: { ...p.parts.background },
        head: { ...p.parts.head },
        eyes: { ...p.parts.eyes },
        nose: { ...p.parts.nose },
        mouth: { ...p.parts.mouth },
        ears: { ...p.parts.ears },
        accessory: { ...p.parts.accessory },
      },
    };
  }

  function sanitizeName(raw) {
    const trimmed = (raw || "").slice(0, MAX_NAME_LENGTH);
    return trimmed.length > 0 ? trimmed : DEFAULT_NAME;
  }

  function loadStoredProfile() {
    try {
      const raw = window.localStorage && window.localStorage.getItem("hr-profile");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.parts) return null;
      const merged = defaultProfile();
      merged.name = sanitizeName(parsed.name);
      PART_DEFS.forEach(({ key }) => {
        if (parsed.parts[key]) {
          merged.parts[key] = {
            shape: parsed.parts[key].shape || merged.parts[key].shape,
            color: parsed.parts[key].color || merged.parts[key].color,
          };
        }
      });
      return merged;
    } catch (e) {
      return null;
    }
  }

  function storeProfile(p) {
    try {
      if (window.localStorage) window.localStorage.setItem("hr-profile", JSON.stringify(p));
    } catch (e) {
      // ストレージが使えない環境でも、ゲーム自体は問題なく動く
    }
  }

  let currentProfile = loadStoredProfile() || defaultProfile();
  let editingProfile = null; // エディタ内でだけ触る作業用コピー
  let editingPart = "background";

  // ---------- アバターのプレビュー描画（タイトル要約・エディタ・ゲーム内バッジ共通） ----------
  function renderAvatar(container, profile) {
    if (!container) return;
    container.innerHTML = "";
    container.classList.add("avatar-face");

    // 背景色
    const bg = profile.parts.background ? profile.parts.background.color : "#10141f";
    container.style.background = bg;

    function makePiece(partKey, extraClass) {
      const part = profile.parts[partKey];
      if (!part || part.shape === "none") return null;
      const el = document.createElement("div");
      el.className = `avatar-piece avatar-${partKey} avatar-shape-${part.shape} ${extraClass || ""}`.trim();
      el.style.background = part.color;
      return el;
    }

    // 頭
    const head = makePiece("head");
    if (head) container.appendChild(head);

    // 耳（左右対称。左をそのまま、右は左右反転させて本当の鏡合わせにする）
    const earPart = profile.parts.ears;
    if (earPart && earPart.shape !== "none") {
      const earL = document.createElement("div");
      earL.className = `avatar-piece avatar-ears avatar-ears-left avatar-shape-${earPart.shape}`;
      earL.style.background = earPart.color;
      container.appendChild(earL);
      const earR = document.createElement("div");
      earR.className = `avatar-piece avatar-ears avatar-ears-right avatar-shape-${earPart.shape}`;
      earR.style.background = earPart.color;
      earR.style.transform = "scaleX(-1)";
      container.appendChild(earR);
    }

    // 目（左右対称。耳と同様、右目は左目を反転させたもの）
    const eyePart = profile.parts.eyes;
    if (eyePart && eyePart.shape !== "none") {
      const eyeL = document.createElement("div");
      eyeL.className = `avatar-piece avatar-eyes avatar-eyes-left avatar-shape-${eyePart.shape}`;
      eyeL.style.background = eyePart.color;
      container.appendChild(eyeL);
      const eyeR = document.createElement("div");
      eyeR.className = `avatar-piece avatar-eyes avatar-eyes-right avatar-shape-${eyePart.shape}`;
      eyeR.style.background = eyePart.color;
      eyeR.style.transform = "scaleX(-1)";
      container.appendChild(eyeR);
    }

    const nose = makePiece("nose");
    if (nose) container.appendChild(nose);

    const mouth = makePiece("mouth");
    if (mouth) container.appendChild(mouth);

    const accessory = makePiece("accessory");
    if (accessory) container.appendChild(accessory);
  }

  function renderAllPreviews() {
    // 現状では refreshSummary() が個別のIDへ直接描画しているため、
    // ここでは予備として data-avatar-preview を持つ要素があれば拾う。
    document.querySelectorAll("[data-avatar-preview]").forEach((el) => {
      renderAvatar(el, currentProfile);
    });
  }

  // ---------- タイトル画面の要約表示 ----------
  function refreshSummary() {
    const nameEl = document.getElementById("profile-summary-name");
    if (nameEl) nameEl.textContent = currentProfile.name;
    const avatarEl = document.getElementById("profile-summary-avatar");
    if (avatarEl) renderAvatar(avatarEl, currentProfile);
    // オンラインロビー画面にも同じ要約を表示する（2箇所目）
    const nameElOnline = document.getElementById("profile-summary-name-online");
    if (nameElOnline) nameElOnline.textContent = currentProfile.name;
    const avatarElOnline = document.getElementById("profile-summary-avatar-online");
    if (avatarElOnline) renderAvatar(avatarElOnline, currentProfile);
    const badgeAvatar = document.getElementById("player-badge-avatar");
    if (badgeAvatar) renderAvatar(badgeAvatar, currentProfile);
    const badgeName = document.getElementById("player-badge-name");
    if (badgeName) badgeName.textContent = currentProfile.name;
    renderAllPreviews();
  }

  // ---------- エディタ本体 ----------
  function buildColorSwatches() {
    const row = document.getElementById("color-swatch-row");
    if (!row) return;
    row.innerHTML = "";
    AVATAR_COLORS.forEach((color) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "color-swatch";
      sw.style.background = color;
      sw.setAttribute("aria-label", color);
      sw.addEventListener("click", () => {
        editingProfile.parts[editingPart].color = color;
        refreshEditorSelectionState();
        renderAvatar(document.getElementById("avatar-preview-large"), editingProfile);
      });
      row.appendChild(sw);
    });
  }

  function buildShapeGrid() {
    const grid = document.getElementById("shape-grid");
    if (!grid) return;
    grid.innerHTML = "";
    AVATAR_SHAPES.forEach((shapeDef) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "shape-cell";
      cell.setAttribute("aria-label", shapeDef.label);
      cell.title = shapeDef.label;
      if (shapeDef.id !== "none") {
        const swatch = document.createElement("div");
        swatch.className = `shape-cell-swatch avatar-shape-${shapeDef.id}`;
        cell.appendChild(swatch);
      } else {
        cell.classList.add("shape-cell-none");
        cell.textContent = "✕";
      }
      cell.addEventListener("click", () => {
        editingProfile.parts[editingPart].shape = shapeDef.id;
        refreshEditorSelectionState();
        renderAvatar(document.getElementById("avatar-preview-large"), editingProfile);
      });
      grid.appendChild(cell);
    });
  }

  function refreshEditorSelectionState() {
    const part = editingProfile.parts[editingPart];
    const def = PART_DEFS.find((p) => p.key === editingPart);
    const row = document.getElementById("color-swatch-row");
    if (row) {
      Array.from(row.children).forEach((sw, i) => {
        sw.classList.toggle("selected", AVATAR_COLORS[i] === part.color);
      });
    }
    const grid = document.getElementById("shape-grid");
    if (grid) {
      grid.style.display = def && def.colorOnly ? "none" : "";
      Array.from(grid.children).forEach((cell, i) => {
        cell.classList.toggle("selected", AVATAR_SHAPES[i].id === part.shape);
      });
    }
    const partLabel = document.getElementById("part-editor-label");
    if (partLabel) {
      partLabel.textContent = def ? def.label : "";
    }
  }

  function selectEditingPart(partKey) {
    editingPart = partKey;
    document.querySelectorAll(".part-tab").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.part === partKey);
    });
    refreshEditorSelectionState();
  }

  function openEditor() {
    editingProfile = cloneProfile(currentProfile);
    const overlay = document.getElementById("profile-editor-overlay");
    const nameInput = document.getElementById("profile-name-input");
    if (nameInput) nameInput.value = editingProfile.name;
    if (overlay) overlay.classList.remove("hidden");
    selectEditingPart(editingPart);
    renderAvatar(document.getElementById("avatar-preview-large"), editingProfile);
  }

  function closeEditor(save) {
    if (save) {
      const nameInput = document.getElementById("profile-name-input");
      editingProfile.name = sanitizeName(nameInput ? nameInput.value : editingProfile.name);
      currentProfile = editingProfile;
      storeProfile(currentProfile);
      refreshSummary();
    }
    editingProfile = null;
    const overlay = document.getElementById("profile-editor-overlay");
    if (overlay) overlay.classList.add("hidden");
  }

  function initProfileUI() {
    buildColorSwatches();
    buildShapeGrid();
    refreshSummary();

    const editBtn = document.getElementById("profile-edit-btn");
    if (editBtn) editBtn.addEventListener("click", openEditor);
    const editBtnOnline = document.getElementById("profile-edit-btn-online");
    if (editBtnOnline) editBtnOnline.addEventListener("click", openEditor);

    document.querySelectorAll(".part-tab").forEach((btn) => {
      btn.addEventListener("click", () => selectEditingPart(btn.dataset.part));
    });

    const nameInput = document.getElementById("profile-name-input");
    if (nameInput) {
      nameInput.setAttribute("maxlength", String(MAX_NAME_LENGTH));
      nameInput.addEventListener("input", () => {
        if (nameInput.value.length > MAX_NAME_LENGTH) {
          nameInput.value = nameInput.value.slice(0, MAX_NAME_LENGTH);
        }
      });
    }

    const saveBtn = document.getElementById("profile-save-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => closeEditor(true));
    const cancelBtn = document.getElementById("profile-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", () => closeEditor(false));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initProfileUI);
  } else {
    initProfileUI();
  }

  // ゲーム側（game.js）から現在のプロフィールを読めるようにしておく。
  window.getPlayerProfile = function () {
    return cloneProfile(currentProfile);
  };
  // オンライン対戦のプレイヤー一覧など、他のプロフィールを描画したい
  // 箇所（online.js）から呼べるようにしておく。
  window.renderProfileAvatar = function (container, profile) {
    renderAvatar(container, profile || defaultProfile());
  };
})();
