  // ============================================================
  // モード: スマホ転送 (Hikari) — オンライン専用
  //   スマホ→ブラウザのファイル受信。Firebase RTDB(通知) + Cloudflare R2 Worker(中継)。
  //   SDK はタブ初回選択時に動的ロード(他タブのオフライン動作を一切妨げない)。
  //   本体アプリ「PC便利ツール集」の Hikari と同じバックエンドを共有する。
  // ============================================================
  (function hikariModule(){
    'use strict';

    // ---- バックエンド設定 (Firebase Web config は公開前提の識別子。認可は DB ルール側) ----
    var HIKARI_FIREBASE_CONFIG = {
      apiKey: 'AIzaSyCq5SJuZQPVxp5HtWvPwT_G0V2UpUqnhoc',
      authDomain: 'hikari-toolkit.firebaseapp.com',
      databaseURL: 'https://hikari-toolkit-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: 'hikari-toolkit'
    };
    var HIKARI_WORKER_URL = 'https://hikari-toolkit.cfa2greatwall.workers.dev';
    var HIKARI_PHONE_URL = 'https://hikari-toolkit.web.app';
    var SDK_APP = 'https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js';
    var SDK_DB  = 'https://www.gstatic.com/firebasejs/12.13.0/firebase-database-compat.js';
    var QR_LIB  = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

    var tab = document.querySelector('.mode-tab[data-mode="hikari"]');
    var elLoading = document.getElementById('hikariLoading');
    var elOffline = document.getElementById('hikariOffline');
    var elMain = document.getElementById('hikariMain');
    var elQrStage = document.getElementById('hikariQrStage');
    var elQr = document.getElementById('hikariQr');
    var elStatus = document.getElementById('hikariStatus');
    var pendingCard = document.getElementById('hikariPendingCard');
    var pendingList = document.getElementById('hikariPendingList');
    var acceptAllBtn = document.getElementById('hikariAcceptAll');
    var doneCard = document.getElementById('hikariDoneCard');
    var doneList = document.getElementById('hikariDoneList');
    if (!tab || !elQr || !elMain || !pendingList) return;

    var initStarted = false;
    var db = null, roomRef = null, roomId = null, token = null;
    var pendingMeta = {};   // fileId -> {meta, row}

    // タブ初回選択で初期化(それまで SDK は一切読み込まない)
    tab.addEventListener('click', function(){
      if (initStarted) return;
      initStarted = true;
      init();
    });

    function loadScript(src){
      return new Promise(function(resolve, reject){
        var s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function(){ reject(new Error('スクリプトの読み込みに失敗: ' + src)); };
        document.head.appendChild(s);
      });
    }

    function randomHex(len){
      var bytes = new Uint8Array(len / 2);
      crypto.getRandomValues(bytes);
      return Array.prototype.map.call(bytes, function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    function showOffline(){
      elLoading.hidden = true;
      elMain.hidden = true;
      elOffline.hidden = false;
    }

    function setStatus(kind, text){
      elStatus.className = 'hikari-status ' + kind;
      elStatus.innerHTML = '<span class="hikari-status-dot"></span>' + escapeHtml(text);
    }

    function init(){
      elLoading.hidden = false;
      if (!navigator.onLine){ showOffline(); return; }
      loadScript(SDK_APP)
        .then(function(){ return loadScript(SDK_DB); })
        .then(function(){ return loadScript(QR_LIB); })
        .then(start)
        .catch(function(e){
          console.warn('[hikari] init failed:', e);
          showOffline();
        });
    }

    function start(){
      if (!window.firebase.apps.length) window.firebase.initializeApp(HIKARI_FIREBASE_CONFIG);
      db = window.firebase.database();
      roomId = randomHex(32);
      token = randomHex(32);
      roomRef = db.ref('rooms/' + roomId);
      roomRef.set({
        createdAt: window.firebase.database.ServerValue.TIMESTAMP,
        token: token,
        r2: { workerUrl: HIKARI_WORKER_URL }
      }).then(function(){
        roomRef.onDisconnect().remove();   // タブを閉じたら部屋も消す
        renderQr();
        watchPresence();
        watchTransfers();
        elLoading.hidden = true;
        elMain.hidden = false;
        setStatus('wait', 'スマートフォンを待っています');
      }).catch(function(e){
        console.warn('[hikari] room create failed:', e);
        showOffline();
      });
    }

    function renderQr(){
      var url = HIKARI_PHONE_URL + '/?room=' + roomId + '&t=' + token;
      var qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      elQr.innerHTML = qr.createImgTag(5, 8);
      var img = elQr.querySelector('img');
      if (img) img.alt = 'QRコード(スマートフォンで読み取ってください)';
    }

    // スマホの在席監視(接続されたら波紋を止めて表示を切替)
    function watchPresence(){
      db.ref('rooms/' + roomId + '/phonePresence').on('value', function(snap){
        var count = snap.numChildren();
        if (count > 0){
          setStatus('ok', 'スマートフォンと接続中');
          elQrStage.classList.add('connected');
        } else {
          setStatus('wait', 'スマートフォンを待っています');
          elQrStage.classList.remove('connected');
        }
      });
    }

    // スマホからの送信通知 → 受信待ちに追加
    function watchTransfers(){
      db.ref('rooms/' + roomId + '/transfers').on('child_added', function(snap){
        var meta = snap.val();
        if (!meta || meta.from !== 'phone' || pendingMeta[snap.key]) return;
        addPendingRow(snap.key, meta);
      });
    }

    function addPendingRow(fileId, meta){
      pendingCard.hidden = false;
      var isImage = meta.mime && meta.mime.indexOf('image/') === 0;
      var row = document.createElement('div');
      row.className = 'hikari-row';
      row.innerHTML =
        '<div class="hikari-row-thumb">' + (isImage ? '🖼' : '📄') + '</div>' +
        '<div class="hikari-row-body">' +
          '<div class="hikari-row-name">' + escapeHtml(meta.name || 'ファイル') + '</div>' +
          '<div class="hikari-row-size">' + formatBytes(meta.size || 0) + '</div>' +
        '</div>' +
        '<button class="hikari-row-accept" type="button">受信</button>' +
        '<button class="hikari-row-dismiss" type="button" title="見送る">✕</button>';
      if (meta.thumb){
        var thumbBox = row.querySelector('.hikari-row-thumb');
        thumbBox.textContent = '';
        var img = document.createElement('img');
        img.src = meta.thumb;
        img.alt = meta.name || '';
        thumbBox.appendChild(img);
      }
      row.querySelector('.hikari-row-accept').addEventListener('click', function(){
        receiveOne(fileId);
      });
      row.querySelector('.hikari-row-dismiss').addEventListener('click', function(){
        cleanupRemote(fileId, meta);
        removePendingRow(fileId);
      });
      pendingList.appendChild(row);
      pendingMeta[fileId] = { meta: meta, row: row };
    }

    function removePendingRow(fileId){
      var entry = pendingMeta[fileId];
      if (entry && entry.row) entry.row.remove();
      delete pendingMeta[fileId];
      if (pendingList.children.length === 0) pendingCard.hidden = true;
    }

    function receiveOne(fileId){
      var entry = pendingMeta[fileId];
      if (!entry) return;
      var meta = entry.meta;
      var btn = entry.row.querySelector('.hikari-row-accept');
      btn.disabled = true;
      btn.textContent = '受信中…';
      fetch(HIKARI_WORKER_URL + '/download?key=' + encodeURIComponent(meta.key))
        .then(function(res){
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        })
        .then(function(blob){
          triggerDownload(blob, meta.name || 'file');
          cleanupRemote(fileId, meta);
          removePendingRow(fileId);
          addDoneRow(meta);
        })
        .catch(function(e){
          console.warn('[hikari] download failed:', e);
          btn.disabled = false;
          btn.textContent = '再試行';
        });
    }

    function addDoneRow(meta){
      doneCard.hidden = false;
      var isImage = meta.mime && meta.mime.indexOf('image/') === 0;
      var row = document.createElement('div');
      row.className = 'hikari-row done';
      row.innerHTML =
        '<div class="hikari-row-thumb">' + (isImage ? '🖼' : '📄') + '</div>' +
        '<div class="hikari-row-body">' +
          '<div class="hikari-row-name">' + escapeHtml(meta.name || 'ファイル') + '</div>' +
          '<div class="hikari-row-size">' + formatBytes(meta.size || 0) + '</div>' +
        '</div>' +
        '<span class="hikari-row-done-mark">ダウンロード済み</span>';
      if (meta.thumb){
        var thumbBox = row.querySelector('.hikari-row-thumb');
        thumbBox.textContent = '';
        var img = document.createElement('img');
        img.src = meta.thumb;
        img.alt = meta.name || '';
        thumbBox.appendChild(img);
      }
      doneList.insertBefore(row, doneList.firstChild);
    }

    // クラウド上のデータ掃除(R2 実体 + RTDB 通知ノード)
    function cleanupRemote(fileId, meta){
      fetch(HIKARI_WORKER_URL + '/delete?key=' + encodeURIComponent(meta.key), { method: 'DELETE' })
        .catch(function(){});
      db.ref('rooms/' + roomId + '/transfers/' + fileId).remove().catch(function(){});
    }

    acceptAllBtn.addEventListener('click', function(){
      Object.keys(pendingMeta).forEach(function(fileId){ receiveOne(fileId); });
    });
  })();
