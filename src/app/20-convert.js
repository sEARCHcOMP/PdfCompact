  (function converterModule() {
    'use strict';
    const { jsPDF } = window.jspdf;

    let files = [];
    let outputFormat = 'jpg';
    let quality = 'standard';
    let outputMode = 'individual';
    let isConverting = false;   // 実行中ガード: ✕削除・追加で変換ループの添字がズレるのを防ぐ

    const $ = (id) => document.getElementById(id);
    const dropzone = $('convDropzone');
    const fileInput = $('convFileInput');
    const fileGrid = $('convFileGrid');
    const listPanel = $('convListPanel');
    const actionBar = $('convActionBar');
    const totalStats = $('convTotalStats');
    const generateBtn = $('convGenerateBtn');
    const clearBtn = $('convClearBtn');
    const statusMsg = $('convStatusMsg');
    const progressWrap = $('convProgressWrap');
    const progressBar = $('convProgressBar');
    const qualityPanel = $('convQualityPanel');

    // Format preset
    $('convFormatPresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('convFormatPresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        outputFormat = btn.dataset.format;
        // Hide quality panel if format doesn't benefit from JPEG quality
        qualityPanel.style.opacity = (outputFormat === 'jpg' || outputFormat === 'pdf') ? '1' : '0.45';
        // Update filename extension hint based on output mode
        updateFilenameExtDisplay();
        // Re-render stats (output format changed)
        render();
      });
    });
    function updateFilenameExtDisplay() {
      const extEl = document.getElementById('convFilenameExt');
      if (!extEl) return;
      if (outputMode === 'zip') {
        extEl.textContent = '.zip';
      } else {
        extEl.textContent = `.${outputFormat}`;
      }
    }
    $('convQualityPresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('convQualityPresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        quality = btn.dataset.quality;
      });
    });
    $('convOutputModes').querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('convOutputModes').querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        outputMode = btn.dataset.output;
        updateFilenameExtDisplay();
        render();
      });
    });

    // Filename input wiring
    (function() {
      const fin = document.getElementById('convFilenameInput');
      const fcl = document.getElementById('convFilenameClear');
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
    generateBtn.addEventListener('click', convertAll);

    // ---- Input type detection ----
    function getExt(f) { return f.name.toLowerCase().split('.').pop(); }
    function isHeic(f) {
      const e = getExt(f);
      return e === 'heic' || e === 'heif' || f.type === 'image/heic' || f.type === 'image/heif';
    }
    function isTiff(f) {
      const e = getExt(f);
      return e === 'tif' || e === 'tiff' || f.type === 'image/tiff';
    }
    function isBmp(f) {
      const e = getExt(f);
      return e === 'bmp' || f.type === 'image/bmp' || f.type === 'image/x-ms-bmp';
    }
    function isPdf(f) {
      return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    }
    function isValidInput(f) {
      const e = getExt(f);
      return ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif', 'pdf'].includes(e)
        || isPdf(f) || isHeic(f) || isTiff(f) || isBmp(f)
        || ['image/png', 'image/jpeg', 'image/jpg', 'image/avif'].includes(f.type);
    }

    // 00-core の共有 setModeStatus に委譲(プライマリ statusMsg + アクションバー・ミラー)
    function setStatus(text, type) {
      setModeStatus(statusMsg, document.getElementById('convActionBarStatus'), text, type);
    }

    async function convertHeicToJpeg(file) {
      const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      const result = Array.isArray(blob) ? blob[0] : blob;
      return new File([result], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
    }
    async function convertTiffToCanvas(file) {
      // Returns array of {canvas, name} — one per TIFF page
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
        const suffix = ifds.length > 1 ? `_page${i + 1}` : '';
        const baseName = file.name.replace(/\.(tiff?)$/i, '');
        results.push({ canvas, baseName: `${baseName}${suffix}` });
      }
      return results;
    }

    // Load any input file → array of {canvas, baseName} entries
    // (PDFs and multi-page TIFFs yield multiple entries)
    async function loadToCanvases(file) {
      const name = file.name;
      const baseName = name.replace(/\.[^.]+$/, '');

      if (isTiff(file)) {
        return await convertTiffToCanvas(file);
      }

      if (isPdf(file)) {
        const buf = await file.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
        const results = [];
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          const page = await pdfDoc.getPage(p);
          const native = page.getViewport({ scale: 1 });
          const maxDim = Math.max(native.width, native.height);
          const targetPx = 2200;
          const scale = Math.min(4, targetPx / maxDim);
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const suffix = pdfDoc.numPages > 1 ? `_page${p}` : '';
          results.push({ canvas, baseName: `${baseName}${suffix}` });
        }
        return results;
      }

      // Images (PNG/JPG/HEIC/BMP) → load into canvas
      let loadFile = file;
      if (isHeic(file)) {
        loadFile = await convertHeicToJpeg(file);
      }
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(loadFile);
        const img = new Image();
        img.onload = () => {
          // Chrome系のcanvas上限(長辺16384px・面積制限)超過で toBlob/toDataURL が壊れるため、
          // 長辺 8192px を超える巨大画像は縦横比を保って縮小する
          const MAX_DIM = 8192;
          const dimScale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * dimScale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * dimScale));
          const ctx = canvas.getContext('2d');
          // For transparent-capable formats, don't fill white unless going to JPG/BMP
          if (outputFormat === 'jpg' || outputFormat === 'bmp') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve([{ canvas, baseName }]);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像読込失敗')); };
        img.src = url;
      });
    }

    async function addFiles(fileList) {
      const arr = [...fileList].filter(isValidInput);
      if (arr.length === 0) {
        setStatus('⚠ PNG / JPG / HEIC / BMP / TIFF / AVIF / PDF のみ対応しています', 'error');
        return;
      }
      if (isConverting) {
        setStatus('変換中はファイルを追加できません', 'error');
        return;
      }
      setStatus('');

      // Build thumbnails for preview
      let loaded = 0;
      const total = arr.length;
      const failedNames = [];   // 読込失敗を覚えて最後にまとめて表示(直後の setStatus('') で消さない)
      for (const origFile of arr) {
        try {
          setStatus(`読込中... (${loaded + 1}/${total}) ${origFile.name}`, 'info');
          const ext = getExt(origFile);

          // For thumbnail we just need ONE preview image per file
          let thumbUrl = null;
          let pageCount = 1;
          let nativeWidth = 0;
          let nativeHeight = 0;

          if (isTiff(origFile)) {
            const canvases = await convertTiffToCanvas(origFile);
            pageCount = canvases.length;
            const first = canvases[0].canvas;
            nativeWidth = first.width;
            nativeHeight = first.height;
            thumbUrl = makeThumbUrl(first);
          } else if (isPdf(origFile)) {
            const buf = await origFile.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
            pageCount = pdf.numPages;
            const page = await pdf.getPage(1);
            const native = page.getViewport({ scale: 1 });
            nativeWidth = native.width;
            nativeHeight = native.height;
            const thumbScale = Math.min(250 / native.width, 250 / native.height, 1.5);
            const vp = page.getViewport({ scale: thumbScale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(vp.width);
            canvas.height = Math.ceil(vp.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            thumbUrl = canvas.toDataURL('image/jpeg', 0.75);
            canvas.width = 0; canvas.height = 0;
          } else if (isHeic(origFile)) {
            const jpg = await convertHeicToJpeg(origFile);
            thumbUrl = URL.createObjectURL(jpg);
          } else {
            thumbUrl = URL.createObjectURL(origFile);
          }

          files.push({
            file: origFile,
            url: thumbUrl,
            name: origFile.name,
            ext: ext,
            pageCount: pageCount,
            isPdf: isPdf(origFile),
            isTiff: isTiff(origFile),
            width: nativeWidth,
            height: nativeHeight
          });
        } catch (err) {
          console.error('Conv load error:', origFile.name, err);
          failedNames.push(origFile.name);
        }
        loaded++;
      }
      // 失敗があれば消えないまとめ表示(保護付きPDF・破損ファイルの無言スキップ防止)
      setStatus(failedNames.length ? `⚠ ${failedNames.length}件を読み込めませんでした(保護付き/破損の可能性): ${failedNames.join(' / ')}` : '');
      render();
      // ドロップ後、結果が見える位置へ自動スクロール
      requestAnimationFrame(() => {
        if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    function makeThumbUrl(canvas) {
      // Shrink to thumbnail
      const maxDim = 250;
      const scale = Math.min(maxDim / canvas.width, maxDim / canvas.height, 1);
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = thumb.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, thumb.width, thumb.height);
      ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      const url = thumb.toDataURL('image/jpeg', 0.75);
      thumb.width = 0; thumb.height = 0;
      return url;
    }

    // escapeHtml は 00-core の共有版を使う

    function render() {
      const convFbar = document.getElementById('convFilenameBar');
      if (files.length === 0) {
        totalStats.textContent = '0 ファイル';
        actionBar.style.display = 'none';
        if (convFbar) convFbar.style.display = 'none';
        if (listPanel) listPanel.style.display = 'none';
        fileGrid.innerHTML = '';
        return;
      }
      const totalOutputs = files.reduce((s, f) => s + f.pageCount, 0);
      totalStats.innerHTML = `<strong style="color:white;">${files.length}</strong> ファイル · 出力 ${totalOutputs} 枚 · → ${outputFormat.toUpperCase()}`;
      actionBar.style.display = 'flex';
      // Filename bar is useful for both ZIP and individual modes now
      if (convFbar) convFbar.style.display = 'flex';
      if (listPanel) listPanel.style.display = 'block';

      fileGrid.innerHTML = files.map((it, i) => {
        const multiPage = it.pageCount > 1;
        const extBadge = `<div class="pdf-type-badge">${it.ext.toUpperCase()}</div>`;
        const pagesBadge = multiPage ? `<div class="pdf-pages-badge">${it.pageCount}ページ</div>` : '';
        return `
          <div class="img-file-card${it.isPdf ? ' is-pdf' : ''}" data-idx="${i}">
            ${extBadge}
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
          if (isConverting) { setStatus('変換中はファイルを変更できません', 'error'); return; }
          const idx = +btn.dataset.remove;
          const it = files[idx];
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
          files.splice(idx, 1);
          render();
        });
      });
    }

    // ---- Quality map ----
    const QUALITY = {
      light:    0.55,
      standard: 0.80,
      high:     0.95,
      max:      1.00
    };

    // ---- Output helpers ----
    // 透過部を白で埋める (JPEG/BMP/PDF は透過を保持できず黒化けするため)。
    // destination-over で既存描画の「下」に白を敷くので、コピーcanvasを作らずメモリ増なしで合成できる
    function flattenWhite(canvas) {
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      return canvas;
    }
    function canvasToJpegBlob(canvas) {
      flattenWhite(canvas);   // TIFF入力など読込時に白埋めされない経路の保険
      return new Promise(r => canvas.toBlob(r, 'image/jpeg', QUALITY[quality]));
    }
    function canvasToPngBlob(canvas) {
      return new Promise(r => canvas.toBlob(r, 'image/png'));
    }
    // BMP: hand-rolled 32bpp uncompressed encoder
    function canvasToBmpBlob(canvas) {
      flattenWhite(canvas);   // 透過は白背景に変換 (多くのビューアは32bpp BMPのアルファを無視して黒くなるため)
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const w = canvas.width;
      const h = canvas.height;
      const rowSize = w * 4;              // 32bpp BGRA
      const pixelArraySize = rowSize * h;
      const fileSize = 54 + pixelArraySize;
      const buffer = new ArrayBuffer(fileSize);
      const dv = new DataView(buffer);
      const u8 = new Uint8Array(buffer);
      // BMP File Header
      dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);        // 'BM'
      dv.setUint32(2, fileSize, true);                    // file size
      dv.setUint32(6, 0, true);                           // reserved
      dv.setUint32(10, 54, true);                         // pixel data offset
      // DIB Header (BITMAPINFOHEADER, 40 bytes)
      dv.setUint32(14, 40, true);                         // header size
      dv.setInt32(18, w, true);                           // width
      dv.setInt32(22, -h, true);                          // negative height = top-down
      dv.setUint16(26, 1, true);                          // planes
      dv.setUint16(28, 32, true);                         // 32bpp
      dv.setUint32(30, 0, true);                          // BI_RGB (no compression)
      dv.setUint32(34, pixelArraySize, true);
      dv.setUint32(38, 2835, true);                       // 72 DPI
      dv.setUint32(42, 2835, true);
      dv.setUint32(46, 0, true); dv.setUint32(50, 0, true);
      // Pixel data: BGRA, top-down
      const src = imgData.data;
      let p = 54;
      for (let i = 0; i < src.length; i += 4) {
        u8[p++] = src[i + 2]; // B
        u8[p++] = src[i + 1]; // G
        u8[p++] = src[i];     // R
        u8[p++] = src[i + 3]; // A
      }
      return new Blob([buffer], { type: 'image/bmp' });
    }
    // TIFF: uses UTIF.encode (RGBA8 buffer)
    function canvasToTiffBlob(canvas) {
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const tiffBuf = UTIF.encodeImage(imgData.data, canvas.width, canvas.height);
      return new Blob([tiffBuf], { type: 'image/tiff' });
    }
    // PDF: 1 canvas = 1 PDF page (sized to canvas)
    function canvasToPdfBlob(canvas) {
      // 透過PNG/AVIF/TIFF→PDF の黒化け防止: JPEG化の前に透過部を白で埋める (FAQ「PDFは白背景に変換」と整合)
      flattenWhite(canvas);
      const jpegData = canvas.toDataURL('image/jpeg', QUALITY[quality]);
      // Use mm with 96dpi conversion
      const wMm = canvas.width * 25.4 / 96;
      const hMm = canvas.height * 25.4 / 96;
      const orient = wMm > hMm ? 'landscape' : 'portrait';
      const doc = new jsPDF({ orientation: orient, unit: 'mm', format: [wMm, hMm] });
      doc.addImage(jpegData, 'JPEG', 0, 0, wMm, hMm);
      return doc.output('blob');
    }

    function extFor(format) {
      return {
        jpg: 'jpg',
        png: 'png',
        pdf: 'pdf',
        bmp: 'bmp',
        tiff: 'tiff'
      }[format];
    }

    // 出力名が重複したら「name (2).ext」形式の連番を振る (JSZip.file は同名上書きで無言消失するため)
    function uniqueFilename(name, usedNames) {
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (usedNames.has(`${stem} (${n})${ext}`)) n++;
      const result = `${stem} (${n})${ext}`;
      usedNames.add(result);
      return result;
    }

    async function canvasToOutputBlob(canvas, format) {
      if (format === 'jpg') return canvasToJpegBlob(canvas);
      if (format === 'png') return canvasToPngBlob(canvas);
      if (format === 'pdf') return canvasToPdfBlob(canvas);
      if (format === 'bmp') return canvasToBmpBlob(canvas);
      if (format === 'tiff') return canvasToTiffBlob(canvas);
      throw new Error('Unknown format: ' + format);
    }

    // download は 00-core の共有 triggerDownload(blob, name) を使う(script トップレベルで全モード共通)

    async function convertAll() {
      if (files.length === 0 || isConverting) return;
      isConverting = true;
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      if (progressWrap) progressWrap.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      setStatus('変換中...', 'info');
      await new Promise(r => setTimeout(r, 50));

      const outputs = []; // {blob, filename}
      const usedNames = new Set();   // ZIP内の同名上書き(無言消失)防止用
      const failedNames = [];        // 変換失敗ファイル(1件の失敗で全滅させない)
      const totalOutputs = files.reduce((s, f) => s + f.pageCount, 0);
      let completed = 0;
      let totalSize = 0;
      let successFlag = false;

      try {
        for (let fi = 0; fi < files.length; fi++) {
          const f = files[fi];
          setStatus(`変換中 (${fi + 1}/${files.length}) ${f.name}`, 'info');
          await new Promise(r => setTimeout(r, 0));

          // 1ファイルの失敗(巨大画像のcanvas上限超過・破損等)は記録して続行する
          try {
            const canvasList = await loadToCanvases(f.file);
            for (const { canvas, baseName } of canvasList) {
              const blob = await canvasToOutputBlob(canvas, outputFormat);
              // canvas上限超過などで toBlob が null を返すことがある → このファイルだけ失敗扱いにする
              if (!blob) throw new Error('エンコード失敗(画像が大きすぎる可能性)');
              const filename = uniqueFilename(`${baseName}.${extFor(outputFormat)}`, usedNames);
              outputs.push({ blob, filename });
              totalSize += blob.size;
              completed++;
              if (progressBar) {
                progressBar.style.width = Math.round(completed / totalOutputs * 100) + '%';
              }
              // Free memory
              canvas.width = 0; canvas.height = 0;
            }
          } catch (perFileErr) {
            console.error('Conv error:', f.name, perFileErr);
            failedNames.push(f.name);
          }
        }

        if (outputs.length === 0) {
          throw new Error(failedNames.length ? `全${failedNames.length}件の変換に失敗しました` : '出力0件');
        }

        // v3.6.0: 出力前メタデータ除去 (PDF限定ガード — 画像形式は素通し)
        if (outputFormat === 'pdf' && window.PdfSanitize) {
          setStatus('PDFメタデータ除去中...', 'info');
          let _encSkipped = false;
          for (let i = 0; i < outputs.length; i++) {
            outputs[i].blob = await window.PdfSanitize.process(outputs[i].blob);
            if (window.PdfSanitize._lastSkippedEncrypted) _encSkipped = true;
          }
          if (_encSkipped) setStatus('暗号化PDFはメタデータ除去をスキップしました', 'info');
        }

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;

        // 個別DL かつ 2枚以上 → ブラウザの「複数ファイルDL許可」プロンプト回避のため
        // 自動で ZIP にまとめる。1枚だけの時はそのまま個別DL。
        const effectiveMode = (outputMode === 'individual' && outputs.length > 1) ? 'zip' : outputMode;
        const autoZipped = (effectiveMode === 'zip' && outputMode !== 'zip');

        if (effectiveMode === 'zip') {
          setStatus('ZIP作成中...', 'info');
          await new Promise(r => setTimeout(r, 10));
          const zip = new JSZip();
          outputs.forEach(o => zip.file(o.filename, o.blob));
          const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          const convUserName = (document.getElementById('convFilenameInput')?.value || '').trim();
          let convZipName;
          if (convUserName) {
            convZipName = `${appendTimestamp(convUserName, 'convFilenameTs')}.zip`;
          } else {
            convZipName = `converted_${outputFormat}_${ts}.zip`;
          }
          triggerDownload(zipBlob, convZipName);
          const zipSizeMB = (zipBlob.size / (1024 * 1024)).toFixed(2);
          const autoZipNote = autoZipped ? ' (複数ファイルのためZIPに自動集約)' : '';
          setStatus(`✓ ${outputs.length}枚変換 · ZIP ${zipSizeMB} MB${autoZipNote}`, 'success');
          showSuccess({
            title: '変換完了',
            subtitle: autoZipped
              ? `複数ファイル→ZIPダウンロードが始まりました`
              : `ZIPダウンロードが始まりました`,
            stats: [
              { label: '変換ファイル', value: `${outputs.length} 枚`, highlight: true },
              { label: '出力形式', value: outputFormat.toUpperCase() },
              { label: 'ZIPサイズ', value: `${zipSizeMB} MB` }
            ]
          });
        } else {
          // Individual download: trigger one by one with a small stagger
          const convUserNameInd = (document.getElementById('convFilenameInput')?.value || '').trim();
          const tsSuffix = isTimestampEnabled('convFilenameTs') ? `_${makeTimestamp()}` : '';
          for (let i = 0; i < outputs.length; i++) {
            let fname = outputs[i].filename;
            if (convUserNameInd) {
              const ext = extFor(outputFormat);
              if (outputs.length === 1) {
                fname = `${convUserNameInd}${tsSuffix}.${ext}`;
              } else {
                fname = `${convUserNameInd}_${String(i + 1).padStart(2, '0')}${tsSuffix}.${ext}`;
              }
            }
            triggerDownload(outputs[i].blob, fname);
            if (i < outputs.length - 1) await new Promise(r => setTimeout(r, 250));
          }
          const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
          setStatus(`✓ ${outputs.length}枚変換 · 合計 ${totalMB} MB`, 'success');
          showSuccess({
            title: '変換完了',
            subtitle: `${outputs.length}件のダウンロードが始まりました`,
            stats: [
              { label: '変換ファイル', value: `${outputs.length} 枚`, highlight: true },
              { label: '出力形式', value: outputFormat.toUpperCase() },
              { label: '合計サイズ', value: `${totalMB} MB` }
            ]
          });
        }
        // 失敗ファイルがあれば成功表示を上書きして必ず知らせる(完走分はダウンロード済み)
        if (failedNames.length) {
          setStatus(`⚠ ${failedNames.length}件失敗: ${failedNames.join(' / ')}(他の ${outputs.length} 枚は変換・ダウンロード済み)`, 'error');
        }
        successFlag = true;
      } catch (err) {
        console.error(err);
        // どこまで進んでたかも示す (完全失敗 vs 途中失敗の区別)
        const progressInfo = completed > 0 ? `${completed}/${totalOutputs}まで変換、残りで失敗。` : '全て失敗。';
        setStatus(`✕ ${progressInfo} エラー: ${err.message}`, 'error');
      }

      isConverting = false;   // 成功・失敗どちらでも必ず解除 (catch後にここへ到達する)
      generateBtn.disabled = false;
      clearBtn.disabled = false;
      // 変換成功時のみ保持ファイルを破棄 (次の作業に備えてリセット)
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
  // PDF EDIT MODE (delete / reorder / rotate / split)
  // =========================================================
