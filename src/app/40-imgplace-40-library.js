    async function renderThumbnails() {
      pageList.innerHTML = '';
      for (let i = 0; i < pageCount; i++) {
        const wrap = document.createElement('div');
        let cls = 'page-thumb-wrap';
        if (i === currentPageIndex) cls += ' active';
        if (pageSelectedIndices.has(i)) cls += ' page-multi-selected';
        wrap.className = cls;
        wrap.dataset.pageIndex = i;
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('aria-label', 'ページ ' + (i + 1));

        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.className = 'page-thumb';

        const label = document.createElement('div');
        label.className = 'page-thumb-label';
        label.textContent = 'P.' + (i + 1);

        // × 削除ボタン (1ページしか無い時は出さない)
        if (pageCount > 1) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'page-thumb-delete';
          delBtn.textContent = '×';
          const pageIdx = i; // closure
          // ボタンのタイトル: マルチ選択中なら一括件数を表示
          const updateDelTitle = () => {
            if (pageSelectedIndices.size > 1 && pageSelectedIndices.has(pageIdx)) {
              delBtn.title = '選択中の ' + pageSelectedIndices.size + ' ページを一括削除';
            } else {
              delBtn.title = 'このページを削除';
            }
          };
          updateDelTitle();
          delBtn.setAttribute('aria-label', 'ページ ' + (i + 1) + ' を削除');
          delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (pageSelectedIndices.size > 1 && pageSelectedIndices.has(pageIdx)) {
              await deleteMultiplePages(Array.from(pageSelectedIndices));
            } else {
              await deletePage(pageIdx);
            }
          });
          wrap.appendChild(delBtn);
        }

        wrap.appendChild(thumbCanvas);
        wrap.appendChild(label);
        pageList.appendChild(wrap);

        try {
          const page = await pdfjsDoc.getPage(i + 1);
          const vp = page.getViewport({ scale: THUMB_SCALE });
          thumbCanvas.width = Math.ceil(vp.width);
          thumbCanvas.height = Math.ceil(vp.height);
          await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: vp }).promise;
        } catch (err) {
          console.warn('[imgPlace] サムネ描画失敗 P.' + (i + 1), err);
        }

        const handleSelect = (e) => {
          const isCtrl = e && (e.ctrlKey || e.metaKey);
          const isShift = e && e.shiftKey;
          if (isCtrl) {
            // トグル選択 (currentPageIndex は変えない)
            if (pageSelectedIndices.has(i)) pageSelectedIndices.delete(i);
            else pageSelectedIndices.add(i);
            pageLastClickedIndex = i;
            updatePageSelectionDom();
            return;
          }
          if (isShift && pageLastClickedIndex !== null) {
            // 範囲選択
            const lo = Math.min(pageLastClickedIndex, i);
            const hi = Math.max(pageLastClickedIndex, i);
            for (let k = lo; k <= hi; k++) pageSelectedIndices.add(k);
            updatePageSelectionDom();
            return;
          }
          // 通常: 選択クリア → currentPage 切替
          pageSelectedIndices.clear();
          pageLastClickedIndex = i;
          updatePageSelectionDom();
          if (i === currentPageIndex) return;
          currentPageIndex = i;
          pageList.querySelectorAll('.page-thumb-wrap').forEach((el, idx) => {
            el.classList.toggle('active', idx === currentPageIndex);
          });
          renderCurrentPage();
          // 順次配置モード中ならステータス再表示
          if (placeQueueMode && placeQueue.length > 0) {
            setStatus('順次配置: P.' + (currentPageIndex + 1) + ' クリックで次を配置 (残り ' + placeQueue.length + ' 枚 / Esc キャンセル)');
          }
        };
        wrap.addEventListener('click', handleSelect);
        wrap.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSelect(e);
          }
        });
      }
      // サムネ生成後、配置画像のオーバーレイも非同期で描画開始
      schedulePlacementOverlayAll();
    }

    // ----- サムネに配置画像を反映 (PDFレイヤー上に placements を描き重ね) -----
    // pre-load した HTMLImageElement のキャッシュ (imageId → HTMLImage)
    const thumbImgCache = new Map();
    function loadImageForThumb(imageId) {
      if (thumbImgCache.has(imageId)) {
        const cached = thumbImgCache.get(imageId);
        if (cached.complete) return Promise.resolve(cached);
      }
      const img = imageLibrary.find(im => im.id === imageId);
      if (!img || !img.dataUrl) return Promise.resolve(null);
      return new Promise((resolve) => {
        const el = new Image();
        el.onload = () => { thumbImgCache.set(imageId, el); resolve(el); };
        el.onerror = () => resolve(null);
        el.src = img.dataUrl;
      });
    }
    // 指定ページのサムネに、PDFレイヤー描画 → placements を上に drawImage
    async function renderThumbWithPlacements(pageIndex) {
      if (!pdfjsDoc || !pageList) return;
      const wrap = pageList.querySelector('.page-thumb-wrap[data-page-index="' + pageIndex + '"]');
      if (!wrap) return;
      const canvas = wrap.querySelector('canvas.page-thumb');
      if (!canvas) return;
      try {
        const page = await pdfjsDoc.getPage(pageIndex + 1);
        const vp = page.getViewport({ scale: THUMB_SCALE });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const pageSize = pageSizesMm[pageIndex];
        if (!pageSize) return;
        const scale = vp.width / pageSize.width;
        const placementsOnPage = placements.filter(p => p.pageIndex === pageIndex);
        for (const pl of placementsOnPage) {
          const imgEl = await loadImageForThumb(pl.imageId);
          if (!imgEl) continue;
          const x = pl.xMm * scale;
          const y = pl.yMm * scale;
          const w = pl.widthMm * scale;
          const h = pl.heightMm * scale;
          try { ctx.drawImage(imgEl, x, y, w, h); } catch (_) {}
        }
      } catch (e) {
        // pdf.js のレンダ競合等は無視 (次回更新で復帰)
      }
    }
    // debounce 付きで複数ページ同時更新
    let thumbUpdateQueue = new Set();
    let thumbUpdateTimer = null;
    function queueThumbUpdate(pageIndex) {
      if (typeof pageIndex !== 'number' || pageIndex < 0 || pageIndex >= pageCount) return;
      thumbUpdateQueue.add(pageIndex);
      if (thumbUpdateTimer) clearTimeout(thumbUpdateTimer);
      thumbUpdateTimer = setTimeout(async () => {
        const list = Array.from(thumbUpdateQueue);
        thumbUpdateQueue.clear();
        thumbUpdateTimer = null;
        for (const i of list) await renderThumbWithPlacements(i);
      }, 350);
    }
    // 全ページサムネ更新 (renderThumbnails の最後に呼ばれる)
    function schedulePlacementOverlayAll() {
      // 既存サムネをまず PDFのみで素早く表示 → 後で placements を上書き描画
      // 全ページ即時更新 (debounce 通さない)
      (async () => {
        for (let i = 0; i < pageCount; i++) {
          // placements がある or current page のみ更新 (空ページは PDF だけで十分)
          if (i === currentPageIndex || placements.some(p => p.pageIndex === i)) {
            await renderThumbWithPlacements(i);
          }
        }
      })();
    }

    // ----- ページ選択 DOM 更新 (再描画せずクラス切替だけ) -----
    function updatePageSelectionDom() {
      if (!pageList) return;
      pageList.querySelectorAll('.page-thumb-wrap').forEach((el) => {
        const idx = parseInt(el.dataset.pageIndex, 10);
        el.classList.toggle('page-multi-selected', pageSelectedIndices.has(idx));
      });
    }

    // ----- 複数ページ一括削除 -----
    async function deleteMultiplePages(indices) {
      if (!basePdfBytes || !indices || indices.length === 0) return;
      if (indices.length >= pageCount) {
        setStatus('全ページ選択中は一括削除できません (最低1ページ残す)', 'error');
        // 選択も解除して × ボタンのタイトル「N ページ一括削除」誤誘導を消す
        pageSelectedIndices.clear();
        updatePageSelectionDom();
        return;
      }
      // 関連配置/セル件数を集計
      const totalPlaces = placements.filter(p => indices.indexOf(p.pageIndex) !== -1).length;
      const totalCells = indices.reduce((sum, idx) => sum + (customCellsByPage[idx] || []).length, 0);
      let msg = indices.length + ' ページを一括削除しますか?';
      if (totalPlaces || totalCells) {
        msg += '\n(配置画像 ' + totalPlaces + ' 枚 / カスタムセル ' + totalCells + ' 個 もまとめて削除)';
      }
      if (!confirm(msg)) return;
      try {
        const PDFLib = window.PDFLib;
        const doc = await PDFLib.PDFDocument.load(basePdfBytes);
        // 高い index から削除しないと インデックスがずれる
        const sortedDesc = indices.slice().sort((a, b) => b - a);
        for (const idx of sortedDesc) doc.removePage(idx);
        basePdfBytes = (await doc.save()).buffer;
        pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
        pageCount = pdfjsDoc.numPages;
        // pageSizesMm を index 高い順に splice
        for (const idx of sortedDesc) pageSizesMm.splice(idx, 1);
        // 配置: 削除対象ページのものは破棄、それ以外は新インデックスにマップ
        // 新インデックス = 旧インデックス - (自分より小さい削除index の数)
        const sortedAsc = indices.slice().sort((a, b) => a - b);
        const countDeletedBefore = (oldIdx) => sortedAsc.filter(d => d < oldIdx).length;
        placements = placements
          .filter(p => indices.indexOf(p.pageIndex) === -1)
          .map(p => Object.assign({}, p, { pageIndex: p.pageIndex - countDeletedBefore(p.pageIndex) }));
        // customCellsByPage 同様
        const newCells = {};
        for (const k of Object.keys(customCellsByPage)) {
          const ki = parseInt(k, 10);
          if (indices.indexOf(ki) !== -1) continue;
          const newK = ki - countDeletedBefore(ki);
          newCells[newK] = customCellsByPage[k];
        }
        customCellsByPage = newCells;
        // currentPageIndex 調整
        if (indices.indexOf(currentPageIndex) !== -1) {
          // 削除されたページにいた場合、残ったページの中で一番近いものへ
          currentPageIndex = Math.max(0, Math.min(currentPageIndex - countDeletedBefore(currentPageIndex), pageCount - 1));
        } else {
          currentPageIndex -= countDeletedBefore(currentPageIndex);
        }
        // 選択クリア
        pageSelectedIndices.clear();
        pageLastClickedIndex = null;
        clearSelection();
        cachedBasePdfBase64 = null;
        autosaveBaseSha = await sha256Hex(basePdfBytes);
        await renderThumbnails();
        await renderCurrentPage();
        setStatus(indices.length + ' ページを削除 (残り ' + pageCount + ' ページ)');
        scheduleAutosave();
      } catch (err) {
        console.error('[imgPlace] 一括削除失敗:', err);
        setStatus('一括削除失敗: ' + (err.message || err), 'error');
      }
    }

    // ----- ページラバーバンド (リスト空きエリアからドラッグで複数選択) -----
    let pagesRubberState = null;
    if (pageList) {
      pageList.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // ターゲットが pageList 自身か、その直下のテキストノードクリックの場合
        if (e.target !== pageList) return;
        const rect = pageList.getBoundingClientRect();
        const startX = e.clientX - rect.left + pageList.scrollLeft;
        const startY = e.clientY - rect.top + pageList.scrollTop;
        const band = document.createElement('div');
        band.className = 'imgplace-pages-rubberband';
        pageList.appendChild(band);
        pagesRubberState = {
          startX, startY, curX: startX, curY: startY,
          band: band,
          pointerId: e.pointerId,
          additive: e.ctrlKey || e.metaKey || e.shiftKey,
          baselineSet: new Set(pageSelectedIndices)
        };
        try { pageList.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      pageList.addEventListener('pointermove', (e) => {
        if (!pagesRubberState) return;
        const rect = pageList.getBoundingClientRect();
        pagesRubberState.curX = e.clientX - rect.left + pageList.scrollLeft;
        pagesRubberState.curY = e.clientY - rect.top + pageList.scrollTop;
        const s = pagesRubberState;
        const xL = Math.min(s.startX, s.curX);
        const yT = Math.min(s.startY, s.curY);
        const xR = Math.max(s.startX, s.curX);
        const yB = Math.max(s.startY, s.curY);
        s.band.style.left = xL + 'px';
        s.band.style.top = yT + 'px';
        s.band.style.width = (xR - xL) + 'px';
        s.band.style.height = (yB - yT) + 'px';
        // 各ページサムネと交差判定
        const r1 = {
          left: rect.left + xL - pageList.scrollLeft,
          top: rect.top + yT - pageList.scrollTop,
          right: rect.left + xR - pageList.scrollLeft,
          bottom: rect.top + yB - pageList.scrollTop
        };
        const newSel = s.additive ? new Set(s.baselineSet) : new Set();
        pageList.querySelectorAll('.page-thumb-wrap').forEach(el => {
          const ir = el.getBoundingClientRect();
          const hit = !(ir.right < r1.left || ir.left > r1.right || ir.bottom < r1.top || ir.top > r1.bottom);
          if (hit) {
            const idx = parseInt(el.dataset.pageIndex, 10);
            if (!isNaN(idx)) newSel.add(idx);
          }
        });
        pageSelectedIndices = newSel;
        updatePageSelectionDom();
      });
      const endPagesRubber = () => {
        if (!pagesRubberState) return;
        if (pagesRubberState.band && pagesRubberState.band.parentNode) {
          pagesRubberState.band.parentNode.removeChild(pagesRubberState.band);
        }
        pagesRubberState = null;
        if (pageSelectedIndices.size > 1) {
          setStatus(pageSelectedIndices.size + ' ページ選択中 (× で一括削除 / Esc で解除)');
        }
      };
      pageList.addEventListener('pointerup', endPagesRubber);
      pageList.addEventListener('pointercancel', endPagesRubber);
    }

    // ----- ドロップゾーン -----
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadBasePdf(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        loadBasePdf(e.target.files[0]);
        e.target.value = ''; // 同じファイル再選択を許可
      }
    });

    // ----- 画像読込 -----
    // JPEG の SOF マーカーから生のピクセル寸法を取得（EXIF orientation適用前の元寸法）
    function getJpegRawDimensions(buffer) {
      try {
        const view = new DataView(buffer);
        if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return null;
        let offset = 2;
        while (offset < view.byteLength - 1) {
          if (view.getUint8(offset) !== 0xFF) return null;
          const marker = view.getUint16(offset, false);
          offset += 2;
          // SOF0-SOF15 (0xFFC0-0xFFCF) 除く DHT(0xFFC4)・JPG(0xFFC8)・DAC(0xFFCC)
          if (marker >= 0xFFC0 && marker <= 0xFFCF
              && marker !== 0xFFC4 && marker !== 0xFFC8 && marker !== 0xFFCC) {
            if (offset + 7 > view.byteLength) return null;
            const height = view.getUint16(offset + 3, false);
            const width = view.getUint16(offset + 5, false);
            return { width: width, height: height };
          } else {
            if ((marker & 0xFF00) !== 0xFF00) return null;
            const segLen = view.getUint16(offset, false);
            offset += segLen;
          }
        }
      } catch (e) {
        console.warn('[imgPlace] JPEG SOF parse error:', e);
      }
      return null;
    }

    // EXIF orientation は 00-core の共有 readExifOrientation に委譲(等価性は tests/exif.spec.js)。
    // 1=正、3=180°、6=90°CW、8=90°CCW、他。範囲外/失敗は 1(下流の switch も 1 扱い)。
    function getJpegOrientation(buffer) {
      return readExifOrientation(buffer);
    }

    // 画像読込: 'from-image' で正規化済みbitmap取得、SOF寸法と比較して
    // bitmap が raw なら手動回転、auto-rotated ならそのまま使う（両ケース対応）
    async function loadImageFile(file) {
      if (!file) throw new Error('ファイルが空です');
      const isOkType = ACCEPTED_IMG_TYPES.indexOf(file.type) >= 0
        || (file.name && ACCEPTED_IMG_EXT.test(file.name));
      if (!isOkType) throw new Error(file.name + ' はJPG/PNGではありません');
      if (file.size > MAX_IMG_BYTES) throw new Error(file.name + ' は20MBを超えています');
      const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
      const mimeType = isPng ? 'image/png' : 'image/jpeg';

      const buffer = await file.arrayBuffer();
      const orientation = isPng ? 1 : getJpegOrientation(buffer);
      const sofDims = isPng ? null : getJpegRawDimensions(buffer);

      // bitmap 取得（imageOrientation: 'from-image' を試す。ブラウザによっては効かない）
      let source = null, sourceW = 0, sourceH = 0;
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        source = bitmap;
        sourceW = bitmap.width;
        sourceH = bitmap.height;
      } catch (_e) {
        try {
          // options 非対応の古いブラウザ
          const bitmap = await createImageBitmap(file);
          source = bitmap;
          sourceW = bitmap.width;
          sourceH = bitmap.height;
        } catch (_e2) {
          // 最終フォールバック: Image()
          const blob = new Blob([buffer], { type: mimeType });
          const blobUrl = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error(file.name + ' を画像として解釈できませんでした'));
            im.src = blobUrl;
          });
          URL.revokeObjectURL(blobUrl);
          source = img;
          sourceW = img.naturalWidth;
          sourceH = img.naturalHeight;
        }
      }

      // bitmap が raw か auto-rotated か判定
      // - 一致(sourceW===sofW && sourceH===sofH) → ブラウザが回転してない → 手動で適用
      // - 入れ替わり(sourceW===sofH && sourceH===sofW) → 既に auto-rotated → そのまま使う
      let bitmapIsRaw = false;
      if (sofDims && orientation >= 5 && orientation <= 8) {
        if (sourceW === sofDims.width && sourceH === sofDims.height) {
          bitmapIsRaw = true; // 'from-image' が効かなかった
        }
      }
      // 180°/flip(orient 2,3,4)は dim 一致判定できないので、'from-image' が動いた前提で何もしない

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let canvasW, canvasH;

      if (bitmapIsRaw) {
        // bitmap は生ピクセル → 手動でEXIF回転を適用
        const swap = orientation >= 5 && orientation <= 8;
        canvasW = swap ? sourceH : sourceW;
        canvasH = swap ? sourceW : sourceH;
        canvas.width = canvasW;
        canvas.height = canvasH;
        switch (orientation) {
          case 3: ctx.translate(canvasW, canvasH); ctx.rotate(Math.PI); break;
          case 6: ctx.translate(canvasW, 0); ctx.rotate(0.5 * Math.PI); break;
          case 8: ctx.translate(0, canvasH); ctx.rotate(-0.5 * Math.PI); break;
          case 2: ctx.translate(canvasW, 0); ctx.scale(-1, 1); break;
          case 4: ctx.translate(0, canvasH); ctx.scale(1, -1); break;
          case 5: ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1); break;
          case 7: ctx.translate(canvasW, 0); ctx.rotate(0.5 * Math.PI); ctx.scale(-1, 1); break;
        }
        ctx.drawImage(source, 0, 0, sourceW, sourceH);
      } else {
        // bitmap は既に正しい向き → そのまま canvas にコピー
        canvasW = sourceW;
        canvasH = sourceH;
        canvas.width = canvasW;
        canvas.height = canvasH;
        ctx.drawImage(source, 0, 0);
      }
      if (source.close) source.close();

      const dataUrl = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
      return {
        id: 'img_' + (++libSeq),
        filename: file.name,
        mimeType: mimeType,
        dataUrl: dataUrl,
        originalWidthPx: canvasW,
        originalHeightPx: canvasH
      };
    }

    async function addImagesFromFiles(fileListLike) {
      const files = Array.from(fileListLike || []);
      if (!files.length) return;
      const errors = [];
      for (const f of files) {
        try {
          const meta = await loadImageFile(f);
          imageLibrary.push(meta);
        } catch (err) {
          errors.push(err.message || String(err));
        }
      }
      renderLibrary();
      if (errors.length) {
        setStatus('一部読み込めず: ' + errors.join(' / '), 'error');
      }
    }

    // ----- 画像ライブラリ描画 -----
    function renderLibrary() {
      if (!libList) return;
      libList.innerHTML = '';
      // 空かどうかで全体レイアウト切替（empty 時はドロップゾーンが全面に拡張）
      if (libWrap) {
        libWrap.classList.toggle('imgplace-library--empty', imageLibrary.length === 0);
      }
      for (const img of imageLibrary) {
        const item = document.createElement('div');
        item.className = 'imgplace-lib-item';
        item.draggable = true;
        item.dataset.imageId = img.id;
        item.title = img.filename + ' (' + img.originalWidthPx + '×' + img.originalHeightPx + ')';

        const thumb = document.createElement('img');
        thumb.src = img.dataUrl;
        thumb.alt = img.filename;
        item.appendChild(thumb);

        const name = document.createElement('span');
        name.className = 'imgplace-lib-name';
        name.textContent = img.filename;
        item.appendChild(name);

        // 配置済みバッジは B-Gamma で実装、Alpha では仕込みだけ
        const usage = placements.filter(p => p.imageId === img.id).length;
        if (usage > 0) {
          const badge = document.createElement('span');
          badge.className = 'imgplace-lib-badge';
          badge.textContent = usage > 1 ? (usage + '×') : '配置済';
          item.appendChild(badge);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'imgplace-lib-remove';
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', img.filename + ' をライブラリから削除');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeLibraryImage(img.id);
        });
        item.appendChild(removeBtn);

        // 複数選択状態を反映
        const selIdx = libSelectedIds.indexOf(img.id);
        if (selIdx !== -1) {
          item.classList.add('lib-selected');
          item.dataset.selOrder = (selIdx + 1);
        }

        // ダブルクリックで現在ページ中央に配置
        item.addEventListener('dblclick', (e) => {
          e.preventDefault();
          placeAtCenter(img.id);
        });

        // クリックで選択 (Ctrl/Cmd = トグル、Shift = 範囲)
        item.addEventListener('click', (e) => {
          // × ボタンクリックは別 handler 経由 (stopPropagation 済)
          handleLibClick(img.id, e);
        });

        // ドラッグ開始: 選択に入ってる場合は全選択をドラッグ、そうでなければ単独
        item.addEventListener('dragstart', (e) => {
          if (libSelectedIds.indexOf(img.id) === -1) {
            // 単独ドラッグ: 選択は触らない (Ctrl 不要で配置できるように)
            draggingLibImageId = img.id;
            if (e.dataTransfer) {
              e.dataTransfer.setData('text/plain', 'imgplace-lib:' + img.id);
              e.dataTransfer.effectAllowed = 'copy';
            }
          } else {
            // 複数ドラッグ
            draggingLibImageId = '__multi__';
            const ids = libSelectedIds.slice();
            if (e.dataTransfer) {
              e.dataTransfer.setData('text/plain', 'imgplace-lib-multi:' + ids.join(','));
              e.dataTransfer.effectAllowed = 'copy';
            }
          }
        });
        item.addEventListener('dragend', () => {
          draggingLibImageId = null;
          if (canvasFrame) canvasFrame.classList.remove('drag-target');
        });

        libList.appendChild(item);
      }
      // 順次配置モードボタン状態を更新
      updatePlaceQueueBtn();
      // ライブラリ変化を autosave 対象として debounce 登録
      scheduleAutosave();
    }

    // クリック時の選択ロジック (Ctrl/Cmd トグル, Shift 範囲, plain は単独選択)
    function handleLibClick(imageId, e) {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      if (isShift && libLastClickedId) {
        // 範囲選択: lastClicked → imageId の間を全部選択 (既存選択は維持)
        const ids = imageLibrary.map(im => im.id);
        const a = ids.indexOf(libLastClickedId);
        const b = ids.indexOf(imageId);
        if (a !== -1 && b !== -1) {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (let k = lo; k <= hi; k++) {
            if (libSelectedIds.indexOf(ids[k]) === -1) libSelectedIds.push(ids[k]);
          }
        }
      } else if (isCtrl) {
        // トグル
        const idx = libSelectedIds.indexOf(imageId);
        if (idx === -1) libSelectedIds.push(imageId);
        else libSelectedIds.splice(idx, 1);
        libLastClickedId = imageId;
      } else {
        // 通常クリック: この1つだけに単独選択 (リセット)
        libSelectedIds = [imageId];
        libLastClickedId = imageId;
      }
      renderLibrary();
    }

    function clearLibSelection() {
      libSelectedIds = [];
      libLastClickedId = null;
      renderLibrary();
    }

    // ----- ライブラリ ラバーバンド選択 (libList 空きエリアからドラッグ) -----
    let libRubberState = null;
    if (libList) {
      libList.addEventListener('pointerdown', (e) => {
        // 左クリックのみ、ターゲットが libList 自身 (アイテムやその子じゃない)
        if (e.button !== 0) return;
        if (e.target !== libList) return;
        const startRect = libList.getBoundingClientRect();
        const startX = e.clientX - startRect.left + libList.scrollLeft;
        const startY = e.clientY - startRect.top + libList.scrollTop;
        const band = document.createElement('div');
        band.className = 'imgplace-lib-rubberband';
        libList.appendChild(band);
        libRubberState = {
          startX, startY, curX: startX, curY: startY,
          band: band,
          pointerId: e.pointerId,
          additive: e.ctrlKey || e.metaKey || e.shiftKey,
          baselineIds: (e.ctrlKey || e.metaKey || e.shiftKey) ? libSelectedIds.slice() : []
        };
        try { libList.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      libList.addEventListener('pointermove', (e) => {
        if (!libRubberState) return;
        const rect = libList.getBoundingClientRect();
        libRubberState.curX = e.clientX - rect.left + libList.scrollLeft;
        libRubberState.curY = e.clientY - rect.top + libList.scrollTop;
        const s = libRubberState;
        const xL = Math.min(s.startX, s.curX);
        const yT = Math.min(s.startY, s.curY);
        const xR = Math.max(s.startX, s.curX);
        const yB = Math.max(s.startY, s.curY);
        s.band.style.left = xL + 'px';
        s.band.style.top = yT + 'px';
        s.band.style.width = (xR - xL) + 'px';
        s.band.style.height = (yB - yT) + 'px';
        // 各 lib-item と交差判定 → libSelectedIds 更新
        const items = libList.querySelectorAll('.imgplace-lib-item');
        const newSel = s.additive ? s.baselineIds.slice() : [];
        items.forEach(it => {
          const ir = it.getBoundingClientRect();
          // ラバーバンド と item の rect が交差してるか (viewport 座標で判定)
          const r1 = {
            left: rect.left + xL - libList.scrollLeft,
            top: rect.top + yT - libList.scrollTop,
            right: rect.left + xR - libList.scrollLeft,
            bottom: rect.top + yB - libList.scrollTop
          };
          const hit = !(ir.right < r1.left || ir.left > r1.right || ir.bottom < r1.top || ir.top > r1.bottom);
          if (hit) {
            const id = it.dataset.imageId;
            if (id && newSel.indexOf(id) === -1) newSel.push(id);
          }
        });
        // 並び順を imageLibrary 順序に揃える (number badge 順序が直感的に)
        const orderMap = new Map(imageLibrary.map((im, i) => [im.id, i]));
        newSel.sort((a, b) => (orderMap.get(a) || 0) - (orderMap.get(b) || 0));
        libSelectedIds = newSel;
        // 軽量再描画: ラバーバンドの上にアイテム視覚状態だけ更新
        items.forEach(it => {
          const id = it.dataset.imageId;
          const selIdx = libSelectedIds.indexOf(id);
          if (selIdx !== -1) {
            it.classList.add('lib-selected');
            it.dataset.selOrder = (selIdx + 1);
          } else {
            it.classList.remove('lib-selected');
            it.removeAttribute('data-sel-order');
          }
        });
      });
      const endRubber = (e) => {
        if (!libRubberState) return;
        if (libRubberState.band && libRubberState.band.parentNode) {
          libRubberState.band.parentNode.removeChild(libRubberState.band);
        }
        libRubberState = null;
        // 順次配置ボタンのラベル更新
        updatePlaceQueueBtn();
      };
      libList.addEventListener('pointerup', endRubber);
      libList.addEventListener('pointercancel', endRubber);
    }

    function removeLibraryImage(imageId) {
      const usage = placements.filter(p => p.imageId === imageId).length;
      if (usage > 0) {
        if (!confirm('この画像はPDF上に ' + usage + ' 枚配置されています。ライブラリから削除すると、配置済みも全て消えます。続行しますか？')) {
          return;
        }
        const removedIds = placements.filter(p => p.imageId === imageId).map(p => p.id);
        placements = placements.filter(p => p.imageId !== imageId);
        // 選択状態クリーンアップ
        for (const rid of removedIds) {
          removeFromSelection(rid);
        }
      }
      imageLibrary = imageLibrary.filter(im => im.id !== imageId);
      // 選択リストからも除外
      libSelectedIds = libSelectedIds.filter(id => id !== imageId);
      if (libLastClickedId === imageId) libLastClickedId = null;
      // 順次配置 Queue にも入ってたら除外
      placeQueue = placeQueue.filter(id => id !== imageId);
      if (placeQueueMode && placeQueue.length === 0) stopPlaceQueueMode('対象画像なし');
      renderLibrary();
      renderPlacements();
    }

    // ----- 初期サイズ計算（72dpi換算 + サイズ上限） -----
    // sizeCapEnabled: true ならページの幅 1/3 + 高さ 1/3 のどちらか厳しい方で縮小
    //                 false なら 72dpi 原寸のまま（ページ幅 100% は超えないよう保険のみ）
