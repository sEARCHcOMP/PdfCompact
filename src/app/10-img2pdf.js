  (function imgToPdfModule() {
    'use strict';
    const { jsPDF } = window.jspdf;

    let files = [];
    let fitMode = 'contain';
    let pageSizeKey = 'a4';
    let qualityKey = 'standard';
    let dragIdx = null;

    const $ = (id) => document.getElementById(id);
    const dropzone = $('imgDropzone');
    const fileInput = $('imgFileInput');
    const fileGrid = $('imgFileGrid');
    const listPanel = $('imgListPanel');
    const actionBar = $('imgActionBar');
    const totalStats = $('imgTotalStats');
    const generateBtn = $('imgGenerateBtn');
    const clearBtn = $('imgClearBtn');
    const statusMsg = $('imgStatusMsg');
    const progressWrap = $('imgProgressWrap');
    const progressBar = $('imgProgressBar');
    const filenameInput = $('imgFilenameInput');
    const filenameClear = $('imgFilenameClear');
    if (filenameInput) {
      filenameInput.addEventListener('input', () => {
        const v = filenameInput.value;
        const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
        if (v !== cleaned) filenameInput.value = cleaned;
        filenameClear.classList.toggle('visible', !!filenameInput.value);
      });
      filenameClear.addEventListener('click', () => {
        filenameInput.value = '';
        filenameClear.classList.remove('visible');
        filenameInput.focus();
      });
    }

    // Preset selection
    $('imgPageSizePresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('imgPageSizePresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        pageSizeKey = btn.dataset.size;
      });
    });
    $('imgFitModes').querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('imgFitModes').querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fitMode = btn.dataset.fit;
      });
    });
    $('imgQualityPresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('imgQualityPresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        qualityKey = btn.dataset.q;
      });
    });

    // Dropzone
    ['dragenter', 'dragover'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); });
    });
    dropzone.addEventListener('drop', ev => {
      if (ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', ev => {
      if (ev.target.files) addFiles(ev.target.files);
      ev.target.value = '';
    });

    clearBtn.addEventListener('click', () => {
      files.forEach(it => {
        if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
      });
      files = [];
      setStatus('');
      render();
    });
    generateBtn.addEventListener('click', generatePdf);

    function isHeic(file) {
      const ext = file.name.toLowerCase().split('.').pop();
      return ext === 'heic' || ext === 'heif' || file.type === 'image/heic' || file.type === 'image/heif';
    }
    function isTiff(file) {
      const ext = file.name.toLowerCase().split('.').pop();
      return ext === 'tif' || ext === 'tiff' || file.type === 'image/tiff' || file.type === 'image/tif';
    }
    function isBmp(file) {
      const ext = file.name.toLowerCase().split('.').pop();
      return ext === 'bmp' || file.type === 'image/bmp' || file.type === 'image/x-ms-bmp';
    }
    function isPdf(file) {
      return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    }
    function isValidImage(file) {
      const ok = ['image/png', 'image/jpeg', 'image/jpg', 'image/avif'];
      if (ok.includes(file.type)) return true;
      if (isHeic(file) || isTiff(file) || isBmp(file)) return true;
      const ext = file.name.toLowerCase().split('.').pop();
      return ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif'].includes(ext);
    }
    function isValidInput(file) {
      return isValidImage(file) || isPdf(file);
    }
    // HEIC/HEIF は通常 heic2any(同梱の旧 libheif)で変換する。ただし Apple の HDR HEIC
    // (ゲインマップ付き・マルチイメージ・10bit 等)は旧 libheif が
    // "ERR_LIBHEIF format not supported" で弾く。その時だけ新しい libheif(wasm)を
    // 遅延ロードして再デコードする(初回起動を重くしないよう、失敗時に初めて取得)。
    let _libheifPromise = null;
    function loadLibheif() {
      if (_libheifPromise) return _libheifPromise;
      _libheifPromise = new Promise((resolve, reject) => {
        if (window.libheif) { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/libheif-js@1.18.2/libheif-wasm/libheif-bundle.js';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('高機能HEICデコーダの読み込みに失敗しました(この画像形式にはネット接続が必要です)'));
        document.head.appendChild(s);
      }).then(() => (typeof window.libheif === 'function' ? window.libheif() : window.libheif));
      // 読込失敗(一時的なネット断など)はキャッシュを捨てて次回リトライ可能にする
      _libheifPromise.catch(() => { _libheifPromise = null; });
      return _libheifPromise;
    }
    // 新 libheif で HEIC → JPEG(File)。irot 回転はデコード時に適用され、canvas 出力は
    // EXIF を持たないため、生成時の EXIF 回転処理と二重適用にならない。
    // decoder は使い回す: HeifDecoder は内部に heif_context(WASMヒープ)を1本持ち解放APIが無い。
    // 毎回 new すると context が漏れ続けるため、共有インスタンスにする(decode() は呼ぶたび
    // 前回 context を自動 free するので、生存 context は常に最大1個に抑えられる)。
    let _sharedHeifDecoder = null;
    async function convertHeicViaLibheif(file) {
      const lib = await loadLibheif();
      if (!_sharedHeifDecoder) _sharedHeifDecoder = new lib.HeifDecoder();
      const imgs = _sharedHeifDecoder.decode(new Uint8Array(await file.arrayBuffer()));
      if (!imgs || imgs.length === 0) throw new Error('HEIF: 画像が見つかりません');
      const img = imgs[0];
      try {
        const w = img.get_width(), h = img.get_height();
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(w, h);
        await new Promise((resolve, reject) => {
          img.display(imageData, (d) => d ? resolve() : reject(new Error('HEIF: 画像の展開に失敗しました')));
        });
        ctx.putImageData(imageData, 0, 0);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
        canvas.width = 0; canvas.height = 0;
        if (!blob) throw new Error('HEIF→JPEG 変換に失敗しました');
        return new File([blob], file.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' });
      } finally {
        // libheif の画像はメモリ解放が必要(バッチで複数枚処理する時のリーク防止)
        for (const im of imgs) { try { if (im && im.free) im.free(); } catch (_) {} }
      }
    }
    async function convertHeicToJpeg(file) {
      try {
        const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
        const result = Array.isArray(blob) ? blob[0] : blob;
        return new File([result], file.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg'), { type: 'image/jpeg' });
      } catch (e) {
        // 旧 libheif が弾く HDR/マルチイメージ HEIC → 新 libheif で再挑戦(ここが唯一のフォールバック)
        console.warn('[img2pdf] heic2any 失敗、libheif で再挑戦:', e && e.message);
        return await convertHeicViaLibheif(file);
      }
    }
    // TIFF → PNG (UTIF.js). Handles multi-page TIFFs by returning array of File objects.
    async function convertTiffToPng(file) {
      const buf = await file.arrayBuffer();
      const ifds = UTIF.decode(buf);
      if (!ifds || ifds.length === 0) throw new Error('TIFF decode failed');
      const results = [];
      for (let i = 0; i < ifds.length; i++) {
        const ifd = ifds[i];
        UTIF.decodeImage(buf, ifd);
        const rgba = UTIF.toRGBA8(ifd);
        const canvas = document.createElement('canvas');
        canvas.width = ifd.width;
        canvas.height = ifd.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(ifd.width, ifd.height);
        imgData.data.set(rgba);
        ctx.putImageData(imgData, 0, 0);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        // toBlob は巨大TIFF(canvasの辺/面積上限超え)で null を返す。そのまま new File([null])
        // すると中身 "null" の壊れたPNGになり、下流の img.onload が発火せずハングする。明示エラーで止める
        if (!blob) { canvas.width = 0; canvas.height = 0; throw new Error(`TIFF→PNG 変換に失敗しました (ページ ${i + 1}: 画像が大きすぎます)`); }
        const suffix = ifds.length > 1 ? `_page${i + 1}` : '';
        const baseName = file.name.replace(/\.(tiff?|TIFF?)$/i, '');
        results.push(new File([blob], `${baseName}${suffix}.png`, { type: 'image/png' }));
        canvas.width = 0; canvas.height = 0;
      }
      return results;
    }

    // 00-core の共有 setModeStatus に委譲(プライマリ statusMsg + アクションバー・ミラー)
    function setStatus(text, type) {
      setModeStatus(statusMsg, document.getElementById('imgActionBarStatus'), text, type);
    }

    async function addPdfFile(file) {
      const buf = await file.arrayBuffer();
      // pdf.js consumes the buffer, so clone for later re-rendering
      const loadBuf = buf.slice(0);
      const pdfDoc = await pdfjsLib.getDocument({ data: loadBuf }).promise;
      const numPages = pdfDoc.numPages;

      // Render first page as thumbnail
      const firstPage = await pdfDoc.getPage(1);
      const native = firstPage.getViewport({ scale: 1 });
      const thumbMaxDim = 300;
      const thumbScale = Math.min(thumbMaxDim / native.width, thumbMaxDim / native.height, 1.5);
      const thumbView = firstPage.getViewport({ scale: thumbScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(thumbView.width);
      canvas.height = Math.ceil(thumbView.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await firstPage.render({ canvasContext: ctx, viewport: thumbView }).promise;
      const thumbUrl = canvas.toDataURL('image/jpeg', 0.75);
      canvas.width = 0; canvas.height = 0;

      files.push({
        type: 'pdf',
        file: file,
        url: thumbUrl,
        name: file.name,
        numPages: numPages,
        pdfBuffer: buf,           // original buffer kept for full rendering at generate time
        width: native.width,
        height: native.height
      });
    }

    async function addFiles(fileList) {
      const arr = [...fileList].filter(isValidInput);
      if (arr.length === 0) {
        setStatus('⚠ PNG / JPG / HEIC / BMP / TIFF / AVIF / PDF のみ対応しています', 'error');
        return;
      }
      setStatus('');

      let loaded = 0;
      const total = arr.length;
      const failedNames = [];   // 読込失敗を覚えて最後にまとめて表示(直後の setStatus('') で消さない)

      for (const origFile of arr) {
        try {
          if (isPdf(origFile)) {
            setStatus(`PDF読込中... (${loaded + 1}/${total}) ${origFile.name}`, 'info');
            await addPdfFile(origFile);
          } else if (isTiff(origFile)) {
            setStatus(`TIFF変換中... (${loaded + 1}/${total}) ${origFile.name}`, 'info');
            const pngFiles = await convertTiffToPng(origFile);
            for (const pf of pngFiles) {
              const url = URL.createObjectURL(pf);
              await new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                  files.push({
                    type: 'image', file: pf, url,
                    name: pf.name,
                    width: img.naturalWidth,
                    height: img.naturalHeight
                  });
                  resolve();
                };
                img.onerror = () => {
                  failedNames.push(`${pf.name} (TIFF変換結果の表示に失敗)`);
                  try { URL.revokeObjectURL(url); } catch(_) {}
                  resolve();
                };
                img.src = url;
              });
            }
          } else {
            let file = origFile;
            if (isHeic(origFile)) {
              setStatus(`HEIC変換中... (${loaded + 1}/${total})`, 'info');
              file = await convertHeicToJpeg(origFile);
            } else if (isBmp(origFile)) {
              setStatus(`BMP読込中... (${loaded + 1}/${total})`, 'info');
              // BMP is natively supported by browsers, just load it
            }
            const url = URL.createObjectURL(file);
            await new Promise(resolve => {
              const img = new Image();
              img.onload = () => {
                files.push({
                  type: 'image',
                  file, url,
                  name: origFile.name,
                  width: img.naturalWidth,
                  height: img.naturalHeight
                });
                resolve();
              };
              img.onerror = () => {
                // ブラウザ未対応形式 (古い Firefox の AVIF 等) or 破損ファイル
                const ext = (origFile.name.split('.').pop() || '').toUpperCase();
                failedNames.push(`${origFile.name} (${ext} がブラウザ未対応 or 破損)`);
                try { URL.revokeObjectURL(url); } catch(_) {}
                resolve();
              };
              img.src = url;
            });
          }
        } catch (err) {
          console.error('Load error:', origFile.name, err);
          failedNames.push(origFile.name);
        }
        loaded++;
      }
      // 失敗があれば消えないまとめ表示(従来は直後の setStatus('') で一瞬で消えて無言スキップになっていた)
      setStatus(failedNames.length ? `⚠ ${failedNames.length}件を読み込めませんでした: ${failedNames.join(' / ')}` : '');
      render();
      // ドロップ後、結果が見える位置へ自動スクロール
      requestAnimationFrame(() => {
        if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    // escapeHtml は 00-core の共有版を使う

    function render() {
      const imageCount = files.filter(f => f.type === 'image').length;
      const pdfCount = files.filter(f => f.type === 'pdf').length;
      const totalOutputPages = files.reduce((sum, f) => sum + (f.type === 'pdf' ? f.numPages : 1), 0);

      if (files.length === 0) {
        totalStats.textContent = '0 ファイル';
        actionBar.style.display = 'none';
        const fbar = document.getElementById('imgFilenameBar');
        if (fbar) fbar.style.display = 'none';
        if (listPanel) listPanel.style.display = 'none';
        fileGrid.innerHTML = '';
        return;
      }

      const parts = [];
      if (imageCount > 0) parts.push(`${imageCount}枚の画像`);
      if (pdfCount > 0) parts.push(`${pdfCount}個のPDF`);
      totalStats.innerHTML = `<strong style="color:white;">${parts.join(' + ')}</strong> · 出力 ${totalOutputPages}ページ`;
      actionBar.style.display = 'flex';
      const fbar = document.getElementById('imgFilenameBar');
      if (fbar) fbar.style.display = 'flex';
      if (listPanel) listPanel.style.display = 'block';

      fileGrid.innerHTML = files.map((it, i) => {
        const isPdfItem = it.type === 'pdf';
        const cardCls = 'img-file-card' + (isPdfItem ? ' is-pdf' : '');
        const pdfBadge = isPdfItem ? `<div class="pdf-type-badge">PDF</div>` : '';
        const pagesBadge = isPdfItem ? `<div class="pdf-pages-badge">${it.numPages}ページ</div>` : '';
        return `
          <div class="${cardCls}" draggable="true" data-idx="${i}">
            ${pdfBadge}
            <img class="img-file-thumb" src="${it.url}" alt="${escapeHtml(it.name)}">
            ${pagesBadge}
            <button class="img-file-remove" data-remove="${i}" title="削除" aria-label="削除">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            <div class="img-file-meta">
              <span class="img-file-num">${i + 1}</span>
              <span class="img-file-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
            </div>
          </div>
        `;
      }).join('');

      fileGrid.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.remove;
          const it = files[idx];
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
          files.splice(idx, 1);
          render();
        });
      });

      fileGrid.querySelectorAll('.img-file-card').forEach(card => {
        card.addEventListener('dragstart', ev => {
          dragIdx = +card.dataset.idx;
          card.classList.add('dragging');
          ev.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          dragIdx = null;
          fileGrid.querySelectorAll('.img-file-card').forEach(c => c.classList.remove('dragover-card'));
        });
        card.addEventListener('dragover', ev => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          card.classList.add('dragover-card');
        });
        card.addEventListener('dragleave', () => card.classList.remove('dragover-card'));
        card.addEventListener('drop', ev => {
          ev.preventDefault();
          card.classList.remove('dragover-card');
          const toIdx = +card.dataset.idx;
          if (dragIdx !== null && dragIdx !== toIdx) {
            const item = files.splice(dragIdx, 1)[0];
            files.splice(toIdx, 0, item);
            render();
          }
        });
      });
    }

    const QUALITY_PRESETS = {
      light:    { maxPx: 1200, jpegQuality: 0.55 },
      standard: { maxPx: 2000, jpegQuality: 0.75 },
      high:     { maxPx: 3200, jpegQuality: 0.90 },
      original: { maxPx: Infinity, jpegQuality: 1.0 },
    };
    function getPageDims(size) {
      switch(size) {
        case 'a3': return [297, 420];
        case 'a4': return [210, 297];
        case 'b4': return [257, 364];
        case 'b5': return [182, 257];
        default: return null;
      }
    }
    function compressImage(file, maxPx, jpegQuality) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
          const img = new Image();
          img.onerror = reject;
          img.onload = () => {
            let w = img.naturalWidth, h = img.naturalHeight;
            if (maxPx < Infinity && (w > maxPx || h > maxPx)) {
              if (w > h) { h = Math.round(h * (maxPx / w)); w = maxPx; }
              else { w = Math.round(w * (maxPx / h)); h = maxPx; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', jpegQuality));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }
    function loadImageData(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    // EXIF Orientation は 00-core の共有 readExifOrientation に委譲(File の先頭256KBを読む)。
    // 失敗時は 1(補正不要=従来どおり生パススルー)。等価性は tests/exif.spec.js が固定。
    async function readJpegOrientation(file) {
      try {
        return readExifOrientation(await file.slice(0, 256 * 1024).arrayBuffer());
      } catch (e) {
        return 1;
      }
    }

    // Rasterize one PDF page at a target quality; returns {dataUrl, nativeW, nativeH}
    async function renderPdfPageToJpeg(page, preset, qKey) {
      const native = page.getViewport({ scale: 1 });
      const nativeW = native.width;   // points
      const nativeH = native.height;
      const maxDim = Math.max(nativeW, nativeH);

      let renderScale;
      if (qKey === 'original') {
        renderScale = 2.5;  // ~180 DPI
      } else {
        // target maxPx in pixels, relative to native (at 72dpi/point)
        renderScale = Math.min(5, Math.max(0.5, preset.maxPx / maxDim));
      }
      const rv = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(rv.width);
      canvas.height = Math.ceil(rv.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: rv }).promise;
      const q = qKey === 'original' ? 0.95 : preset.jpegQuality;
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      canvas.width = 0; canvas.height = 0;
      return { dataUrl, nativeW, nativeH };
    }

    // Add a rasterized page to the output PDF document. Returns the doc.
    function addPageToDoc(doc, imgData, nativeW, nativeH, isFirst) {
      const isLandscape = nativeW > nativeH;

      if (pageSizeKey === 'fit') {
        // Use native dimensions (image at 96dpi, PDF points at 72dpi → convert to mm)
        // For images: px at 96dpi → mm: x * 25.4 / 96
        // For PDF pages: points (72dpi) → mm: x * 25.4 / 72
        // We tag images differently by assuming they come in as px (for img path we used /96);
        // For PDFs we pass points (width in pts). We'll use /72 for PDF path explicitly.
        // NOTE: this function is called with px-at-96 for images, points for PDFs.
        // To unify, caller should convert beforehand. See callers below.
        const pw = nativeW;
        const ph = nativeH;
        // v3.7.6 (H3): jsPDF 2.5.1 は format:[w,h] で w>h だと既定 orientation 'p' が勝って
        // 縦横を強制スワップする → 横長が縦ページに化けるため orientation を明示する
        const fitOrient = pw > ph ? 'l' : 'p';
        if (isFirst) {
          doc = new jsPDF({ orientation: fitOrient, unit: 'mm', format: [pw, ph] });
        } else {
          doc.addPage([pw, ph], fitOrient);
        }
        doc.addImage(imgData, 'JPEG', 0, 0, pw, ph);
        return doc;
      } else {
        const baseDims = getPageDims(pageSizeKey);
        const short = Math.min(baseDims[0], baseDims[1]);
        const long = Math.max(baseDims[0], baseDims[1]);
        const pw = isLandscape ? long : short;
        const ph = isLandscape ? short : long;
        const orient = isLandscape ? 'landscape' : 'portrait';

        if (isFirst) {
          doc = new jsPDF({ orientation: orient, unit: 'mm', format: [pw, ph] });
        } else {
          doc.addPage([pw, ph], orient);
        }
        const imgRatio = nativeW / nativeH;
        const pageRatio = pw / ph;
        let drawW, drawH;
        if (fitMode === 'contain') {
          if (imgRatio > pageRatio) { drawW = pw; drawH = pw / imgRatio; }
          else { drawH = ph; drawW = ph * imgRatio; }
        } else {
          if (imgRatio > pageRatio) { drawH = ph; drawW = ph * imgRatio; }
          else { drawW = pw; drawH = pw / imgRatio; }
        }
        const x = (pw - drawW) / 2;
        const y = (ph - drawH) / 2;
        doc.addImage(imgData, 'JPEG', x, y, drawW, drawH);
        return doc;
      }
    }

    async function generatePdf() {
      if (files.length === 0) return;
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      if (progressWrap) progressWrap.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      setStatus('PDF生成中...', 'info');
      await new Promise(r => setTimeout(r, 50));
      let successFlag = false;

      try {
        const preset = QUALITY_PRESETS[qualityKey];
        let doc = null;
        let isFirst = true;
        const genFailedNames = [];   // v3.7.6 (M3): 変換に失敗した画像名 (1枚の失敗でバッチ全滅させない)

        const totalOutputPages = files.reduce((sum, f) => sum + (f.type === 'pdf' ? f.numPages : 1), 0);
        let completedPages = 0;

        for (let i = 0; i < files.length; i++) {
          const it = files[i];

          if (it.type === 'pdf') {
            // Re-load the PDF fresh (buffer gets consumed by pdf.js)
            const srcPdf = await pdfjsLib.getDocument({ data: it.pdfBuffer.slice(0) }).promise;
            for (let p = 1; p <= srcPdf.numPages; p++) {
              setStatus(`PDF処理中... ${it.name} (${p}/${srcPdf.numPages})`, 'info');
              await new Promise(r => setTimeout(r, 0));

              const page = await srcPdf.getPage(p);
              const { dataUrl, nativeW, nativeH } = await renderPdfPageToJpeg(page, preset, qualityKey);

              // For "fit" mode with PDF, use points → mm (72dpi basis)
              let pageW = nativeW, pageH = nativeH;
              if (pageSizeKey === 'fit') {
                pageW = nativeW * 25.4 / 72;
                pageH = nativeH * 25.4 / 72;
              }
              doc = addPageToDoc(doc, dataUrl, pageW, pageH, isFirst);
              isFirst = false;
              completedPages++;
              if (progressBar) {
                progressBar.style.width = Math.round(completedPages / totalOutputPages * 100) + '%';
              }
            }
          } else {
            // Image case
            setStatus(`画像処理中... (${i+1}/${files.length}) ${it.name}`, 'info');
            await new Promise(r => setTimeout(r, 0));

            // v3.7.6 (M3): 1枚の失敗でバッチ全体を道連れにしない per-item catch
            // (PDF入力ページのレンダ失敗は従来どおり外側 catch で全体エラーになる = 既知の限界)
            try {
              // v3.7.6 (H4/M3): 無圧縮でも canvas 経由が必要なケースを判定
              //  - AVIF: jsPDF 2.5.1 は AVIF を埋め込めない → 常に canvas で JPEG 化
              //  - EXIF Orientation≠1 の JPEG: jsPDF は EXIF を無視して横倒しになる
              //    → 回転写真だけ高品質(0.95)再エンコードに落とす (canvas が EXIF 回転を適用)
              //  orientation=1 の JPEG と PNG は従来どおり生パススルー (無圧縮の約束を守る)
              let viaCanvas = qualityKey !== 'original';
              if (!viaCanvas) {
                const ext = (it.file.name || it.name || '').toLowerCase().split('.').pop();
                if (ext === 'avif' || it.file.type === 'image/avif') {
                  viaCanvas = true;
                } else if (ext === 'jpg' || ext === 'jpeg' || it.file.type === 'image/jpeg') {
                  const exifOri = await readJpegOrientation(it.file);
                  if (exifOri !== 1) viaCanvas = true;
                }
              }
              const imgData = viaCanvas
                ? await compressImage(it.file, preset.maxPx, qualityKey === 'original' ? 0.95 : preset.jpegQuality)
                : await loadImageData(it.file);

              // For "fit" mode with image, use px at 96dpi → mm
              let pageW = it.width, pageH = it.height;
              if (pageSizeKey === 'fit') {
                pageW = it.width * 25.4 / 96;
                pageH = it.height * 25.4 / 96;
              }
              doc = addPageToDoc(doc, imgData, pageW, pageH, isFirst);
              isFirst = false;
            } catch (imgErr) {
              console.error('画像の変換に失敗:', it.name, imgErr);
              genFailedNames.push(it.name);
            }
            completedPages++;
            if (progressBar) {
              progressBar.style.width = Math.round(completedPages / totalOutputPages * 100) + '%';
            }
          }
        }

        // v3.7.6 (M3): 全ファイル失敗時は doc が null のまま → 分かる言葉で止める
        if (!doc) throw new Error(`すべてのファイルの変換に失敗しました: ${genFailedNames.join(' / ')}`);

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        let pdfBlob = doc.output('blob');
        // v3.6.0: 出力前メタデータ除去 (imgtopdf は常にPDF・ガード不要)
        if (window.PdfSanitize) pdfBlob = await window.PdfSanitize.process(pdfBlob);
        const sizeMB = (pdfBlob.size / (1024 * 1024)).toFixed(2);
        const qLabel = { light: '軽量', standard: '標準', high: '高画質', original: '無圧縮' }[qualityKey];

        // ファイル名を決めて、download は 00-core の共有 triggerDownload に委譲
        const imgFilenameEl = document.getElementById('imgFilenameInput');
        const userName = (imgFilenameEl && imgFilenameEl.value || '').trim();
        const hasPdf = files.some(f => f.type === 'pdf');
        const hasImg = files.some(f => f.type === 'image');
        const prefix = hasPdf && hasImg ? 'merged' : (hasPdf ? 'pdfmerge' : 'images');
        // User name: append TS if toggled. Empty: always uses TS.
        let finalBase;
        if (userName) {
          finalBase = appendTimestamp(userName, 'imgFilenameTs');
        } else {
          finalBase = `${prefix}_${ts}`;
        }
        triggerDownload(pdfBlob, `${finalBase}.pdf`);

        // v3.7.6 (M3): 失敗分を除いた実ページ数で表示し、失敗があれば消えないまとめ表示にする
        const okPages = totalOutputPages - genFailedNames.length;
        if (genFailedNames.length) {
          setStatus(`✓ ${okPages}ページ · ${sizeMB} MB (${qLabel}) · ダウンロード完了 / ⚠ ${genFailedNames.length}件は変換できず除外: ${genFailedNames.join(' / ')}`, 'error');
        } else {
          setStatus(`✓ ${okPages}ページ · ${sizeMB} MB (${qLabel}) · ダウンロード完了`, 'success');
        }

        // Celebrate!
        const imgCnt = files.filter(f => f.type === 'image').length;
        const pdfCnt = files.filter(f => f.type === 'pdf').length;
        const inputParts = [];
        if (imgCnt > 0) inputParts.push(`画像 ${imgCnt}`);
        if (pdfCnt > 0) inputParts.push(`PDF ${pdfCnt}`);
        const stats = [
          { label: '入力', value: inputParts.join(' + ') },
          { label: '出力ページ', value: `${okPages} ページ`, highlight: true },
          { label: 'ファイルサイズ', value: `${sizeMB} MB` },
          { label: '画質', value: qLabel }
        ];
        showSuccess({
          title: 'PDF作成完了',
          subtitle: 'ダウンロードが始まりました',
          stats: stats
        });
        successFlag = true;
      } catch (err) {
        console.error(err);
        setStatus(`✕ エラー: ${err.message}`, 'error');
      }

      generateBtn.disabled = false;
      clearBtn.disabled = false;
      // PDF出力成功時のみ保持ファイルを破棄 (次の作業に備えてリセット)
      if (successFlag) {
        files.forEach(it => {
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
        });
        files = [];
        render();
      }
      setTimeout(() => {
        if (progressWrap) progressWrap.classList.remove('active');
      }, 1500);
    }

    render();
  })();

  // =========================================================
  // FORMAT CONVERTER (isolated scope)
  // =========================================================
