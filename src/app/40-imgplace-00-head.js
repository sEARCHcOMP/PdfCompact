  (function imgPlaceModule() {
    'use strict';

    // ----- 状態 -----
    let basePdfBytes = null;
    let pdfjsDoc = null;
    let pageCount = 0;
    let pageSizesMm = [];
    let currentPageIndex = 0;
    let isRendering = false;
    let renderPending = false; // 描画中に来た再描画要求(後勝ちで1件だけ覚え、描画完了後に消化)
    // 画像ライブラリ: [{ id, filename, mimeType, dataUrl, originalWidthPx, originalHeightPx }]
    let imageLibrary = [];
    // 配置: [{ id, pageIndex, imageId, xMm, yMm, widthMm, heightMm, aspectLocked, caption }]
    let placements = [];
    // 選択中の placement IDs（複数選択対応）
    let selectedPlacementIds = new Set();
    // 主選択（プロパティパネル表示・リサイズハンドル表示の対象、最後にクリックしたもの）
    let selectedPlacementId = null;
    // ラバーバンド選択状態 { startXMm, startYMm, startClientX, startClientY, moved, el, addMode, lastXMm, lastYMm }
    let rubberState = null;
    let libSeq = 0;
    let plSeq = 0;
    // ライブラリからのドラッグ中の画像ID
    let draggingLibImageId = null;
    // ライブラリ複数選択 (選択順序を保持するため Array)
    let libSelectedIds = [];
    let libLastClickedId = null; // shift範囲選択の基点
    // ベース PDF ページの複数選択 (一括削除用)
    let pageSelectedIndices = new Set();
    let pageLastClickedIndex = null;
    // 順次配置モード: 選択した順に Canvas クリックで配置
    let placeQueue = [];
    let placeQueueMode = false;
    // 移動/リサイズ中のドラッグ状態
    // 形: { mode:'move'|'resize', corner?:'nw'|'ne'|'sw'|'se', placementId, startMouseXMm, startMouseYMm, original:{xMm,yMm,widthMm,heightMm} }
    let dragState = null;
    // プロパティパネルの数値入力 DOM 参照（smart-sync 用）
    let propsInputs = { x: null, y: null, w: null, h: null };
    // スナップ機能の状態
    let snapEnabled = (function() {
      try { return localStorage.getItem('imgPlaceSnapEnabled') !== 'false'; }
      catch (e) { return true; }
    })();
    // 現在表示中のスナップガイド線 [{type:'v'|'h', mm:number}, ...]
    let activeGuides = [];
    // キャプション一括フォント設定（localStorage 永続）
    let captionFont = (function() {
      try { return localStorage.getItem('imgPlaceCaptionFont') || "'Noto Sans JP', sans-serif"; }
      catch (e) { return "'Noto Sans JP', sans-serif"; }
    })();
    // PDF出力時に埋め込む日本語フォント（Noto Sans JP 固定。display 用 captionFont とは別）
    // 一度ダウンロードしたら ArrayBuffer を保持して再利用
    let cachedNotoRegular = null;
    let cachedNotoBold = null;
    // IndexedDB autosave 状態
    let autosaveBaseSha = null;            // 現在のベースPDFのSHA-256（autosave key）
    let autosaveTimer = null;              // debounce タイマー
    let cachedBasePdfBase64 = null;        // base PDF base64 のキャッシュ（autosave 性能対策）
    let autosaveBaseFilename = 'base.pdf'; // 元のファイル名（autosave 表示用）
    const AUTOSAVE_DEBOUNCE_MS = 5000;
    const IDB_DB_NAME = 'pdfCompactImgPlace';
    const IDB_STORE = 'autosave';
    // タッチ複数指追跡 + ピンチリサイズ状態
    const activeTouches = new Map(); // pointerId → { clientX, clientY, placementId }
    let pinchState = null;           // { placementId, startDistance, original: {xMm, yMm, widthMm, heightMm} }

    // ----- 定数 -----
    const PT_PER_MM = 72 / 25.4;
    const MAX_PDF_BYTES = 50 * 1024 * 1024;
    const MAX_IMG_BYTES = 20 * 1024 * 1024;
    const THUMB_SCALE = 0.28;
    const MAX_RENDER_SCALE = 4; // メモリ上限ガード（A3でも約64MB以内）
    const ACCEPTED_IMG_TYPES = ['image/jpeg', 'image/png'];
    const ACCEPTED_IMG_EXT = /\.(jpe?g|png)$/i;

    // ----- DOM -----
    const dropzone = document.getElementById('imgPlacePdfDropzone');
    const fileInput = document.getElementById('imgPlacePdfInput');
    const statusEl = document.getElementById('imgPlacePdfStatus');
    const clearBtn = document.getElementById('imgPlaceClearBtn');
    const editorPanel = document.getElementById('imgPlaceEditorPanel');
    const pageList = document.getElementById('imgPlacePageList');
    const pagesPanel = document.getElementById('imgPlacePagesPanel');
    const canvas = document.getElementById('imgPlaceCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    const canvasFrame = document.getElementById('imgPlaceCanvasFrame');
    const overlay = document.getElementById('imgPlaceOverlay');
    const libDropzone = document.getElementById('imgPlaceLibDropzone');
    const libInput = document.getElementById('imgPlaceLibInput');
    const libList = document.getElementById('imgPlaceLibList');
    const libWrap = libList ? libList.closest('.imgplace-library') : null;
    const trashEl = document.getElementById('imgPlaceTrash');
    // ゴミ箱は document.body 直下に移動（ghost と同じ stacking context にして z-index を確実に効かせる）
    if (trashEl && trashEl.parentNode !== document.body) {
      document.body.appendChild(trashEl);
    }
    const snapBtn = document.getElementById('imgPlaceSnapBtn');
    const snapLabel = document.getElementById('imgPlaceSnapLabel');
    const fontSelect = document.getElementById('imgPlaceFontSelect');
    const saveProjectBtn = document.getElementById('imgPlaceSaveProjectBtn');
    const loadProjectBtn = document.getElementById('imgPlaceLoadProjectBtn');
    const loadProjectInput = document.getElementById('imgPlaceLoadProjectInput');
    const exportPdfBtn = document.getElementById('imgPlaceExportPdfBtn');
    const lineDetectBtn = document.getElementById('imgPlaceLineDetectBtn');
    const linesOverlay = document.getElementById('imgPlaceLinesOverlay');
    let lineDetectionEnabled = false;
    // 検出した罫線をスナップ対象に変換した結果（mm単位、左上原点）。OFF時は null
    // 形式: { vXsMm: [x1, x2, ...], hYsMm: [y1, y2, ...] }
    let detectedSnapTargets = null;
    // ユーザー手動定義のカスタムセル: { pageIndex: [{xMm, yMm, widthMm, heightMm}, ...] }
    let customCellsByPage = {};
    let customCellModeOn = false;
    // 画像配置時のサイズ上限 (ページ 1/3) を効かせるか。localStorage 永続化、デフォルト ON
    let sizeCapEnabled = true;
    try {
      const saved = localStorage.getItem('imgPlaceSizeCap');
      if (saved === 'off') sizeCapEnabled = false;
    } catch (_e) {}
    // スナップ中のセル (緑外枠ハイライト用)
    let activeSnapCell = null;
    // カスタムセル描画中の state
    let customCellDrawState = null;
    const metaEl = document.getElementById('imgPlaceMeta');
    const filenameBar = document.getElementById('imgPlaceFilenameBar');
    const actionBar = document.getElementById('imgPlaceActionBar');

    if (!dropzone || !canvas) return; // パネル未配置時は無効化

    // ----- 単位変換 -----
    function ptToMm(pt) { return pt / PT_PER_MM; }
    // mmToPt は段階E (PDF出力) で使用予定

    // ----- ステータス表示 -----
    function setStatus(text, type) {
      if (statusEl) {
        if (!text) {
          statusEl.style.display = 'none';
          statusEl.textContent = '';
          statusEl.classList.remove('error');
        } else {
          statusEl.style.display = '';
          statusEl.textContent = text;
          statusEl.classList.toggle('error', type === 'error');
        }
      }
      // ミラー: アクションバー中央 (罫線スナップなど検出結果が常時見える位置)。共有helperに委譲
      setActionBarStatus(document.getElementById('imgPlaceActionBarStatus'), text, type);
    }

    // ----- クリア（やり直し） -----
    function clearBase() {
      basePdfBytes = null;
      pdfjsDoc = null;
      pageCount = 0;
      pageSizesMm = [];
      currentPageIndex = 0;
      imageLibrary = [];
      placements = [];
      clearSelection();
      if (dragState && dragState.ghost) destroyDragGhost(dragState.ghost);
      dragState = null;
      activeGuides = [];
      // autosave 状態リセット
      cancelAutosaveTimer();
      autosaveBaseSha = null;
      autosaveBaseFilename = 'base.pdf';
      cachedBasePdfBase64 = null;
      if (rubberState && rubberState.el && rubberState.el.parentNode) {
        rubberState.el.parentNode.removeChild(rubberState.el);
      }
      rubberState = null;
      if (pageList) pageList.innerHTML = '';
      if (libList) libList.innerHTML = '';
      if (overlay) overlay.innerHTML = '';
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
      }
      if (metaEl) metaEl.textContent = '';
      if (editorPanel) editorPanel.style.display = 'none';
      if (filenameBar) filenameBar.style.display = 'none';
      if (actionBar) actionBar.style.display = 'none';
      // 編集モード OFF: hero+upload panel 再表示
      const modeImgPlaceEl = document.getElementById('modeImgPlace');
      if (modeImgPlaceEl) modeImgPlaceEl.classList.remove('imgplace-editing');
      hideTrash();
      const modePanel = document.getElementById('modeImgPlace');
      if (modePanel) modePanel.classList.remove('imgplace-dragging');
      // Lv.2: 罫線スナップ状態もリセット
      detectedSnapTargets = null;
      if (linesOverlay) {
        while (linesOverlay.firstChild) linesOverlay.removeChild(linesOverlay.firstChild);
        linesOverlay.classList.remove('visible');
      }
      if (lineDetectionEnabled && lineDetectBtn) {
        lineDetectionEnabled = false;
        lineDetectBtn.dataset.active = 'off';
        lineDetectBtn.textContent = '📐 罫線スナップ OFF';
      }
      // カスタムセル + ハイライト + アライメントガイドもリセット
      customCellsByPage = {};
      activeSnapCell = null;
      updateActiveSnapCellOverlay();
      clearAlignmentGuides();
      // ライブラリ複数選択 + 順次配置モードもリセット
      libSelectedIds = [];
      libLastClickedId = null;
      if (placeQueueMode) stopPlaceQueueMode();
      updatePlaceQueueBtn();
      // ベースPDFページ複数選択もリセット
      pageSelectedIndices.clear();
      pageLastClickedIndex = null;
      const customCellLayer = document.getElementById('imgPlaceCustomCellLayer');
      if (customCellLayer) customCellLayer.innerHTML = '';
      const customCellBtn = document.getElementById('imgPlaceCustomCellBtn');
      if (customCellModeOn && customCellBtn) {
        customCellModeOn = false;
        customCellBtn.dataset.active = 'off';
        customCellBtn.textContent = '✏️ カスタムセル OFF';
        if (customCellLayer) customCellLayer.classList.remove('active');
      }
      setStatus('');
    }

    // ----- ベースPDF読込 (初回は新規読込、2回目以降は末尾に追加) -----
    async function loadBasePdf(file) {
      if (!file) return;
      if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        setStatus('PDFファイルを選んでください', 'error');
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        setStatus('PDFサイズが50MBを超えています（' + (file.size / 1024 / 1024).toFixed(1) + 'MB）', 'error');
        return;
      }
      const isAppend = !!basePdfBytes;
      setStatus(isAppend ? '末尾にページ追加中…' : '読み込み中…');
      try {
        const newBytes = await file.arrayBuffer();
        let addedPageCount = 0;
        if (isAppend) {
          // pdf-lib で 既存PDF に新PDF のページを末尾追加
          const PDFLib = window.PDFLib;
          if (!PDFLib || !PDFLib.PDFDocument) throw new Error('pdf-lib が利用不可');
          const existingDoc = await PDFLib.PDFDocument.load(basePdfBytes);
          const newDoc = await PDFLib.PDFDocument.load(newBytes);
          const copiedPages = await existingDoc.copyPages(newDoc, newDoc.getPageIndices());
          addedPageCount = copiedPages.length;
          for (const pg of copiedPages) existingDoc.addPage(pg);
          basePdfBytes = (await existingDoc.save()).buffer;
        } else {
          basePdfBytes = newBytes;
        }
        // pdf.js は ArrayBuffer を内部で消費するためスライスして渡す
        pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
        const oldPageCount = pageCount;
        pageCount = pdfjsDoc.numPages;
        pageSizesMm = [];

        for (let i = 1; i <= pageCount; i++) {
          const p = await pdfjsDoc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          pageSizesMm.push({
            width: ptToMm(vp.width),
            height: ptToMm(vp.height)
          });
        }

        if (!isAppend) {
          currentPageIndex = 0;
          editorPanel.style.display = '';
          filenameBar.style.display = '';
          actionBar.style.display = '';
          // 編集モード ON: hero+upload panel を CSS で隠して editor が viewport 上部に
          const modeImgPlaceEl = document.getElementById('modeImgPlace');
          if (modeImgPlaceEl) modeImgPlaceEl.classList.add('imgplace-editing');
        }
        // autosave 状態を準備（base64 キャッシュは初回 serialize 時に作る）
        cachedBasePdfBase64 = null;
        if (!isAppend) autosaveBaseFilename = file.name || 'base.pdf';
        autosaveBaseSha = await sha256Hex(basePdfBytes);
        renderLibrary(); // 初期表示時に「画像なし」状態クラスを反映
        await renderThumbnails();
        await renderCurrentPage();
        updateMeta(autosaveBaseFilename);
        if (isAppend) {
          setStatus('「' + file.name + '」の ' + addedPageCount + ' ページを末尾に追加 (合計 ' + pageCount + ' ページ)');
          // 追加後の最初のページにジャンプ
          if (oldPageCount < pageCount) {
            currentPageIndex = oldPageCount;
            await renderCurrentPage();
            // サムネ active 更新
            pageList.querySelectorAll('.page-thumb-wrap').forEach((el, idx) => {
              el.classList.toggle('active', idx === currentPageIndex);
            });
          }
          scheduleAutosave();
        } else {
          setStatus(file.name + ' を読み込みました（' + pageCount + 'ページ）');
        }
        // 初回ロードのみ: スクロール + 復元提案
        if (!isAppend) {
          requestAnimationFrame(() => {
            editorPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          const shaForRestore = autosaveBaseSha;
          setTimeout(() => { checkAndOfferRestore(shaForRestore); }, 100);
        }
      } catch (err) {
        console.error('[imgPlace] PDF読込失敗:', err);
        setStatus('PDF読込に失敗しました: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    // ----- ページ削除 (pdf-lib で removePage → placements/customCells インデックス再マップ) -----
    async function deletePage(pageIndex) {
      if (!basePdfBytes) {
        setStatus('PDFが読み込まれていません', 'error');
        return;
      }
      if (pageCount <= 1) {
        setStatus('最後の1ページは削除できません', 'error');
        return;
      }
      const placementsOnThis = placements.filter(p => p.pageIndex === pageIndex).length;
      const cellsOnThis = (customCellsByPage[pageIndex] || []).length;
      let msg = 'ページ ' + (pageIndex + 1) + ' を削除しますか?';
      if (placementsOnThis || cellsOnThis) {
        msg += '\n(配置画像 ' + placementsOnThis + ' 枚 / カスタムセル ' + cellsOnThis + ' 個 もまとめて削除)';
      }
      if (!confirm(msg)) return;
      try {
        const PDFLib = window.PDFLib;
        if (!PDFLib || !PDFLib.PDFDocument) throw new Error('pdf-lib 未読込');
        const doc = await PDFLib.PDFDocument.load(basePdfBytes);
        doc.removePage(pageIndex);
        basePdfBytes = (await doc.save()).buffer;
        pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
        pageCount = pdfjsDoc.numPages;
        pageSizesMm.splice(pageIndex, 1);

        // 配置画像: 削除ページ上のものは破棄、それ以降のページはインデックス -1
        placements = placements
          .filter(p => p.pageIndex !== pageIndex)
          .map(p => p.pageIndex > pageIndex ? Object.assign({}, p, { pageIndex: p.pageIndex - 1 }) : p);

        // カスタムセル: 削除ページのキーを除外、それ以降のキーを -1 シフト
        const newCells = {};
        for (const k of Object.keys(customCellsByPage)) {
          const ki = parseInt(k, 10);
          if (ki === pageIndex) continue;
          newCells[ki > pageIndex ? ki - 1 : ki] = customCellsByPage[k];
        }
        customCellsByPage = newCells;

        // currentPageIndex 調整
        if (currentPageIndex === pageIndex) {
          currentPageIndex = Math.min(pageIndex, pageCount - 1);
        } else if (currentPageIndex > pageIndex) {
          currentPageIndex -= 1;
        }

        clearSelection();
        cachedBasePdfBase64 = null;
        autosaveBaseSha = await sha256Hex(basePdfBytes);
        await renderThumbnails();
        await renderCurrentPage();
        setStatus('ページ ' + (pageIndex + 1) + ' を削除 (残り ' + pageCount + ' ページ)');
        scheduleAutosave();
      } catch (err) {
        console.error('[imgPlace] ページ削除失敗:', err);
        setStatus('ページ削除失敗: ' + (err.message || err), 'error');
      }
    }

    // ----- メタ情報 -----
    function updateMeta(filename) {
      if (!metaEl) return;
      const cur = pageSizesMm[currentPageIndex];
      if (!cur) {
        metaEl.textContent = '';
        return;
      }
      metaEl.textContent =
        'ファイル: ' + (filename || '(現在のPDF)') +
        ' | ページ: ' + (currentPageIndex + 1) + ' / ' + pageCount +
        ' | サイズ: ' + cur.width.toFixed(1) + ' × ' + cur.height.toFixed(1) + ' mm';
    }

    // ----- PoC: pdf.js page から罫線抽出（CTM追跡 + curve飛ばし + 極小線フィルタ） -----
    // OPS.save/restore/transform で current transformation matrix (CTM) を維持
    // OPS.constructPath の中の moveTo/lineTo/curve*/rectangle/closePath を順に解析
    // 抽出した line/rect は CTM を適用してユーザー空間（pt）座標に変換
    // 最後に極小線（< 2pt ≈ 0.7mm）はノイズ扱いで除外
