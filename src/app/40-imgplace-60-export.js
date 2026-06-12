    async function downloadOrShare(blob, filename) {
      const isMobile = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
                    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isMobile) {
        try {
          if (typeof File !== 'undefined' && navigator.canShare) {
            const file = new File([blob], filename, { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title: filename });
              return; // 共有シートで処理された
            }
          }
        } catch (e) {
          if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
          console.warn('[imgPlace] share failed, fallback to download:', e);
        }
      }
      // 通常ダウンロード（デスクトップ + モバイルでshare不可な場合）
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    // ----- .lpw 入出力ヘルパー -----
    // ArrayBuffer → Base64（チャンク分割で巨大データにも対応）
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000; // 32KB ずつ
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }
    function base64ToArrayBuffer(b64) {
      const binary = atob(b64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    async function sha256Hex(buffer) {
      const hash = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ----- IndexedDB autosave ヘルパー -----
    function openIdb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'baseSha' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    async function autosavePut(record) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        tx.objectStore(IDB_STORE).put(record);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = (e) => { db.close(); reject(e.target.error); };
      });
    }
    async function autosaveGet(baseSha) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_STORE], 'readonly');
        const req = tx.objectStore(IDB_STORE).get(baseSha);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = (e) => { db.close(); reject(e.target.error); };
      });
    }
    async function autosaveDelete(baseSha) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        tx.objectStore(IDB_STORE).delete(baseSha);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = (e) => { db.close(); reject(e.target.error); };
      });
    }

    // 現状を .lpw 形式のオブジェクトにシリアライズ（仕様§6.1）
    async function serializeProject(baseFilename) {
      if (!basePdfBytes) throw new Error('ベースPDF未読込');
      // Base PDF Base64 はキャッシュ（autosave で毎回再エンコードしないため）
      if (!cachedBasePdfBase64) {
        cachedBasePdfBase64 = arrayBufferToBase64(basePdfBytes);
      }
      // SHA も再利用可能ならする（autosaveBaseSha がセット済ならそれ）
      const sha = autosaveBaseSha || await sha256Hex(basePdfBytes);
      const now = new Date().toISOString();
      return {
        format: 'lighting-plan-workspace',
        version: '1.0.0',
        metadata: {
          created_at: now,
          updated_at: now,
          app_version: 'PDF Compact (imgPlace)'
        },
        base_pdf: {
          filename: baseFilename || 'base.pdf',
          data_base64: cachedBasePdfBase64,
          sha256: sha,
          page_count: pageCount,
          page_sizes_mm: pageSizesMm.map(s => ({ width: s.width, height: s.height }))
        },
        image_library: imageLibrary.map(img => ({
          id: img.id,
          filename: img.filename,
          mime_type: img.mimeType,
          data_base64: (img.dataUrl && img.dataUrl.indexOf(',') >= 0)
            ? img.dataUrl.substring(img.dataUrl.indexOf(',') + 1)
            : '',
          original_width_px: img.originalWidthPx,
          original_height_px: img.originalHeightPx
        })),
        placements: placements.map(pl => {
          normalizeCaptions(pl);
          return {
            id: pl.id,
            page_index: pl.pageIndex,
            image_id: pl.imageId,
            x_mm: pl.xMm,
            y_mm: pl.yMm,
            width_mm: pl.widthMm,
            height_mm: pl.heightMm,
            aspect_locked: pl.aspectLocked !== false,
            captions: pl.captions || []
          };
        }),
        ui_state: {
          current_page_index: currentPageIndex,
          snap_enabled: snapEnabled,
          caption_font: captionFont
        },
        // カスタムセル（手動定義のスナップ矩形）。pageIndex キー → セル配列
        custom_cells_by_page: customCellsByPage
      };
    }

    // .lpw JSON から状態を完全復元
    async function loadProject(json) {
      if (!json || json.format !== 'lighting-plan-workspace') {
        throw new Error('.lpw ファイル形式が不正です');
      }
      if (!json.base_pdf || !json.base_pdf.data_base64) {
        throw new Error('ベースPDFデータが含まれていません');
      }
      // 既存状態をクリア（editorPanel も隠れる）
      clearBase();
      // ベースPDF復元 + Base64 キャッシュを既存値で初期化（再エンコード回避）
      cachedBasePdfBase64 = json.base_pdf.data_base64;
      basePdfBytes = base64ToArrayBuffer(json.base_pdf.data_base64);
      pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
      pageCount = pdfjsDoc.numPages;
      // autosave 用 SHA 確定（保存済値 or 再計算）
      autosaveBaseSha = json.base_pdf.sha256 || await sha256Hex(basePdfBytes);
      autosaveBaseFilename = (json.base_pdf.filename) || 'base.pdf';
      // ページサイズ: 保存値があれば使い、なければ再計算
      const savedSizes = json.base_pdf.page_sizes_mm;
      if (savedSizes && savedSizes.length === pageCount) {
        pageSizesMm = savedSizes.map(s => ({ width: s.width, height: s.height }));
      } else {
        pageSizesMm = [];
        for (let i = 1; i <= pageCount; i++) {
          const p = await pdfjsDoc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          pageSizesMm.push({ width: ptToMm(vp.width), height: ptToMm(vp.height) });
        }
      }
      // 画像ライブラリ復元
      imageLibrary = (json.image_library || []).map(img => ({
        id: img.id,
        filename: img.filename,
        mimeType: img.mime_type,
        dataUrl: 'data:' + (img.mime_type || 'image/jpeg') + ';base64,' + img.data_base64,
        originalWidthPx: img.original_width_px,
        originalHeightPx: img.original_height_px
      }));
      // libSeq を ID 衝突回避のため最大値に合わせる
      libSeq = imageLibrary.reduce((m, img) => {
        const match = /img_(\d+)/.exec(img.id || '');
        return match ? Math.max(m, parseInt(match[1], 10)) : m;
      }, libSeq);
      // 配置復元（旧 caption: 単一形式も captions: 配列に互換変換）
      placements = (json.placements || []).map(pl => ({
        id: pl.id,
        pageIndex: pl.page_index,
        imageId: pl.image_id,
        xMm: pl.x_mm,
        yMm: pl.y_mm,
        widthMm: pl.width_mm,
        heightMm: pl.height_mm,
        aspectLocked: pl.aspect_locked !== false,
        captions: pl.captions || (pl.caption ? [pl.caption] : [])
      }));
      plSeq = placements.reduce((m, pl) => {
        const match = /pl_(\d+)/.exec(pl.id || '');
        return match ? Math.max(m, parseInt(match[1], 10)) : m;
      }, plSeq);
      // UI 状態復元
      const ui = json.ui_state || {};
      currentPageIndex = (typeof ui.current_page_index === 'number') ? ui.current_page_index : 0;
      if (currentPageIndex >= pageCount) currentPageIndex = 0;
      snapEnabled = ui.snap_enabled !== false;
      if (ui.caption_font) captionFont = ui.caption_font;
      // カスタムセル復元（互換: 旧 .lpw には custom_cells_by_page が無い）
      customCellsByPage = {};
      if (json.custom_cells_by_page && typeof json.custom_cells_by_page === 'object') {
        for (const k of Object.keys(json.custom_cells_by_page)) {
          const arr = json.custom_cells_by_page[k];
          if (!Array.isArray(arr)) continue;
          customCellsByPage[k] = arr.map(c => ({
            xMm: c.xMm, yMm: c.yMm,
            widthMm: c.widthMm, heightMm: c.heightMm
          })).filter(c =>
            typeof c.xMm === 'number' && typeof c.yMm === 'number'
            && typeof c.widthMm === 'number' && typeof c.heightMm === 'number'
            && c.widthMm > 0 && c.heightMm > 0
          );
        }
      }
      // UI 表示
      editorPanel.style.display = '';
      filenameBar.style.display = '';
      actionBar.style.display = '';
      // 編集モード ON: hero+upload panel を隠す
      const modeImgPlaceEl2 = document.getElementById('modeImgPlace');
      if (modeImgPlaceEl2) modeImgPlaceEl2.classList.add('imgplace-editing');
      // コントロール反映
      updateSnapBtn();
      if (fontSelect) {
        const matchOpt = Array.from(fontSelect.options).find(o => o.value === captionFont);
        if (matchOpt) fontSelect.value = captionFont;
      }
      // 描画
      renderLibrary();
      await renderThumbnails();
      await renderCurrentPage();
      updateMeta(json.base_pdf.filename || '(復元PDF)');
      setStatus('プロジェクト復元完了: ' + (json.base_pdf.filename || '') + ' ・ ' + pageCount + 'ページ ・ 画像' + imageLibrary.length + '個 ・ 配置' + placements.length + '個');
      // エディタにスクロール
      requestAnimationFrame(() => {
        editorPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // ----- autosave: debounce で IndexedDB に保存 -----
    function scheduleAutosave() {
      if (!basePdfBytes || !autosaveBaseSha) return; // ベースPDFなしなら保存対象なし
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(async () => {
        autosaveTimer = null;
        try {
          const json = await serializeProject(autosaveBaseFilename);
          await autosavePut({
            baseSha: autosaveBaseSha,
            json: json,
            savedAt: Date.now(),
            baseFilename: autosaveBaseFilename
          });
        } catch (e) {
          console.warn('[imgPlace] autosave 失敗:', e);
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    }
    function cancelAutosaveTimer() {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
    }

    // 起動/PDF読込時に同一SHAの autosave があれば復元提案
    async function checkAndOfferRestore(sha) {
      if (!sha) return false;
      let record;
      try { record = await autosaveGet(sha); }
      catch (e) { console.warn('[imgPlace] autosave 取得失敗:', e); return false; }
      if (!record || !record.json) return false;
      // 直近 10秒以内の保存はスキップ（同セッション中の周回防止）
      if (Date.now() - (record.savedAt || 0) < 10000) return false;
      const date = new Date(record.savedAt);
      const dateStr = date.toLocaleString('ja-JP');
      const placementCount = (record.json.placements || []).length;
      const libCount = (record.json.image_library || []).length;
      const msg = 'このベースPDFに前回作業の自動保存データがあります。\n'
                + '保存時刻: ' + dateStr + '\n'
                + '配置: ' + placementCount + '個 / 画像: ' + libCount + '個\n\n'
                + '復元しますか？「いいえ」で現在の作業を続行します。';
      if (window.confirm(msg)) {
        try {
          await loadProject(record.json);
          return true;
        } catch (e) {
          console.error('[imgPlace] 自動保存復元失敗:', e);
          setStatus('自動保存の復元失敗: ' + (e.message || e), 'error');
        }
      } else {
        // 拒否されたら同SHAの autosave を削除（毎回聞かない）
        try { await autosaveDelete(sha); } catch (e) { /* 無視 */ }
      }
      return false;
    }

    // ----- プロジェクト保存ボタン -----
    if (saveProjectBtn) {
      saveProjectBtn.addEventListener('click', async () => {
        if (!basePdfBytes) {
          setStatus('ベースPDFが読み込まれていません', 'error');
          return;
        }
        // ファイル名: 入力欄の値（無ければ 'project'）+ タイムスタンプ。prompt() は iOS 互換性のため非使用
        const userName = (document.getElementById('imgPlaceFilenameInput') || {}).value || '';
        const baseName = (userName.trim() || 'project').replace(/[\\/:*?"<>|]/g, '');
        let finalName = (typeof appendTimestamp === 'function')
          ? appendTimestamp(baseName, 'imgPlaceFilenameTs')
          : baseName;
        // iOS は .lpw を未知拡張子と判定して .txt を勝手に付与するため、iOS では .json で出力
        const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const ext = isIos ? '.json' : '.lpw';
        if (!new RegExp(ext.replace('.', '\\.') + '$', 'i').test(finalName)) finalName += ext;
        try {
          const obj = await serializeProject((userName || 'base') + '.pdf');
          const json = JSON.stringify(obj);
          const blob = new Blob([json], { type: 'application/json' });
          // File System Access API: ブラウザ対応していれば「名前を付けて保存」ダイアログ
          // (Chrome/Edge/Opera 等で利用可、Firefox/Safari/iOS は未対応 → 従来DLに fallback)
          let saved = false;
          if (typeof window.showSaveFilePicker === 'function' && !isIos) {
            try {
              const handle = await window.showSaveFilePicker({
                suggestedName: finalName,
                types: [{
                  description: 'PDF Compact プロジェクト',
                  accept: { 'application/json': ['.lpw', '.json'] }
                }]
              });
              const writable = await handle.createWritable();
              await writable.write(blob);
              await writable.close();
              saved = true;
              setStatus('プロジェクト保存完了: ' + (handle.name || finalName));
            } catch (e) {
              // ユーザーキャンセル (AbortError) はそっと終わる、それ以外は fallback DL
              if (e && e.name === 'AbortError') return;
              console.warn('[imgPlace] showSaveFilePicker 失敗 → 通常DLに fallback:', e);
            }
          }
          if (!saved) {
            await downloadOrShare(blob, finalName);
            setStatus('保存処理を実行しました: ' + finalName + (isIos ? '（iOSは共有シートから「ファイルに保存」、本ツールは .json も読込可）' : ''));
          }
        } catch (err) {
          console.error('[imgPlace] 保存失敗:', err);
          setStatus('保存に失敗: ' + (err.message || err), 'error');
        }
      });
    }

    // ----- プロジェクト読込ボタン -----
    if (loadProjectBtn && loadProjectInput) {
      loadProjectBtn.addEventListener('click', () => loadProjectInput.click());
      loadProjectInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          setStatus('読み込み中…');
          const text = await file.text();
          const json = JSON.parse(text);
          await loadProject(json);
        } catch (err) {
          console.error('[imgPlace] 読込失敗:', err);
          setStatus('読込失敗: ' + (err.message || err), 'error');
        } finally {
          e.target.value = ''; // 同じファイル再選択を許可
        }
      });
    }

    // ----- 日本語フォント (Noto Sans JP) を CDN から取得（初回のみ） -----
    // 公式 notofonts/noto-cjk の SubsetOTF JP（各 ~4.5MB の OTF、フォント内部名が正しい）
    // @fontsource の woff は内部メタデータが Thin 表記になり Acrobat 警告が出るため不採用
    const NOTO_REGULAR_URL = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf';
    const NOTO_BOLD_URL    = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/JP/NotoSansJP-Bold.otf';
    // タイムアウト付き fetch
    async function fetchWithTimeout(url, timeoutMs) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.arrayBuffer();
      } finally {
        clearTimeout(t);
      }
    }
    // 必要なフォントだけ並行取得（Bold は太字キャプションがある時のみ）
    async function loadCaptionFontsIfNeeded(needBold) {
      const tasks = [];
      if (!cachedNotoRegular) {
        tasks.push(fetchWithTimeout(NOTO_REGULAR_URL, 60000)
          .then(buf => { cachedNotoRegular = buf; })
          .catch(err => { throw new Error('Noto Sans JP Regular 取得失敗: ' + (err.message || err)); }));
      }
      if (needBold && !cachedNotoBold) {
        tasks.push(fetchWithTimeout(NOTO_BOLD_URL, 60000)
          .then(buf => { cachedNotoBold = buf; })
          .catch(err => { throw new Error('Noto Sans JP Bold 取得失敗: ' + (err.message || err)); }));
      }
      if (tasks.length === 0) return;
      setStatus('Noto Sans JP を取得中… (' + tasks.length + ' ファイル並行ダウンロード)');
      await Promise.all(tasks);
    }

    // ----- PDF出力: ベースPDF + 画像 + キャプション（画像化方式） -----
    // キャプションは Canvas に描画→PNG→embedPng で焼き込み（フォント埋め込みの相性問題を完全回避）
    // → display と同じフォントで描画される、文字検索不可だが互換性は最強
    async function generatePdfOutput() {
      if (!basePdfBytes) throw new Error('ベースPDF未読込');
      if (!window.PDFLib) throw new Error('pdf-lib が読み込まれていません');
      const { PDFDocument, degrees } = window.PDFLib;
      const pdfDoc = await PDFDocument.load(basePdfBytes.slice(0), { ignoreEncryption: true });

      // 画像 embed をキャッシュ（同じ画像を複数配置時に再 embed 回避）
      const embedCache = {};
      async function getEmbedded(img) {
        if (embedCache[img.id]) return embedCache[img.id];
        const dataB64 = img.dataUrl.substring(img.dataUrl.indexOf(',') + 1);
        const bytes = base64ToArrayBuffer(dataB64);
        let embedded;
        if (/png/i.test(img.mimeType || '')) {
          embedded = await pdfDoc.embedPng(bytes);
        } else {
          embedded = await pdfDoc.embedJpg(bytes);
        }
        embedCache[img.id] = embedded;
        return embedded;
      }

      // キャプションを Canvas で描画→PNG bytes に変換し PDF に embed
      // maxWidthMm: 最大幅mm(=配置幅)。超える長文はプレビュー(nowrap+overflow:hidden)と同様に切り詰める
      // 戻り値: { pdfImage, widthMm, heightMm }
      async function captionToPdfImage(cap, sizeMm, maxWidthMm) {
        // 300dpi相当の解像度で crispness 確保（1mm ≈ 11.8px）
        const intFontPx = Math.max(48, Math.round(sizeMm * 12));
        const fontDecl = (cap.bold ? 'bold ' : '') + intFontPx + 'px ' + (captionFont || 'sans-serif');
        // 文字幅計測
        const mCanvas = document.createElement('canvas');
        const mctx = mCanvas.getContext('2d');
        mctx.font = fontDecl;
        const metrics = mctx.measureText(cap.text);
        const textW = Math.max(2, Math.ceil(metrics.width));
        const ascent  = metrics.actualBoundingBoxAscent  || (intFontPx * 0.85);
        const descent = metrics.actualBoundingBoxDescent || (intFontPx * 0.25);
        const totalH = Math.max(2, Math.ceil(ascent + descent));
        // 実描画用 canvas
        // 配置幅(maxWidthMm)を超える長文はプレビューと同様に canvas 幅で切り詰める
        // (px↔mm 換算: totalH px が sizeMm*1.15 mm に対応。左から描画し、はみ出しは自動クリップ)
        let drawWidthPx = textW;
        if (typeof maxWidthMm === 'number' && maxWidthMm > 0) {
          const maxWidthPx = Math.max(2, Math.floor(totalH * (maxWidthMm / (sizeMm * 1.15))));
          if (drawWidthPx > maxWidthPx) drawWidthPx = maxWidthPx;
        }
        const canvas = document.createElement('canvas');
        canvas.width = drawWidthPx;
        canvas.height = totalH;
        const ctx = canvas.getContext('2d');
        ctx.font = fontDecl;
        ctx.fillStyle = '#000';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(cap.text, 0, ascent);
        // PNG → embedPng
        const dataUrl = canvas.toDataURL('image/png');
        const bytes = base64ToArrayBuffer(dataUrl.split(',')[1]);
        const pdfImage = await pdfDoc.embedPng(bytes);
        // mm 換算: テキスト高さ = sizeMm * 1.15（display と整合）。幅は切り詰め後の canvas 幅から算出
        const heightMm = sizeMm * 1.15;
        const widthMm = (canvas.width / totalH) * heightMm;
        return { pdfImage, widthMm, heightMm };
      }

      // ----- /Rotate 付きページ対応の座標変換 -----
      // 数学の本体は 00-core の共有 viewportRectToPageDrawOpts(pt単位)に一本化した。
      // ここは mm→pt 換算するだけの薄いラッパー(配置座標 pl.* は mm 管理のため)。
      // 検証は tests/geometry.spec.js(回転4方向 × CropBox 有無のゴールデン)。
      function viewportRectToDrawOpts(page, xMm, yMm, wMm, hMm) {
        return viewportRectToPageDrawOpts(page, xMm * PT_PER_MM, yMm * PT_PER_MM, wMm * PT_PER_MM, hMm * PT_PER_MM);
      }

      const totalPages = pdfDoc.getPageCount();
      for (const pl of placements) {
        if (pl.pageIndex < 0 || pl.pageIndex >= totalPages) continue;
        const img = imageLibrary.find(im => im.id === pl.imageId);
        if (!img) continue;
        const page = pdfDoc.getPage(pl.pageIndex);
        const embedded = await getEmbedded(img);

        // 画像描画: 見た目の矩形(mm/左上) → 回転補正込みの drawImage 引数
        page.drawImage(embedded, viewportRectToDrawOpts(page, pl.xMm, pl.yMm, pl.widthMm, pl.heightMm));

        // キャプション描画（renderPlacements と同じスタッキング。座標は全て見た目(viewport)のmmで組み、最後に同じ変換を通す）
        normalizeCaptions(pl);
        if (pl.captions && pl.captions.length > 0) {
          let cursorBelow = pl.yMm + pl.heightMm + 3;
          let cursorAbove = pl.yMm - 3;
          for (const cap of pl.captions) {
            if (!cap.text || !cap.text.trim()) continue;
            const sizeMm    = CAPTION_SIZE_MM[cap.size || 'medium'] || 4;
            const stackHMm  = sizeMm * 1.15;
            const pos       = cap.position || 'below';
            let topYMm;
            if (pos === 'above') {
              topYMm = cursorAbove - stackHMm;
              cursorAbove = topYMm - 1;
            } else {
              topYMm = cursorBelow;
              cursorBelow += stackHMm + 1;
            }
            // Canvas で画像化(配置幅で切り詰め: プレビューの overflow:hidden と整合)
            const capImg = await captionToPdfImage(cap, sizeMm, pl.widthMm);
            // 揃え: placement 幅内での配置(見た目のmmで計算)
            const align = cap.align || 'center';
            let xCapMm;
            if (align === 'left')       xCapMm = pl.xMm;
            else if (align === 'right') xCapMm = pl.xMm + pl.widthMm - capImg.widthMm;
            else                        xCapMm = pl.xMm + (pl.widthMm - capImg.widthMm) / 2;
            page.drawImage(capImg.pdfImage, viewportRectToDrawOpts(page, xCapMm, topYMm, capImg.widthMm, capImg.heightMm));
          }
        }
      }
      return await pdfDoc.save({ useObjectStreams: true });
    }

    // ----- PDF出力ボタン -----
    // 1タップで生成 + DL。downloadOrShare 内で Web Share API 利用可なら共有シート、
    // 不可なら標準 <a download> にフォールバック（iOS でも fallback 経路で動く）
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener('click', async () => {
        if (!basePdfBytes) {
          setStatus('ベースPDFが読み込まれていません', 'error');
          return;
        }
        // ファイル名: 入力欄の値（無ければ 'output'）+ タイムスタンプ
        const userName = (document.getElementById('imgPlaceFilenameInput') || {}).value || '';
        const baseName = (userName.trim() || 'output').replace(/[\\/:*?"<>|]/g, '');
        let finalName = (typeof appendTimestamp === 'function')
          ? appendTimestamp(baseName, 'imgPlaceFilenameTs')
          : baseName;
        if (!/\.pdf$/i.test(finalName)) finalName += '.pdf';
        try {
          setStatus('PDF生成中…');
          exportPdfBtn.disabled = true;
          const bytes = await generatePdfOutput();
          let blob = new Blob([bytes], { type: 'application/pdf' });
          // v3.6.0: 出力前メタデータ除去 (imgPlace は常にPDF・ガード不要)
          if (window.PdfSanitize) blob = await window.PdfSanitize.process(blob);
          await downloadOrShare(blob, finalName);
          setStatus('PDF出力完了: ' + finalName + '（画像 ' + placements.length + ' 個焼き込み済）');
        } catch (err) {
          console.error('[imgPlace] PDF出力失敗:', err);
          setStatus('PDF出力失敗: ' + (err.message || err), 'error');
        } finally {
          exportPdfBtn.disabled = false;
        }
      });
    }

    // ----- クリアボタン -----
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearBase();
      });
    }

    // ----- 順次配置トグルボタン -----
    const placeQueueBtn = document.getElementById('imgPlacePlaceQueueBtn');
    if (placeQueueBtn) {
      placeQueueBtn.addEventListener('click', () => {
        if (placeQueueMode) {
          stopPlaceQueueMode('順次配置キャンセル');
        } else {
          startPlaceQueueMode();
        }
      });
    }

    // ----- 追加PDF ボタン (ファイル選択 → 末尾にマージ) -----
    const addPdfBtn = document.getElementById('imgPlaceAddPdfBtn');
    const addPdfInput = document.getElementById('imgPlaceAddPdfInput');
    if (addPdfBtn && addPdfInput) {
      addPdfBtn.addEventListener('click', () => addPdfInput.click());
      addPdfInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        await loadBasePdf(file); // basePdfBytes 既存 → 自動で append モード
        e.target.value = ''; // 同じファイル再選択許可
      });
    }
    // editor 全域に PDF ドロップ受付 (canvas-wrap + 周辺) → 末尾追加
    if (canvasFrame) {
      const editorEl = document.querySelector('#modeImgPlace .imgplace-editor');
      const handlePdfDrop = async (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
        const file = e.dataTransfer.files[0];
        if (!file || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) return;
        e.preventDefault();
        e.stopPropagation();
        if (editorEl) editorEl.classList.remove('imgplace-pdf-dragover');
        await loadBasePdf(file); // basePdfBytes 既存なら append
      };
      const handlePdfDragOver = (e) => {
        // PDF ファイルドラッグ時のみハイライト (画像ドラッグは既存 handler 任せ)
        if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(it =>
            it.kind === 'file' && (it.type === 'application/pdf'))) {
          e.preventDefault();
          if (editorEl) editorEl.classList.add('imgplace-pdf-dragover');
        }
      };
      const handlePdfDragLeave = (e) => {
        if (editorEl && e.relatedTarget && !editorEl.contains(e.relatedTarget)) {
          editorEl.classList.remove('imgplace-pdf-dragover');
        }
      };
      if (editorEl) {
        editorEl.addEventListener('drop', handlePdfDrop);
        editorEl.addEventListener('dragover', handlePdfDragOver);
        editorEl.addEventListener('dragleave', handlePdfDragLeave);
      }
    }

    // ----- タイムスタンプトグル -----
    if (typeof setupTimestampToggle === 'function') {
      setupTimestampToggle('imgPlaceFilenameTs', 'imgPlaceFilenameTsPreview');
    }
  })();

  /* ============================================================
   * 黒塗り(墨消し)モード — v3.8.0 Phase1 (描画まで・出力は次版)
   * 自己完結 IIFE。window.pdfjsLib のみ参照。既存モードに非依存。
   * 矩形は「ページ比率(0..1)」で保持し解像度非依存。
   * ============================================================ */
