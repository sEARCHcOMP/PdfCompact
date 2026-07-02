  // ============================================================
  // モード: スマホ転送 (Hikari) — オンライン専用
  //   スマホ⇔ブラウザの双方向ファイル転送。Firebase RTDB(通知) + Cloudflare R2 Worker(中継)。
  //   受信: transfers の from:'phone' を監視 / 送信: R2 へ PUT 後 from:'pc' で通知
  //   (スマホ側 phone.js は from:'pc' を監視して「保存」ボタンを出す実装が既にある)
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
    var sendHint = document.getElementById('hikariSendHint');
    var sendDrop = document.getElementById('hikariSendDrop');
    var sendInput = document.getElementById('hikariSendInput');
    var sendBtn = document.getElementById('hikariSendBtn');
    var sendList = document.getElementById('hikariSendList');
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
          updateSendUI(true);
        } else {
          setStatus('wait', 'スマートフォンを待っています');
          elQrStage.classList.remove('connected');
          updateSendUI(false);
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

    // ============================================================
    // パソコン → スマートフォン 送信 (スマホ側 phone.js の uploadOne と対称)
    // ============================================================
    var phoneConnected = false;
    var MAX_SEND_SIZE = 100 * 1024 * 1024;   // Worker 側の上限(100MB)と一致させる

    function updateSendUI(connected){
      phoneConnected = connected;
      if (!sendBtn) return;
      sendBtn.disabled = !connected;
      if (sendDrop) sendDrop.classList.toggle('ready', connected);
      if (sendHint) sendHint.textContent = connected
        ? '写真・PDFなど、どんなファイルでも送れます。スマートフォン側に「保存」ボタン付きで届きます。'
        : 'スマートフォンと接続すると送信できます。';
    }

    // ファイル名の無害化(スマホ側 phone.js と同一ルール)
    function sanitizeFileName(name){
      var safe = String(name || '');
      try { safe = safe.normalize('NFKC'); } catch (_e) {}
      safe = safe.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      if (!safe || safe === '.' || safe === '..') safe = 'file_' + Date.now();
      return safe;
    }

    // 画像ならスマホ側の保存前プレビュー用サムネイルを生成(非画像・失敗時は null)
    function makeThumb(file){
      if (!file.type || file.type.indexOf('image/') !== 0) return Promise.resolve(null);
      if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
      return createImageBitmap(file).then(function(bitmap){
        var scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
        var w = Math.max(1, Math.round(bitmap.width * scale));
        var h = Math.max(1, Math.round(bitmap.height * scale));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        var dataUrl = cv.toDataURL('image/jpeg', 0.7);
        return dataUrl.length > 120 * 1024 ? null : dataUrl;  // RTDBノード肥大化防止(スマホ側と同じ上限)
      }).catch(function(){ return null; });
    }

    // 進捗付き PUT (fetch は upload 進捗が取れないため XHR)
    function xhrPut(url, file, onProgress){
      return new Promise(function(resolve, reject){
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = function(e){
          if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
        };
        xhr.onload = function(){
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error('HTTP ' + xhr.status));
        };
        xhr.onerror = function(){ reject(new Error('network error')); };
        xhr.send(file);
      });
    }

    function addSendRow(name){
      var row = document.createElement('div');
      row.className = 'hikari-up-row';
      row.innerHTML =
        '<div class="hikari-up-head">' +
          '<span class="hikari-up-name">' + escapeHtml(name) + '</span>' +
          '<span class="hikari-up-state">0%</span>' +
        '</div>' +
        '<div class="hikari-up-track"><div class="hikari-up-bar"></div></div>';
      sendList.appendChild(row);
      return { row: row, bar: row.querySelector('.hikari-up-bar'), state: row.querySelector('.hikari-up-state') };
    }

    function addSendError(message){
      var row = document.createElement('div');
      row.className = 'hikari-up-row failed';
      row.innerHTML = '<div class="hikari-up-head"><span class="hikari-up-name">' + escapeHtml(message) + '</span></div>';
      sendList.appendChild(row);
    }

    function sendOne(file){
      if (file.size > MAX_SEND_SIZE){
        addSendError('「' + file.name + '」は送信できません。1ファイルあたり 100MB までです。');
        return Promise.resolve();
      }
      var fileId = randomHex(16);
      var safeName = sanitizeFileName(file.name);
      var key = 'transfers/' + roomId + '/' + fileId + '/' + encodeURIComponent(safeName);
      var row = addSendRow(file.name);
      return makeThumb(file).then(function(thumb){
        var url = HIKARI_WORKER_URL + '/upload?key=' + encodeURIComponent(key) +
                  '&ct=' + encodeURIComponent(file.type || 'application/octet-stream');
        return xhrPut(url, file, function(loaded, total){
          var pct = total ? Math.round(loaded / total * 100) : 0;
          row.bar.style.width = pct + '%';
          row.state.textContent = pct + '%';
        }).then(function(){
          var payload = {
            name: file.name,
            safeName: safeName,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            key: key,
            from: 'pc',
            uploadedAt: window.firebase.database.ServerValue.TIMESTAMP
          };
          if (thumb) payload.thumb = thumb;
          return db.ref('rooms/' + roomId + '/transfers/' + fileId).set(payload);
        });
      }).then(function(){
        row.bar.style.width = '100%';
        row.state.textContent = '送信しました';
        row.row.classList.add('done');
      }).catch(function(e){
        console.warn('[hikari] send failed:', e);
        row.state.textContent = '失敗しました';
        row.row.classList.add('failed');
        // 上げかけの実体が孤児にならないよう掃除(ベストエフォート)
        fetch(HIKARI_WORKER_URL + '/delete?key=' + encodeURIComponent(key), { method: 'DELETE' }).catch(function(){});
      });
    }

    // 複数ファイルは直列送信(帯域の奪い合いと進捗の混線を避ける)
    function sendFiles(files){
      var arr = Array.prototype.slice.call(files || []);
      if (!arr.length) return;
      // ファイル選択ダイアログを開いている間に切断された場合など:
      // 無言で捨てると「送ったつもり」事故になるため、必ず痕跡を残す
      if (!phoneConnected || !db){
        addSendError('接続が切れたため送信できませんでした。スマートフォンでQRコードをもう一度読み取ってください。');
        return;
      }
      var chain = Promise.resolve();
      arr.forEach(function(f){
        chain = chain.then(function(){ return sendOne(f); });
      });
    }

    if (sendBtn){
      sendBtn.addEventListener('click', function(){ sendInput.click(); });
      sendInput.addEventListener('change', function(){
        sendFiles(sendInput.files);
        sendInput.value = '';   // 同じファイルを続けて送り直せるように
      });
      // D&D は他タブの共通ドロップ処理に取られないよう伝播を止める
      ['dragenter', 'dragover'].forEach(function(ev){
        sendDrop.addEventListener(ev, function(e){
          e.preventDefault();
          e.stopPropagation();
          if (phoneConnected) sendDrop.classList.add('dragover');
        });
      });
      sendDrop.addEventListener('dragleave', function(e){
        e.preventDefault();
        e.stopPropagation();
        sendDrop.classList.remove('dragover');
      });
      sendDrop.addEventListener('drop', function(e){
        e.preventDefault();
        e.stopPropagation();
        sendDrop.classList.remove('dragover');
        sendFiles(e.dataTransfer && e.dataTransfer.files);   // 未接続時は sendFiles 側が案内を出す
      });
    }
  })();
