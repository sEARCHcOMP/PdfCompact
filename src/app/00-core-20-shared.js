  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function buildParticles() {
    const container = document.getElementById('successParticles');
    container.innerHTML = '';
    const colors = ['var(--accent)', 'var(--purple)', 'var(--success)', '#fbbf24'];
    const shapes = ['sq', 'ci', 'ci', 'sq', 'tr'];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const distance = 90 + Math.random() * 70;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      const shape = shapes[i % shapes.length];
      const color = colors[i % colors.length];
      const delay = 0.75 + Math.random() * 0.15;
      const p = document.createElement('div');
      p.className = 'success-particle ' + shape;
      p.style.setProperty('--x', x + 'px');
      p.style.setProperty('--y', y + 'px');
      p.style.setProperty('--delay', delay + 's');
      if (shape === 'tr') {
        p.style.borderBottomColor = color;
      } else {
        p.style.background = color;
      }
      const size = 6 + Math.random() * 6;
      if (shape !== 'tr') {
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.margin = `-${size/2}px 0 0 -${size/2}px`;
      }
      container.appendChild(p);
    }
  }
  function showSuccess(options) {
    const opts = options || {};
    const modal = document.getElementById('successModal');
    if (!modal) return;

    document.getElementById('successTitle').textContent = opts.title || '完了しました';
    document.getElementById('successSubtitle').textContent = opts.subtitle || '処理が終わりました';

    const statsEl = document.getElementById('successStats');
    if (opts.stats && opts.stats.length) {
      statsEl.style.display = 'grid';
      statsEl.innerHTML = opts.stats.map(s => {
        const hl = s.highlight === 'green' ? ' highlight-green' : (s.highlight ? ' highlight' : '');
        return `<div class="success-stat-row">
          <span class="success-stat-label">${s.label}</span>
          <span class="success-stat-value${hl}">${s.value}</span>
        </div>`;
      }).join('');
    } else {
      statsEl.style.display = 'none';
    }

    modal.classList.add('open');
    buildParticles();

    // Haptic feedback on mobile
    try {
      if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
    } catch (e) {}

    // Auto-close after 6 seconds
    if (successAutoCloseTimer) clearTimeout(successAutoCloseTimer);
    successAutoCloseTimer = setTimeout(closeSuccess, 6000);
  }
  function closeSuccess() {
    const modal = document.getElementById('successModal');
    if (!modal) return;
    modal.classList.remove('open');
    if (successAutoCloseTimer) { clearTimeout(successAutoCloseTimer); successAutoCloseTimer = null; }
  }
  // Dismiss on backdrop click or Esc
  document.getElementById('successModal').addEventListener('click', (e) => {
    if (e.target.id === 'successModal') closeSuccess();
  });
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('successModal');
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeSuccess();
    }
  });


  const jsPDF = (window.jspdf && window.jspdf.jsPDF) || null;
  if (!jsPDF) console.warn("jsPDF CDN not loaded yet");

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const actionBar = document.getElementById('actionBar');
  const totalStats = document.getElementById('totalStats');
  const compressBtn = document.getElementById('compressBtn');
  const clearBtn = document.getElementById('clearBtn');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const dpiSlider = document.getElementById('dpiSlider');
  const qSlider = document.getElementById('qSlider');
  const dpiVal = document.getElementById('dpiVal');
  const qVal = document.getElementById('qVal');
  const presetsEl = document.getElementById('presets');

  let files = [];
  let currentMode = 'auto';
  let ocrWorker = null; // cached Tesseract worker

  // OCR toggle
  const ocrToggle = document.getElementById('ocrToggle');
  const ocrBody = document.getElementById('ocrBody');
  const ocrLang = document.getElementById('ocrLang');
  ocrToggle.addEventListener('change', () => {
    ocrBody.classList.toggle('active', ocrToggle.checked);
  });

  // Mode button handling
  document.getElementById('modes').querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('modes').querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });

  // Preset handling
  presetsEl.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      presetsEl.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      dpiSlider.value = btn.dataset.dpi;
      qSlider.value = parseFloat(btn.dataset.q) * 100;
      updateSliderLabels();
    });
  });

  function updateSliderLabels() {
    dpiVal.textContent = dpiSlider.value;
    qVal.textContent = qSlider.value + '%';
    // deselect presets if manually changed
    const activeDpi = presetsEl.querySelector('.preset-btn.active');
    if (activeDpi) {
      const matchesDpi = +activeDpi.dataset.dpi === +dpiSlider.value;
      const matchesQ = Math.round(+activeDpi.dataset.q * 100) === +qSlider.value;
      if (!matchesDpi || !matchesQ) {
        presetsEl.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      }
    }
  }
  dpiSlider.addEventListener('input', updateSliderLabels);
  qSlider.addEventListener('input', updateSliderLabels);

  // Drag & drop
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  function handleFiles(fileListObj) {
    for (const f of fileListObj) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        files.push({
          id: Date.now() + Math.random(),
          file: f,
          origSize: f.size,
          status: 'pending',
          progress: 0,
          result: null,
          newSize: null
        });
      }
    }
    render();
    // ドロップ後、結果が見える位置へ自動スクロール
    requestAnimationFrame(() => {
      if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function render() {
    const fbar = document.getElementById('compressFilenameBar');
    if (files.length === 0) {
      fileList.innerHTML = '';
      actionBar.style.display = 'none';
      if (fbar) fbar.style.display = 'none';
      return;
    }
    actionBar.style.display = 'flex';
    if (fbar) fbar.style.display = 'flex';
    fileList.innerHTML = files.map(f => {
      const status = f.status;
      const rowClass = status === 'done' ? ' done' : status === 'error' ? ' error' : status === 'processing' ? ' processing' : '';
      let metaHtml = `<span class="meta-tag">${formatBytes(f.origSize)}</span>`;
      let statusHtml = '';
      let actionsHtml = '';

      if (status === 'pending') {
        statusHtml = `<div class="status">待機中</div>`;
        actionsHtml = `<button class="btn btn-small" onclick="removeFile('${f.id}')">×</button>`;
      } else if (status === 'processing') {
        metaHtml += `<span class="meta-tag">${f.currentStep || ''}</span>`;
        statusHtml = `<div class="status">処理中 ${Math.round(f.progress)}%</div>
          <div class="progress-wrap"><div class="progress-bar" style="width:${f.progress}%"></div></div>`;
      } else if (status === 'done') {
        const reduction = Math.round((1 - f.newSize / f.origSize) * 100);
        const modeLabel = f.mode === 'doc' ? '書類' : f.mode === 'photo' ? '写真' : '';
        const reductionDisplay = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
        const reductionClass = reduction >= 0 ? 'reduction' : 'reduction-neg';
        metaHtml += `<span class="arrow">→</span>
          <span class="meta-tag">${formatBytes(f.newSize)}</span>
          <span class="${reductionClass}">${reductionDisplay}</span>`;
        if (modeLabel) {
          metaHtml += `<span class="meta-tag mode-tag">${modeLabel}モード</span>`;
        }
        if (f.ocrApplied) {
          metaHtml += `<span class="meta-tag ocr-tag">🔍 OCR済</span>`;
        }
        const noteStr = f.note ? ` (${f.note})` : '';
        statusHtml = `<div class="status done">✓ 完了${noteStr}</div>`;
        actionsHtml = `<button class="btn btn-primary btn-small" onclick="downloadFile('${f.id}')">DL</button>`;
      } else if (status === 'error') {
        statusHtml = `<div class="status error">エラー: ${f.error || '処理失敗'}</div>`;
        actionsHtml = `<button class="btn btn-small" onclick="removeFile('${f.id}')">×</button>`;
      }

      return `<div class="file-row${rowClass}">
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.file.name)}</div>
          <div class="file-meta">${metaHtml}</div>
          ${statusHtml}
        </div>
        <div class="file-actions">${actionsHtml}</div>
      </div>`;
    }).join('');

    // totals
    const done = files.filter(f => f.status === 'done');
    if (done.length > 0) {
      const totalOrig = done.reduce((s, f) => s + f.origSize, 0);
      const totalNew = done.reduce((s, f) => s + f.newSize, 0);
      const totalRed = Math.round((1 - totalNew / totalOrig) * 100);
      totalStats.innerHTML = `${files.length} ファイル ・ 完了 ${done.length} / 合計 <strong>${formatBytes(totalOrig)} → ${formatBytes(totalNew)}</strong> (-${totalRed}%)`;
      downloadAllBtn.style.display = done.length > 1 ? '' : 'none';
    } else {
      totalStats.textContent = `${files.length} ファイル`;
      downloadAllBtn.style.display = 'none';
    }
  }

  // 全モード共通(script トップレベル)。String() で非文字列入力にも堅牢(旧モード版の挙動に統一)
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }


  window.removeFile = (id) => {
    files = files.filter(f => f.id != id);
    render();
  };

  window.downloadFile = async (id) => {
    const f = files.find(x => x.id == id);
    if (!f || !f.result) return;
    let blob = f.result;
    // v3.6.0: 出力前メタデータ除去 (compress出力は常にPDFだが型ガード)
    if (blob.type === 'application/pdf' && window.PdfSanitize) {
      blob = await window.PdfSanitize.process(blob);
    }
    triggerDownload(blob, makeOutputName(f.file.name));
  };

  // Filename input wiring (compress mode — custom prefix)
  (function() {
    const fin = document.getElementById('compressFilenameInput');
    const fcl = document.getElementById('compressFilenameClear');
    if (!fin) return;
    fin.addEventListener('input', () => {
      const v = fin.value;
      const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
      if (v !== cleaned) fin.value = cleaned;
      fcl.classList.toggle('visible', !!fin.value);
    });
    fcl.addEventListener('click', () => {
      fin.value = '';
      fcl.classList.remove('visible');
      fin.focus();
    });
  })();

  function makeOutputName(origName) {
    const userPrefixEl = document.getElementById('compressFilenameInput');
    const userPrefix = (userPrefixEl && userPrefixEl.value || '').trim();
    const base = origName.replace(/\.pdf$/i, '');
    let core;
    if (userPrefix) {
      if (files.length === 1) {
        core = userPrefix;
      } else {
        core = `${userPrefix}_${base}`;
      }
    } else {
      core = `${base}_軽量化`;
    }
    return `${appendTimestamp(core, 'compressFilenameTs')}.pdf`;
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  // ============================================================
  // 共有: ページ座標系の写像 (全モード共通・script トップレベル)
  // ============================================================
  // 「pdf.js viewport(回転・CropBox 適用後の見た目、左上原点・y下向き)」の矩形を、
  // 「pdf-lib の drawImage/drawRectangle 引数(回転前ページ座標、左下原点・y上向き)」へ変換する。
  // このプロジェクトで最も事故が多かった数学(v3.7.4 C2 / v3.7.6 H9)。テストは tests/geometry.spec.js
  // (回転4方向 × CropBox 有無のゴールデン)が固定している。挙動を変えたら必ずそこで検証すること。
  //
  // 知識メモ:
  // - 黒塗り(redact)は入力(クリック→ratio)も出力(ratio→ラスタ canvas)も viewport 空間で完結する
  //   ため、この写像は不要(構造的に回転・CropBox と整合。geometry.spec.js で証明済み)。
  // - 透かし(stepDrawWatermark)は buildPageOrientationMatrix(行列 push 方式)で同等の回転補正をしている。
  //
  // 引数は全て pt。anchor=矩形の「見た目の左上」(x,y) と幅 w・高さ h(見た目の軸)。
  // 戻り値: { x, y, width, height, rotate } — pdf-lib drawImage にそのまま渡せる。
  // rotate は反時計回り(PDF標準)。/Rotate は時計回り表示なので同角の CCW 描画で正立する。
  function viewportRectToPageDrawOpts(page, xPt, yPt, wPt, hPt) {
    // プレビュー(pdf.js viewport)は CropBox 基準。MediaBox(getSize)基準で写像すると
    // CropBox≠MediaBox の図面PDF(CAD/プロッタ出力)で全配置が一定量ズレる。
    // → CropBox 寸法で写像し、最後に CropBox 原点を加算してページ絶対座標へ平行移動する。
    // pdf-lib の getCropBox() は CropBox 未定義なら MediaBox を返す。万一の例外・不正値は getSize にフォールバック。
    let crop = null;
    try { crop = page.getCropBox(); } catch (e) { crop = null; }
    if (!crop || !(crop.width > 0) || !(crop.height > 0)) {
      const size = page.getSize();
      crop = { x: 0, y: 0, width: size.width, height: size.height };
    }
    const W = crop.width, H = crop.height;
    let rot = ((page.getRotation().angle % 360) + 360) % 360;
    if (rot !== 90 && rot !== 180 && rot !== 270) rot = 0;   // 90の倍数以外(仕様外)は回転なし扱い
    const a = xPt, b = yPt, w = wPt, h = hPt;
    // アンカー = 矩形の「見た目の左下」(viewport 座標 (a, b+h)) を回転前 CropBox 相対座標へ逆写像
    let x, y;
    if (rot === 90)       { x = b + h;       y = a; }
    else if (rot === 180) { x = W - a;       y = b + h; }
    else if (rot === 270) { x = W - (b + h); y = H - a; }
    else                  { x = a;           y = H - (b + h); }
    // CropBox 原点を加算(CropBox=MediaBox 原点(0,0) の通常PDFでは +0)
    return { x: x + crop.x, y: y + crop.y, width: w, height: h, rotate: window.PDFLib.degrees(rot) };
  }

  // 共有: JPEG の EXIF Orientation タグ (1-8) を ArrayBuffer から読む(全モード共通)。
  // SOI → セグメント走査 → APP1 "Exif" → TIFF → IFD0 の 0x0112 を探す。リトル/ビッグ両対応。
  // JPEG以外・タグ無し・解析失敗・範囲外は 1(補正不要)。旧 img2pdf版/imgplace版と等価
  // であることは tests/exif.spec.js(orientation 1-8 × 両エンディアン)が固定している。
  function readExifOrientation(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return 1; // SOI が無い = JPEGでない
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset);
        if ((marker & 0xFF00) !== 0xFF00) return 1;  // マーカー列が壊れている
        if (marker === 0xFFDA) return 1;             // SOS 以降に EXIF は無い
        const size = view.getUint16(offset + 2);
        if (size < 2) return 1;                      // 不正サイズ(無限ループ防止)
        if (marker === 0xFFE1 && offset + 18 <= view.byteLength &&
            view.getUint32(offset + 4) === 0x45786966) { // "Exif"
          const tiff = offset + 10;
          const endianMark = view.getUint16(tiff);
          if (endianMark !== 0x4949 && endianMark !== 0x4D4D) return 1;
          const little = endianMark === 0x4949;      // "II" = リトルエンディアン
          const ifd = tiff + view.getUint32(tiff + 4, little);
          if (ifd + 2 > view.byteLength) return 1;
          const count = view.getUint16(ifd, little);
          for (let i = 0; i < count; i++) {
            const entry = ifd + 2 + i * 12;
            if (entry + 12 > view.byteLength) return 1;
            if (view.getUint16(entry, little) === 0x0112) { // 0x0112 = Orientation
              const val = view.getUint16(entry + 8, little);
              return (val >= 1 && val <= 8) ? val : 1;
            }
          }
          return 1;                                  // Orientation タグ無し
        }
        offset += 2 + size;
      }
    } catch (e) {
      // 解析失敗は「補正不要」扱い
    }
    return 1;
  }

  // 共有: アクションバー中央のステータス・ミラー(全モード共通の「常時見える位置」表示)。
  // 各モードの setStatus が末尾でこれを呼ぶ。el が無ければ何もしない。
  function setActionBarStatus(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('visible', !!text);
    el.classList.toggle('error', type === 'error');
    el.classList.toggle('success', type === 'success' || type === 'done');
  }

  // 共有: img-status-msg スタイル(className切替)の setStatus 本体 + アクションバー・ミラー。
  // img2pdf/convert/pdfedit はプライマリ要素とミラー要素IDだけ違う完全同型なのでこれに委譲する。
  // (imgPlace はプライマリが display 切替の別仕様のため、ミラー部分だけ setActionBarStatus を使う)
  function setModeStatus(primaryEl, mirrorEl, text, type) {
    if (primaryEl) {
      primaryEl.textContent = text;
      primaryEl.className = 'img-status-msg' + (type ? ' ' + type : '');
    }
    setActionBarStatus(mirrorEl, text, type);
  }

  clearBtn.addEventListener('click', () => {
    files = [];
    render();
  });

  downloadAllBtn.addEventListener('click', () => {
    const doneFiles = files.filter(f => f.status === 'done');
    doneFiles.forEach((f, i) => {
      setTimeout(async () => {
        let blob = f.result;
        // v3.6.0: 出力前メタデータ除去 (型ガード付き)
        if (blob.type === 'application/pdf' && window.PdfSanitize) {
          blob = await window.PdfSanitize.process(blob);
        }
        triggerDownload(blob, makeOutputName(f.file.name));
      }, i * 300);
    });
    // 全DL終了後に保持ファイルをクリア (連続作業しやすく)
    if (doneFiles.length > 0) {
      const totalDelay = doneFiles.length * 300 + 500;
      setTimeout(() => {
        files = [];
        render();
      }, totalDelay);
    }
  });

  compressBtn.addEventListener('click', async () => {
    const dpi = +dpiSlider.value;
    const quality = +qSlider.value / 100;
    const ocrEnabled = ocrToggle.checked;
    const ocrLangValue = ocrLang.value;

    // 全件処理済みでの再クリック = 設定変更後の再圧縮とみなし、全件を未処理に戻す
    // (未処理・エラーが1件でも残っていれば従来どおりその分だけ処理)
    if (files.length > 0 && files.every(f => f.status === 'done')) {
      for (const f of files) {
        f.status = 'pending';
        f.progress = 0;
        f.result = null;
        f.newSize = null;
        f.currentStep = '';
        f.mode = null;
        f.note = null;
        f.ocrApplied = false;
        f.error = null;
      }
      render();
    }

    compressBtn.disabled = true;
    clearBtn.disabled = true;

    for (const f of files) {
      if (f.status === 'done') continue;
      try {
        f.status = 'processing';
        f.progress = 0;
        render();

        // Mode routing
        let mode = currentMode;
        if (mode === 'auto') {
          f.currentStep = '判定中...';
          render();
          mode = await detectBestMode(f.file);
        }
        f.mode = mode;

        let result;
        if (mode === 'doc') {
          const docResult = await compressPdfDocMode(f, dpi, quality);
          // 書類モードで効果が薄ければ auto時のみ写真モードへ自動フォールバック(note は内部で確定)
          result = await maybeFallbackToPhoto(f, docResult, dpi, quality, {
            isAuto: (currentMode === 'auto'),
            ocrEnabled,
            ocrLangValue,
          });
        } else if (ocrEnabled) {
          result = await compressPdfPhotoModeOCR(f, dpi, quality, ocrLangValue);
          f.ocrApplied = true;
        } else {
          result = await compressPdfPhotoMode(f, dpi, quality);
        }

        // 最終ガード(出力が元以上なら元へ戻す)は共有ヘルパで実行
        await applyResultWithGuard(f, result);
        render();
      } catch (err) {
        console.error(err);
        let handled = false;
        // auto時の暗号化(編集制限)エラーは写真モードへ自動フォールバック。
        // pdf.js はパスワード無しの編集制限PDFを描画できることが多いため、写真モードなら処理可能。
        // doc経路(ignoreEncryption:false の load)で落ちた時だけ救済する(f.mode==='doc')。
        // 手動docのときは従来どおりエラー表示(下の通常処理)を維持する。
        if (/encrypt/i.test(err.message || '') && currentMode === 'auto' && f.mode === 'doc') {
          try {
            f.currentStep = '画像化で再圧縮中...';
            render();
            const photo = ocrEnabled
              ? await compressPdfPhotoModeOCR(f, dpi, quality, ocrLangValue)
              : await compressPdfPhotoMode(f, dpi, quality);
            if (ocrEnabled) f.ocrApplied = true;
            // 写真化で実際に縮んだ(または検索性付与=OCR)ときだけ採用。
            // 縮まなければ「開けすらしなかった暗号化原本」を完了扱いにせず、正直にエラーへ落とす。
            if (photo.blob.size < f.origSize || f.ocrApplied) {
              f.mode = 'photo';   // 実体は画像化された
              f.note = ocrEnabled ? COMPRESS_NOTE.PHOTO_FALLBACK_OCR : COMPRESS_NOTE.PHOTO_FALLBACK;
              f.result = photo.blob;
              f.newSize = photo.blob.size;
              f.status = 'done';
              handled = true;
            }
          } catch (e2) { /* 写真モードでも失敗 → 下の通常エラー処理へ */ }
        }
        if (!handled) {
          f.status = 'error';
          let errMsg = err.message || '不明';
          // 保護付き(編集制限)PDFは書類モードの load (ignoreEncryption:false) で
          // 英語の生エラーになるため、日本語の説明と回避策に差し替える
          if (/encrypt/i.test(errMsg)) {
            errMsg = '保護付き(編集制限)のPDFのため書類モードで処理できません。圧縮モードを「写真」にすると処理できます';
          }
          f.error = errMsg;
        }
        render();
      }
    }

    // Cleanup OCR worker after batch
    if (ocrWorker) {
      try { await ocrWorker.terminate(); } catch (e) {}
      ocrWorker = null;
    }

    compressBtn.disabled = false;
    clearBtn.disabled = false;

    // Celebrate!
    const doneFiles = files.filter(f => f.status === 'done');
    const errFiles = files.filter(f => f.status === 'error');
    if (doneFiles.length > 0) {
      const totalOrig = doneFiles.reduce((s, f) => s + f.origSize, 0);
      const totalNew = doneFiles.reduce((s, f) => s + f.newSize, 0);
      const reduction = totalOrig > 0 ? Math.round((1 - totalNew / totalOrig) * 100) : 0;
      const stats = [
        { label: '処理ファイル', value: `${doneFiles.length} 件` },
        { label: '元のサイズ', value: formatBytes(totalOrig) },
        { label: '新サイズ', value: formatBytes(totalNew) },
      ];
      if (reduction > 0) {
        stats.push({ label: '削減率', value: `-${reduction}%`, highlight: 'green' });
      } else if (reduction < 0) {
        stats.push({ label: '変化', value: `+${Math.abs(reduction)}%`, highlight: true });
      }
      let sub = '軽量化が完了しました';
      if (errFiles.length > 0) sub += ` (${errFiles.length}件エラー)`;
      showSuccess({
        title: '軽量化完了',
        subtitle: sub,
        stats: stats
      });
    } else if (errFiles.length > 0) {
      // 全ファイルがエラー → 何が起きたか明示 (success-modal 経路に乗らないので独自に)
      setStatus(`✕ ${errFiles.length}件すべて圧縮失敗。ファイル形式・破損・ロックを確認してください`, 'error');
    }
  });

  // Auto-detect: if PDF has significant text content, use doc mode
