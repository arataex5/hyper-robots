/*
 * network.js — オンライン対戦のための P2P 通信レイヤー
 * ------------------------------------------------------------
 * PeerJS（WebRTC）を使い、サーバーを持たない静的サイト（GitHub Pages
 * などでの公開を想定）のままリアルタイム対戦を実現します。
 *
 * 設計方針:
 *   ・ルームは「フルメッシュ」構成（全員が全員と直接つながる）にする。
 *     こうしておくと、ホストが切断しても残りの全員が既に互いに繋がって
 *     いるため、新しい接続をやり直さずにホストだけを引き継げる。
 *   ・「誰が新ホストになるか」は、切断後も全員が同じ結論に達せるよう、
 *     参加順（joinOrder）が一番小さい生存者、という決め方にする
 *     （通信をやり取りしなくても各自で計算できる＝合意がいらない）。
 *   ・新しい接続を開始するのは常に「参加順が新しい方」というルールに
 *     しておくことで、二重に接続してしまうのを防いでいる。
 *
 * このファイルの前半（PURE LOGIC セクション）は実際のネットワーク通信を
 * 一切使わない純粋関数群で、ユニットテストで検証済み。後半は PeerJS の
 * 実際のAPIをラップする部分で、本物の2つのブラウザタブ間の通信でしか
 * 最終確認ができないため、公開後に実機でのテストをおすすめします。
 */

(function () {
  "use strict";

  const PEER_NAMESPACE = "hyperrobots5-";
  const ROOM_ID_LENGTH = 5;

  // ================= PURE LOGIC（ネットワークを使わない純粋関数） =================

  function generateRoomId() {
    let id = "";
    for (let i = 0; i < ROOM_ID_LENGTH; i++) id += String(Math.floor(Math.random() * 10));
    return id;
  }

  function roomIdToPeerId(roomId) {
    return PEER_NAMESPACE + roomId;
  }

  function peerIdToRoomId(peerId) {
    return peerId.startsWith(PEER_NAMESPACE) ? peerId.slice(PEER_NAMESPACE.length) : peerId;
  }

  function isValidRoomId(roomId) {
    return /^[0-9]{5}$/.test(String(roomId || "").trim());
  }

  // 生存しているピアの中から、参加順(joinOrder)が最小の人を新ホストとして選ぶ。
  // peers: [{ peerId, joinOrder, connected }] 全員が同じ入力を見れば同じ答えになる。
  function electHost(peers) {
    const alive = peers.filter((p) => p.connected);
    if (alive.length === 0) return null;
    return alive.reduce((best, p) => (p.joinOrder < best.joinOrder ? p : best), alive[0]).peerId;
  }

  // 新しいピアが増えたとき、「自分から接続しにいくべきか」を決める。
  // ルール: 参加順が新しい方（joinOrderが大きい方）が、古い方に接続しにいく。
  // これにより双方から同時に接続を試みて衝突するのを防ぐ。
  function shouldInitiateConnection(myJoinOrder, otherJoinOrder) {
    return myJoinOrder > otherJoinOrder;
  }

  // ================= イベントエミッタ（最小限の自作） =================

  function createEmitter() {
    const handlers = {};
    return {
      on(event, fn) {
        (handlers[event] = handlers[event] || []).push(fn);
      },
      off(event, fn) {
        if (!handlers[event]) return;
        handlers[event] = handlers[event].filter((h) => h !== fn);
      },
      emit(event, payload) {
        (handlers[event] || []).forEach((fn) => {
          try {
            fn(payload);
          } catch (e) {
            // 1つのハンドラの例外で他のハンドラや通信処理を止めない
            // eslint-disable-next-line no-console
            console.error("[network] handler error for", event, e);
          }
        });
      },
    };
  }

  // ================= PeerJS を使った実際の通信部分 =================

  // 参加のたびに変わってしまう PeerJS の peerId とは別に、「同じ人」を
  // 見分けるためのトークン。参加時にホストが発行し、こちら側は
  // localStorage にルームIDごとに保存しておく。タブを閉じて開き直しても
  // （同じ端末・同じブラウザなら）残るので、sessionStorageより再接続に強い。
  function getStoredToken(roomId) {
    try {
      return window.localStorage.getItem("hr-token-" + roomId);
    } catch (e) {
      return null;
    }
  }
  function storeToken(roomId, token) {
    try {
      window.localStorage.setItem("hr-token-" + roomId, token);
    } catch (e) {
      // ストレージが使えない環境でも対戦自体はできるようにしておく
    }
  }
  function clearStoredToken(roomId) {
    try {
      window.localStorage.removeItem("hr-token-" + roomId);
    } catch (e) {
      // noop
    }
  }
  function generateToken() {
    return "t-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function createNetwork() {
    const emitter = createEmitter();
    let peer = null;
    let myPeerId = null;
    let myJoinOrder = 0;
    let roomId = null;
    let hostPeerId = null; // 現在のホストの peerId
    let nextJoinOrder = 1; // ホスト側でのみ使う、参加順の採番カウンタ（減ることはない）
    let myToken = null; // 自分自身のトークン（ホストから割り当てられたもの）。
    // メッシュ内の他メンバーへ直接つなぎに行く時にも提示する必要がある
    // （でないと、後でホスト権を引き継いだ相手が自分を再接続と認識できない）。
    // peers: peerId -> { peerId, profile, joinOrder, connected, conn(DataConnection|null), isCpu, token }
    const peers = new Map();

    function findPeerByToken(token) {
      if (!token) return null;
      for (const p of peers.values()) {
        if (p.token === token) return p;
      }
      return null;
    }

    function peerListArray() {
      return Array.from(peers.values()).map((p) => ({
        peerId: p.peerId,
        profile: p.profile,
        joinOrder: p.joinOrder,
        connected: p.connected,
        isCpu: !!p.isCpu,
        token: p.token || null,
      }));
    }

    function isHost() {
      return myPeerId === hostPeerId;
    }

    function broadcast(message, excludePeerId) {
      const json = JSON.stringify(message);
      peers.forEach((p) => {
        if (p.peerId === myPeerId) return;
        if (excludePeerId && p.peerId === excludePeerId) return;
        if (p.conn && p.conn.open) {
          try {
            p.conn.send(json);
          } catch (e) {
            // 送信失敗は次のハートビート/切断検知に任せる
          }
        }
      });
    }

    function sendTo(peerId, message) {
      const p = peers.get(peerId);
      if (p && p.conn && p.conn.open) {
        p.conn.send(JSON.stringify(message));
      }
    }

    // WebRTCの切断は、タブを閉じる／OSがバックグラウンドで強制終了する
    // ／回線が急に切れるといった「行儀の悪い」切れ方をした場合、
    // conn の "close"／"error" イベントが発火しない、または発火するまで
    // 非常に長い時間がかかることがある（PeerJSまかせのICE状態変化検知に
    // 依存しているため）。これに頼っていると、切断がいつまでも検知
    // されず、ホスト引き継ぎも再接続の認識も動かなくなってしまう。
    // そこで、一定間隔で全員に軽量な "ping" を送り合い、しばらく
    // 何も届かない相手は「切断」とみなして能動的に処理する。
    const HEARTBEAT_INTERVAL_MS = 3000;
    const HEARTBEAT_TIMEOUT_MS = 9000;
    let heartbeatTimer = null;
    let verifyingHostAlive = false; // ホストが本当に消えたのか確認中かどうか（多重に確認を始めないためのフラグ）

    function markPeerDisconnected(peerId) {
      const p = peers.get(peerId);
      if (!p || !p.connected) return;
      p.connected = false;
      if (p.conn) {
        try { p.conn.close(); } catch (e) { /* noop */ }
      }
      emitter.emit("peer-disconnected", peerId);
      emitter.emit("peer-list-changed", peerListArray());
      if (isHost()) {
        broadcast({ type: "peer-left", peerId });
      }
      maybeMigrateHost();
    }

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        const now = Date.now();
        peers.forEach((p, peerId) => {
          if (!p.connected) return;
          // 直接のDataConnectionを一度も確立したことがない相手（"welcome"や
          // "peer-joined"経由で存在だけ知っている、メッシュ完成待ちの相手）
          // には、そもそもpingを送りようがなく、生存確認もできない。この
          // 場合にタイムアウト判定をかけると、実際にはまだ生きている相手を
          // 誤って「切断」と判定してしまう。
          // 一方、一度でも接続があった相手は、その conn.open が今どうかに
          // 関わらずタイムアウト判定の対象にする — WebRTCの close/error
          // イベントに頼らず能動的に切断を検知する、というこの仕組み自体の
          // 目的上、"conn.open が既にfalse" は判定を止める理由にはならない。
          if (!p.conn) return;
          if (p.conn.open) {
            try { p.conn.send(JSON.stringify({ type: "ping" })); } catch (e) { /* noop */ }
          }
          const last = p.lastSeen || 0;
          if (now - last > HEARTBEAT_TIMEOUT_MS) {
            markPeerDisconnected(peerId);
          }
        });
      }, HEARTBEAT_INTERVAL_MS);
      startVisibilityGuard();
    }

    // スマホ等でタブがスリープ／バックグラウンドになると、JSのタイマー
    // 自体がまるごと止まる（setIntervalが呼ばれなくなる）。この間、
    // 相手からのpingを受け取れず lastSeen がどんどん古くなっていくが、
    // これは「相手が切断した」のではなく「自分がスリープしていた」だけ
    // であることが多い。それにもかかわらず、画面が復帰した直後に通常の
    // ハートビートが一回走ると、蓄積した経過時間だけでいきなり
    // タイムアウト超過と判定してしまい、実際にはまだ生きている相手を
        // 「切断」と誤判定してホストの座を勝手に奪ってしまう
    // （＝お互いが自分をホストだと思い込む「分裂」状態の原因）。
    // そこで、画面が再び見えるようになった瞬間には、蓄積した経過時間を
    // 一旦リセットして相手に猶予を与え、その場で改めてpingを送って
    // 生死を確認し直す。これにより、本当に切断していた場合は次の
    // タイムアウト判定で正しく検知され、単に自分がスリープしていた
    // だけの場合は不必要な「切断」判定を避けられる。
    let visibilityGuardWired = false;
    function startVisibilityGuard() {
      if (visibilityGuardWired) return;
      if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
      visibilityGuardWired = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        const now = Date.now();
        peers.forEach((p) => {
          if (!p.connected || !p.conn) return;
          p.lastSeen = now; // 猶予を与える（すぐにはタイムアウト判定しない）
          if (p.conn.open) {
            try { p.conn.send(JSON.stringify({ type: "ping" })); } catch (e) { /* noop */ }
          }
        });
      });
    }
    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function handleIncomingData(fromPeerId, raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }
      // 種類を問わず、何か届いた時点でその相手は生きていると分かる
      // （pingだけでなく、通常のアプリメッセージでも同様に更新する）。
      const fromPeer = peers.get(fromPeerId);
      if (fromPeer) fromPeer.lastSeen = Date.now();
      if (msg.type === "ping") return; // 生存確認だけが目的で、それ以上の処理は不要

      emitter.emit("message", { from: fromPeerId, message: msg });

      if (msg.type === "welcome") {
        // 参加直後：ホストから初期ピア一覧をもらう
        myJoinOrder = msg.you.joinOrder;
        hostPeerId = msg.hostPeerId;
        myToken = msg.yourToken || myToken; // メッシュ接続にも載せられるよう、先に確定させておく
        // 「今つないだ相手（fromPeerId）」と「本来のホストのID
        // （hostPeerId）」が食い違うことがある——ホスト引き継ぎ後、
        // 新ホストがルームID由来の固定アドレス（rendezvous）で
        // 待ち受けているところへ接続した場合がこれにあたる。この
        // 場合、何もしないと「実際に開通しているconnを持つエントリ
        // （fromPeerId）」と「hostPeerIdとして参照される、conn を
        // 持たないエントリ」の2つに分裂してしまい、後で本当にホストが
        // 切断した時、切断が検知されるのは前者だけなので、
        // maybeMigrateHost() のガード判定（hostPeerId側を見る）は
        // ずっと「まだ繋がっている」と誤認したままになる
        // ——結果、二度目のホスト引き継ぎが永久に起こらなくなる。
        // そこで、実際に繋いだ側のconnを、本来のホストIDの方に
        // 付け替えて一本化しておく。
        if (hostPeerId && hostPeerId !== fromPeerId) {
          const rendezvousEntry = peers.get(fromPeerId);
          const realConn = rendezvousEntry ? rendezvousEntry.conn : null;
          peers.delete(fromPeerId);
          if (realConn) {
            const existingHostEntry = peers.get(hostPeerId);
            if (existingHostEntry) {
              existingHostEntry.conn = realConn;
              existingHostEntry.connected = true;
              existingHostEntry.connecting = false;
              existingHostEntry.lastSeen = Date.now();
            } else {
              peers.set(hostPeerId, {
                peerId: hostPeerId,
                profile: (rendezvousEntry && rendezvousEntry.profile) || null,
                joinOrder: (rendezvousEntry && rendezvousEntry.joinOrder) || 0,
                connected: true,
                conn: realConn,
                isCpu: false,
                connecting: false,
                token: (rendezvousEntry && rendezvousEntry.token) || null,
                lastSeen: Date.now(),
              });
            }
            // 以降、このconnから届くデータは新しいキー（hostPeerId）に
            // 対する生存確認として扱われるよう、close/errorのイベント
            // ハンドラも合わせて張り替えておく必要はない
            // ——wireConnection内のハンドラは conn.peer
            // （＝dialした相手の本当のpeer id = fromPeerId）を見て
            // peers.get(conn.peer) するため、そのままではズレたままに
            // なる。実利用ではconn.peerを書き換えられないので、
            // このconnに対するclose/errorが発生した際は、
            // markPeerDisconnectedForConn 経由でhostPeerId側も
            // 一緒に切断扱いにする。
            realConn.__hrAliasPeerId = hostPeerId;
          }
        }
        msg.peerList.forEach((p) => {
          if (p.peerId === myPeerId) return;
          if (!peers.has(p.peerId)) {
            peers.set(p.peerId, { ...p, conn: null, lastSeen: Date.now() });
          } else {
            Object.assign(peers.get(p.peerId), p, { lastSeen: Date.now() });
          }
        });
        // 自分より参加順が古い相手には自分から接続しにいく
        peers.forEach((p) => {
          if (p.peerId === hostPeerId) return; // ホストとは接続済み
          if (shouldInitiateConnection(myJoinOrder, p.joinOrder)) {
            connectTo(p.peerId);
          }
        });
        // "welcome" は自分のpeersマップを（既存メンバー全員分）まとめて
        // 更新するが、これまでは "room-joined" しか発火しておらず、
        // 対局中のHUD等、"peer-list-changed" だけを購読している側は
        // この更新に一切気づけなかった（＝実際にはtrue/trueで正しい
        // 情報が入っているのに、画面には反映されないまま固定される）。
        emitter.emit("peer-list-changed", peerListArray());
        emitter.emit("room-joined", { peerList: peerListArray(), hostPeerId, yourToken: msg.yourToken });
      } else if (msg.type === "peer-joined") {
        const p = msg.peer;
        if (p.peerId === myPeerId) return;
        if (!peers.has(p.peerId)) peers.set(p.peerId, { ...p, conn: null, lastSeen: Date.now() });
        else Object.assign(peers.get(p.peerId), p, { lastSeen: Date.now() });
        if (shouldInitiateConnection(myJoinOrder, p.joinOrder)) {
          connectTo(p.peerId);
        }
        emitter.emit("peer-list-changed", peerListArray());
      } else if (msg.type === "peer-left") {
        const p = peers.get(msg.peerId);
        if (p) p.connected = false;
        emitter.emit("peer-list-changed", peerListArray());
        maybeMigrateHost();
      } else if (msg.type === "host-migrated") {
        hostPeerId = msg.newHostPeerId;
        emitter.emit("host-changed", hostPeerId);
      } else if (msg.type === "app") {
        // ゲーム本体（online.js）向けのメッセージはそのまま上に流す
        emitter.emit("app-message", { from: fromPeerId, payload: msg.payload });
      } else if (msg.type === "hello") {
        // 参加者が自分のプロフィールを教えてくれた（接続時のmetadataで
        // 既に伝わっているはずだが、念のためのフォールバックとして残す）。
        setPeerProfile(fromPeerId, msg.profile);
        emitter.emit("peer-list-changed", peerListArray());
      }
    }

    let myProfileForHost = null; // hostRoom() で受け取ったプロフィール。ホスト引き継ぎ後の再接続受付でも使う。
    let rendezvousPeer = null; // ホスト引き継ぎ後、元のホストの固定IDを引き継いで待ち受けるための２本目のPeer

    // 新しい接続がホストとして受け入れられた時の共通処理。
    // 通常の（自分の本来のPeerJS ID宛の）接続と、引き継ぎ後の「元ホストの
    // 固定IDで待ち受けている、もう1本のrendezvousPeer」宛の接続の
    // どちらからも呼ばれる。
    function handleIncomingHostConnection(conn) {
      // 「相手がまだ生きているか」を確かめるためだけの接続
      // （verifyHostStillAlive から来るもの）は、参加者として登録せず、
      // 繋がったことだけを相手に伝えて即座に閉じる。ここで通常の参加
      // 処理に流してしまうと、トークンを持たない新規参加者として扱われ、
      // 既存エントリを上書きしてしまう。
      if (conn.metadata && conn.metadata.probe) {
        conn.on("open", () => {
          try { conn.close(); } catch (e) { /* noop */ }
        });
        return;
      }
      // conn.metadata は接続が確立する前（"open"を待たず）から同期的に
      // 読める。ここで「再接続かどうか」を判定してしまうことで、
      // "hello"メッセージの到着タイミングに左右されなくなる。
      const presentedToken = (conn.metadata && conn.metadata.token) || null;
      const presentedProfile = (conn.metadata && conn.metadata.profile) || null;
      const existingPeer = findPeerByToken(presentedToken);
      const joinOrder = existingPeer ? existingPeer.joinOrder : nextJoinOrder++;
      const assignedToken = existingPeer ? existingPeer.token : generateToken();
      // wireConnection が自前で conn.on("open", ...) を登録するので、
      // 「open」がまだ発火していないこのタイミング（connectionイベント
      // ハンドラの同期処理内）で呼ぶ必要がある。open発火後にネストして
      // 呼ぶと、その回のopenイベントを取りこぼしてしまう。
      wireConnection(conn, joinOrder, presentedProfile, assignedToken);
      conn.on("open", () => {
        const p = peers.get(conn.peer);
        if (p) { p.joinOrder = joinOrder; p.token = assignedToken; }
        // 新規参加者に、既存ピア一覧（自分含む）を送る
        const list = peerListArray()
          .filter((x) => x.peerId !== conn.peer)
          .concat([{ peerId: myPeerId, profile: myProfileForHost, joinOrder: myJoinOrder, connected: true, isCpu: false, token: myToken }]);
        conn.send(
          JSON.stringify({
            type: "welcome",
            hostPeerId: myPeerId,
            peerList: list,
            you: { joinOrder },
            yourToken: assignedToken,
          })
        );
        // 既存メンバーに新規参加を告知（各自が必要なら接続しにいく）。
        // token も一緒に伝えないと、ホスト以外のメンバーはこの相手が
        // 誰の再接続なのか判断できず、再接続のたびに「別人」として
        // 二重に表示されてしまう。
        broadcast({ type: "peer-joined", peer: { peerId: conn.peer, profile: presentedProfile, joinOrder, connected: true, token: assignedToken } }, conn.peer);
        emitter.emit("peer-list-changed", peerListArray());
      });
    }

    // ホスト引き継ぎが起きた時、新ホストが「元々のホストの固定PeerJS ID」
    // を２本目のPeerとして立ち上げ、そこでも接続を待ち受ける。
    // こうしておくことで、対局中にタブを閉じて後から戻ってきたプレイヤー
    // （ルームIDしか知らず、今の本当のホストの一時的なpeerIdは知らない）
    // も、常に同じ「ルームID」宛に接続するだけで今のホストにたどり着ける。
    function claimRendezvousIfNeeded() {
      if (!isHost() || rendezvousPeer) return;
      if (myPeerId === roomIdToPeerId(roomId)) return; // 自分が元々のホストなら、本体のpeerIdがそのまま入口なので不要
      try {
        const rp = new window.Peer(roomIdToPeerId(roomId));
        rendezvousPeer = rp;
        rp.on("connection", (conn) => handleIncomingHostConnection(conn));
        rp.on("error", () => {
          // 既に誰か（旧ホストがまだ生きている等）がそのIDを使っている場合等。
          // 致命的ではない：メッシュ自体は今のホストで機能し続けるので、
          // ここでは静かに諦める（再接続してくる相手が来た時にまた試す）。
          rendezvousPeer = null;
        });
      } catch (e) {
        rendezvousPeer = null;
      }
    }

    function maybeMigrateHost() {
      if (hostPeerId && peers.has(hostPeerId) && peers.get(hostPeerId).connected) return;
      // ここに来た時点では「ホストと繋がらなくなった」ことしか分からず、
      // 「相手が本当に落ちたのか」「実は自分の接続の方が一時的に
      // おかしくなっていただけなのか」を区別できていない。区別せずに
      // 即座に自分をホストに昇格させると、後で本当のホストが生きて
      // いた場合に「お互いが自分をホストだと思い込む」分裂状態を
      // 招いてしまう（スマホのスリープ復帰時などに起きやすい）。
      // ただし、この確認は毎回の切断で走らせると負荷になるため、
      // 「ルーム内で繋がっているのが自分だけになった」時に限定する。
      // ＝実質、ホスト引き継ぎ処理の直前に一度だけ走る確認。
      const someoneElseStillConnected = peerListArray().some((p) => p.connected);
      if (!someoneElseStillConnected && !isHost() && roomId && peer && !peer.destroyed && !verifyingHostAlive) {
        verifyingHostAlive = true;
        verifyHostStillAlive((alive) => {
          verifyingHostAlive = false;
          if (alive) {
            // 相手はまだ生きている＝自分の方が一時的に繋がらなく
            // なっていただけ。自分をホストにはせず、ルームへの
            // 再参加を行うようにonline.js側へ知らせる。
            emitter.emit("self-was-unreachable-please-rejoin");
            return;
          }
          proceedWithHostElection();
        });
        return;
      }
      proceedWithHostElection();
    }

    function proceedWithHostElection() {
      // 自分自身も候補に含めて計算する
      const all = peerListArray().concat([
        { peerId: myPeerId, joinOrder: myJoinOrder, connected: true },
      ]);
      const newHost = electHost(all);
      if (newHost && newHost !== hostPeerId) {
        hostPeerId = newHost;
        emitter.emit("host-changed", hostPeerId);
        if (isHost()) {
          // 新ホストは全員に通知する
          broadcast({ type: "host-migrated", newHostPeerId: hostPeerId });
          claimRendezvousIfNeeded();
        }
      }
    }

    // ルームの固定アドレス（roomIdToPeerId）へ実際に接続を試みることで、
    // 今のホスト（またはホストを引き継いだ誰か）が本当にまだ生きて
    // いるかどうかを確認する。生きていれば callback(true)、一定時間
    // 応答がなければ callback(false) を呼ぶ。
    function verifyHostStillAlive(callback) {
      const targetPeerId = roomIdToPeerId(roomId);
      let settled = false;
      const finish = (alive) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (testConn) testConn.close(); } catch (e) { /* noop */ }
        callback(alive);
      };
      // 相手が存在しない場合、PeerJSは接続オブジェクトではなく
      // Peer本体側で "peer-unavailable" 等のerrorを発火することが
      // 多いため、conn側だけでなくpeer側のerrorも見ておく。
      // なお、このリスナーは（PeerJSの標準的なEventEmitter実装なら
      // 使える）off()では明示的に外していない。settledガードにより、
      // 後から無関係なerrorで再度呼ばれても何もしないため実害はない。
      peer.on("error", () => finish(false));
      let testConn;
      const timer = setTimeout(() => finish(false), 4000);
      try {
        // 生存確認専用の接続であることを metadata で明示する。これを
        // 付けずに繋ぐと、受け取ったホスト側は「トークンを持たない
        // 新規参加者」として扱い、新しいトークンを発行したうえで
        // こちらの既存エントリを上書きしてしまう。その結果、本命の
        // 再参加の時に自分のトークンが見つからず、別人（3人目）として
        // 参加してしまっていた。
        testConn = peer.connect(targetPeerId, { reliable: true, metadata: { probe: true } });
        testConn.on("open", () => finish(true));
        testConn.on("error", () => finish(false));
      } catch (e) {
        finish(false);
      }
    }

    function wireConnection(conn, remoteJoinOrder, remoteProfile, remoteToken) {
      // 同じトークンを持つ既存エントリ（切断中のはず）があれば、それを
      // 新しい peerId に「引き継ぐ」形にする。古いキーのエントリをここで
      // 消しておかないと、再接続のたびにpeers Mapが増え続けてしまう。
      if (remoteToken) {
        for (const [oldPeerId, p] of peers.entries()) {
          if (p.token === remoteToken && oldPeerId !== conn.peer) {
            peers.delete(oldPeerId);
            break;
          }
        }
      }
      conn.on("open", () => {
        const existing = peers.get(conn.peer);
        if (existing) {
          existing.conn = conn;
          existing.connected = true;
          existing.connecting = false;
          existing.lastSeen = Date.now();
          if (remoteProfile) existing.profile = remoteProfile;
          if (remoteToken) existing.token = remoteToken;
        } else {
          peers.set(conn.peer, {
            peerId: conn.peer,
            profile: remoteProfile || null,
            joinOrder: remoteJoinOrder != null ? remoteJoinOrder : 9999,
            connected: true,
            conn,
            isCpu: false,
            connecting: false,
            token: remoteToken || null,
            lastSeen: Date.now(),
          });
        }
        emitter.emit("peer-connected", conn.peer);
        emitter.emit("peer-list-changed", peerListArray());
      });
      conn.on("data", (raw) => handleIncomingData(conn.__hrAliasPeerId || conn.peer, raw));
      conn.on("close", () => {
        // welcome処理でrendezvous経由のconnをホスト本来のIDへ付け替えた
        // 場合、conn.peer自体は（PeerJSの実体としては）rendezvousの
        // アドレスのままなので、__hrAliasPeerId があればそちらを優先する。
        const targetId = conn.__hrAliasPeerId || conn.peer;
        const p = peers.get(targetId);
        if (p) p.connected = false;
        emitter.emit("peer-disconnected", targetId);
        emitter.emit("peer-list-changed", peerListArray());
        if (isHost()) {
          broadcast({ type: "peer-left", peerId: targetId });
        }
        maybeMigrateHost();
      });
      conn.on("error", () => {
        const targetId = conn.__hrAliasPeerId || conn.peer;
        const p = peers.get(targetId);
        if (p) p.connected = false;
        emitter.emit("peer-disconnected", targetId);
        emitter.emit("peer-list-changed", peerListArray());
        maybeMigrateHost();
      });
    }

    function connectTo(remotePeerId) {
      if (!peer || remotePeerId === myPeerId) return;
      const existing = peers.get(remotePeerId);
      // 既に開通済み、または接続処理中なら二重に接続しにいかない
      if (existing && (existing.connecting || (existing.conn && existing.conn.open))) return;
      if (existing) existing.connecting = true;
      else {
        peers.set(remotePeerId, {
          peerId: remotePeerId, profile: null, joinOrder: 9999,
          connected: false, conn: null, isCpu: false, connecting: true, lastSeen: Date.now(),
        });
      }
      // メッシュ内の他メンバーへの接続にも、自分のtoken・プロフィールを
      // 載せておく。これをしないと、後でこの相手がホスト権を引き継いだ
      // 時に「自分」を再接続として認識してもらえない
      // （tokenがnullのまま登録されてしまうため）。
      const conn = peer.connect(remotePeerId, { reliable: true, metadata: { profile: myProfileForHost, token: myToken } });
      // 自分から接続しに行く側では、conn.metadata は「自分自身」を
      // 説明するものであり、相手の情報ではない。もしここで
      // wireConnection(conn) だけを呼んでconn.metadataへのフォール
      // バックに頼ると、相手のtoken/profileとして自分の値を誤って
      // 書き込んでしまう（自分のtokenがhostPeerId等と偶然一致した
      // 場合に、既存の別エントリを誤って消してしまう等の実害がある）。
      // 相手の情報は、既に分かっていれば（"peer-joined"や"welcome"
      // 経由で）existing に入っているので、それを明示的に渡す。
      wireConnection(conn, existing ? existing.joinOrder : undefined, existing ? existing.profile : undefined, existing ? existing.token : undefined);
    }

    function createPeerWithRetry(desiredId, attemptsLeft) {
      return new Promise((resolve, reject) => {
        const p = new window.Peer(desiredId);
        p.on("open", (id) => resolve(p));
        p.on("error", (err) => {
          if (err && err.type === "unavailable-id" && attemptsLeft > 0) {
            p.destroy();
            resolve(createPeerWithRetry(roomIdToPeerId(generateRoomId()), attemptsLeft - 1));
          } else {
            reject(err);
          }
        });
      });
    }

    async function hostRoom(myProfile) {
      const newRoomId = generateRoomId();
      const desiredPeerId = roomIdToPeerId(newRoomId);
      peer = await createPeerWithRetry(desiredPeerId, 5);
      myPeerId = peer.id;
      roomId = peerIdToRoomId(myPeerId);
      hostPeerId = myPeerId;
      myJoinOrder = 0;
      myProfileForHost = myProfile;
      // ホスト自身にもトークンを発行し、localStorageに保存しておく。
      // これをしないと、自分がホストであることを示すトークンが
      // 一切存在せず、後で自分がホストの座を失って再接続する時
      // （ホスト権を他の人に譲った後、自分が戻ってくる場合）に、
      // 「初めて参加する別人」として扱われてしまう。
      myToken = generateToken();
      storeToken(roomId, myToken);

      peer.on("connection", (conn) => handleIncomingHostConnection(conn));

      peer.on("disconnected", () => {
        emitter.emit("broker-disconnected");
      });

      startHeartbeat();
      emitter.emit("room-created", { roomId, peerId: myPeerId });
      return { roomId, peerId: myPeerId };
    }

    async function joinRoom(inputRoomId, myProfile) {
      if (!isValidRoomId(inputRoomId)) {
        throw new Error("ルームIDは5桁の数字で入力してください。");
      }
      myProfileForHost = myProfile; // 将来ホスト引き継ぎが起きた時、rendezvousの応答に使う
      const targetPeerId = roomIdToPeerId(inputRoomId);
      const existingToken = getStoredToken(inputRoomId); // このルームに前に参加していれば、その時のトークン
      peer = await createPeerWithRetry(null, 0).catch(() => {
        return new Promise((resolve, reject) => {
          const p = new window.Peer();
          p.on("open", () => resolve(p));
          p.on("error", reject);
        });
      });
      myPeerId = peer.id;
      roomId = inputRoomId;

      // メッシュ構成のため、自分より参加順が新しい他メンバーからの直接
      // 接続も受け付けられるようにしておく（ホスト宛の特別な処理は不要で、
      // 単に配線するだけでよい）。ここは相手からの着信なので、
      // conn.metadata は相手自身の情報として正しく使える。
      peer.on("connection", (conn) => {
        const remoteToken = (conn.metadata && conn.metadata.token) || null;
        const remoteProfile = (conn.metadata && conn.metadata.profile) || null;
        wireConnection(conn, undefined, remoteProfile, remoteToken);
      });

      return new Promise((resolve, reject) => {
        const conn = peer.connect(targetPeerId, { reliable: true, metadata: { profile: myProfile, token: existingToken } });
        // hostRoom() 側と同じ理由で、wireConnection は open がまだ発火して
        // いない今のタイミング（connect() 呼び出し直後の同期処理）で呼ぶ。
        // データの受信処理は wireConnection が内部で一度だけ登録するので、
        // ここで別に conn.on("data", ...) を重ねて登録しない
        // （二重登録すると同じメッセージが2回処理されてしまう）。
        // 「welcome」を受け取れたかどうかは emitter の room-joined イベントで見る。
        // ここは自分から接続しに行く側なので、conn.metadata は「自分自身」
        // の情報であり、相手（ホスト）の情報ではない。相手のtoken等は
        // "welcome" メッセージで別途受け取るので、ここでは渡さない。
        wireConnection(conn);
        let settled = false;
        conn.on("open", () => {
          // プロフィール・トークンは接続時のmetadataで既に伝わっているはず
          // だが、念のためのフォールバックとして送っておく。
          conn.send(JSON.stringify({ type: "hello", profile: myProfile, token: existingToken }));
        });
        emitter.on("room-joined", function onJoined(info) {
          if (settled) return;
          settled = true;
          emitter.off("room-joined", onJoined);
          hostPeerId = info.hostPeerId;
          // ホストが発行してくれたトークンを保存しておく（次に再接続する時に提示する）
          if (info.yourToken) storeToken(inputRoomId, info.yourToken);
          startHeartbeat();
          resolve({ roomId, peerId: myPeerId, hostPeerId });
        });
        conn.on("error", (err) => {
          if (!settled) {
            settled = true;
            reject(new Error("ルームに接続できませんでした。ルームIDを確認してください。"));
          }
        });
        peer.on("error", (err) => {
          if (!settled && err && err.type === "peer-unavailable") {
            settled = true;
            reject(new Error("そのルームIDは見つかりませんでした。"));
          }
        });
      });
    }

    function leaveRoom() {
      stopHeartbeat();
      peers.forEach((p) => {
        if (p.conn) {
          try {
            p.conn.close();
          } catch (e) {
            // noop
          }
        }
      });
      peers.clear();
      if (peer) {
        try {
          peer.destroy();
        } catch (e) {
          // noop
        }
      }
      if (rendezvousPeer) {
        try {
          rendezvousPeer.destroy();
        } catch (e) {
          // noop
        }
      }
      peer = null;
      rendezvousPeer = null;
      myPeerId = null;
      hostPeerId = null;
      roomId = null;
      myProfileForHost = null;
    }

    function sendApp(payload) {
      broadcast({ type: "app", payload });
    }

    function sendAppTo(peerId, payload) {
      sendTo(peerId, { type: "app", payload });
    }

    function setPeerProfile(peerId, profile) {
      const p = peers.get(peerId);
      if (p) p.profile = profile;
    }

    function setPeerCpu(peerId, isCpu) {
      const p = peers.get(peerId);
      if (p) p.isCpu = isCpu;
    }

    return {
      on: emitter.on,
      off: emitter.off,
      hostRoom,
      joinRoom,
      leaveRoom,
      broadcastApp: sendApp,
      sendAppTo,
      setPeerProfile,
      setPeerCpu,
      isHost,
      getMyPeerId: () => myPeerId,
      getRoomId: () => roomId,
      getHostPeerId: () => hostPeerId,
      getPeerList: peerListArray,
      getMyJoinOrder: () => myJoinOrder,
      getMyToken: () => myToken,
      clearStoredToken,
      // テスト用: 特定の相手の lastSeen を直接いじれるようにしておく
      // （スリープ中に時間だけが経過した状況を、実際に待たずに再現するため）。
      _debugSetLastSeen: (peerId, ts) => { const p = peers.get(peerId); if (p) p.lastSeen = ts; },
      _debugGetLastSeen: (peerId) => { const p = peers.get(peerId); return p ? p.lastSeen : null; },
    };
  }

  window.HRNetInternal = {
    generateRoomId,
    roomIdToPeerId,
    peerIdToRoomId,
    isValidRoomId,
    electHost,
    shouldInitiateConnection,
  };
  window.HRNet = createNetwork();
})();
