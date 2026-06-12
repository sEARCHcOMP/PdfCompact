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
      // ミラー: アクションバー中央 (罫線スナップなど検出結果が常時見える位置)
      const abs = document.getElementById('imgPlaceActionBarStatus');
      if (abs) {
        abs.textContent = text || '';
        abs.classList.toggle('visible', !!text);
        abs.classList.toggle('error', type === 'error');
        abs.classList.toggle('success', type === 'success' || type === 'done');
      }
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
    async function extractPageLines(page) {
      const opList = await page.getOperatorList();
      const OPS = pdfjsLib.OPS;
      const lines = [];
      const rects = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const mul = (m1, m2) => [
        m1[0]*m2[0] + m1[2]*m2[1],
        m1[1]*m2[0] + m1[3]*m2[1],
        m1[0]*m2[2] + m1[2]*m2[3],
        m1[1]*m2[2] + m1[3]*m2[3],
        m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
        m1[1]*m2[4] + m1[3]*m2[5] + m1[5]
      ];
      const apply = (x, y) => [
        ctm[0]*x + ctm[2]*y + ctm[4],
        ctm[1]*x + ctm[3]*y + ctm[5]
      ];

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];
        if (fn === OPS.save) {
          stack.push(ctm.slice());
        } else if (fn === OPS.restore) {
          if (stack.length) ctm = stack.pop();
        } else if (fn === OPS.transform) {
          ctm = mul(ctm, args);
        } else if (fn === OPS.constructPath) {
          const ops = args[0];
          const opArgs = args[1];
          let argIdx = 0;
          let curX = 0, curY = 0;
          for (const op of ops) {
            if (op === OPS.moveTo) {
              curX = opArgs[argIdx++];
              curY = opArgs[argIdx++];
            } else if (op === OPS.lineTo) {
              const x = opArgs[argIdx++];
              const y = opArgs[argIdx++];
              const [tx1, ty1] = apply(curX, curY);
              const [tx2, ty2] = apply(x, y);
              lines.push({ x1: tx1, y1: ty1, x2: tx2, y2: ty2 });
              curX = x; curY = y;
            } else if (op === OPS.curveTo) {
              argIdx += 6; // 3 control pts + endpoint
              curX = opArgs[argIdx-2]; curY = opArgs[argIdx-1];
            } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
              argIdx += 4;
              curX = opArgs[argIdx-2]; curY = opArgs[argIdx-1];
            } else if (op === OPS.closePath) {
              // no args
            } else if (op === OPS.rectangle) {
              const x = opArgs[argIdx++];
              const y = opArgs[argIdx++];
              const w = opArgs[argIdx++];
              const h = opArgs[argIdx++];
              const [tx1, ty1] = apply(x, y);
              const [tx2, ty2] = apply(x + w, y + h);
              rects.push({
                x: Math.min(tx1, tx2),
                y: Math.min(ty1, ty2),
                w: Math.abs(tx2 - tx1),
                h: Math.abs(ty2 - ty1)
              });
            } else {
              // 未対応 op が来た時点で path 終了（args 数不明のため）
              break;
            }
          }
        }
      }

      // ノイズ除去: 10mm未満の短い線は装飾(ロゴ・テキスト等)とみなして罫線扱いしない
      // ※セル最小サイズ MIN_CELL_SIZE_MM=15mm より小さく取って、セル境界は確実に拾う
      const MIN_LEN_PT = 10 * (72 / 25.4); // 10mm ≒ 28.35pt
      const filtered = lines.filter(l => {
        const dx = l.x2 - l.x1;
        const dy = l.y2 - l.y1;
        return Math.sqrt(dx*dx + dy*dy) >= MIN_LEN_PT;
      });
      return { lines: filtered, rects: rects, totalLinesBeforeFilter: lines.length };
    }

    // ----- セル系ヘルパー（検出セル + カスタムセルの統合 + ハイライト） -----
    // 現ページで snap 対象になる「セル」を全部返す（検出 + カスタム）
    function getActiveCells() {
      const out = [];
      if (detectedSnapTargets && Array.isArray(detectedSnapTargets.cellCentersMm)) {
        for (const c of detectedSnapTargets.cellCentersMm) out.push(c);
      }
      const custom = customCellsByPage[currentPageIndex];
      if (custom) for (const c of custom) out.push(c);
      return out;
    }
    // カスタムセル編集時に1点 (xMm, yMm) を検出罫線へスナップ
    // detectedSnapTargets が無い時はそのまま返す
    function snapPointToDetectedLines(xMm, yMm) {
      if (!detectedSnapTargets) return { xMm: xMm, yMm: yMm };
      const threshold = (typeof getSnapThresholdMm === 'function') ? getSnapThresholdMm() : 3.0;
      let outX = xMm, outY = yMm;
      let bestDx = threshold, bestDy = threshold;
      const vXs = detectedSnapTargets.vXsMm || [];
      const hYs = detectedSnapTargets.hYsMm || [];
      for (let i = 0; i < vXs.length; i++) {
        const d = Math.abs(vXs[i] - xMm);
        if (d <= bestDx) { bestDx = d; outX = vXs[i]; }
      }
      for (let i = 0; i < hYs.length; i++) {
        const d = Math.abs(hYs[i] - yMm);
        if (d <= bestDy) { bestDy = d; outY = hYs[i]; }
      }
      return { xMm: outX, yMm: outY };
    }

    // カスタムセル編集 (描画/移動/リサイズ) の統合スナップ
    //   xCands: スナップを検討する X 座標群 (例: 移動中なら [xL, xR, xC])
    //   yCands: 同様の Y 座標群
    //   excludeCell: 自分自身は他セルから除外
    // 戻り値: { dx, dy, vGuide, hGuide }
    //   vGuide: { xMm, sources:[{srcRange:[yT,yB]|null}, ...] } | null
    //   hGuide: { yMm, sources:[{srcRange:[xL,xR]|null}, ...] } | null
    //   srcRange=null は「検出罫線(全頁線)」を意味する
    function computeCustomCellSnap(xCands, yCands, excludeCell) {
      const threshold = (typeof getSnapThresholdMm === 'function') ? getSnapThresholdMm() : 3.0;
      const otherCells = (customCellsByPage[currentPageIndex] || []).filter(c => c !== excludeCell);
      // V targets (X 値とソース範囲)
      const vTargets = [];
      if (detectedSnapTargets) {
        for (const x of (detectedSnapTargets.vXsMm || [])) vTargets.push({ xMm: x, srcRange: null });
      }
      for (const oc of otherCells) {
        const xL = oc.xMm - oc.widthMm / 2;
        const xR = oc.xMm + oc.widthMm / 2;
        const yT = oc.yMm - oc.heightMm / 2;
        const yB = oc.yMm + oc.heightMm / 2;
        vTargets.push({ xMm: xL, srcRange: [yT, yB] });
        vTargets.push({ xMm: xR, srcRange: [yT, yB] });
        vTargets.push({ xMm: oc.xMm, srcRange: [yT, yB] });
      }
      // H targets
      const hTargets = [];
      if (detectedSnapTargets) {
        for (const y of (detectedSnapTargets.hYsMm || [])) hTargets.push({ yMm: y, srcRange: null });
      }
      for (const oc of otherCells) {
        const xL = oc.xMm - oc.widthMm / 2;
        const xR = oc.xMm + oc.widthMm / 2;
        const yT = oc.yMm - oc.heightMm / 2;
        const yB = oc.yMm + oc.heightMm / 2;
        hTargets.push({ yMm: yT, srcRange: [xL, xR] });
        hTargets.push({ yMm: yB, srcRange: [xL, xR] });
        hTargets.push({ yMm: oc.yMm, srcRange: [xL, xR] });
      }
      // V スナップ best
      let bestDx = null, bestVCoord = null, bestVSources = [];
      for (const xc of xCands) {
        for (const t of vTargets) {
          const d = t.xMm - xc;
          const ad = Math.abs(d);
          if (ad > threshold) continue;
          if (bestDx === null || ad < Math.abs(bestDx) - 1e-6) {
            bestDx = d; bestVCoord = t.xMm; bestVSources = [t];
          } else if (Math.abs(t.xMm - (bestVCoord || 0)) < 0.01) {
            bestVSources.push(t);
          }
        }
      }
      // H スナップ best
      let bestDy = null, bestHCoord = null, bestHSources = [];
      for (const yc of yCands) {
        for (const t of hTargets) {
          const d = t.yMm - yc;
          const ad = Math.abs(d);
          if (ad > threshold) continue;
          if (bestDy === null || ad < Math.abs(bestDy) - 1e-6) {
            bestDy = d; bestHCoord = t.yMm; bestHSources = [t];
          } else if (Math.abs(t.yMm - (bestHCoord || 0)) < 0.01) {
            bestHSources.push(t);
          }
        }
      }
      return {
        dx: bestDx || 0,
        dy: bestDy || 0,
        vGuide: bestVCoord !== null ? { xMm: bestVCoord, sources: bestVSources } : null,
        hGuide: bestHCoord !== null ? { yMm: bestHCoord, sources: bestHSources } : null
      };
    }

    // アライメントガイド SVG への描画 / クリア
    // movingRect: { xL, xR, yT, yB } — 編集中セルの範囲（ガイド線がそこも通るように長さ算出）
    function renderAlignmentGuides(vGuide, hGuide, movingRect) {
      const svg = document.getElementById('imgPlaceAlignGuides');
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      svg.setAttribute('viewBox', '0 0 ' + pageSize.width + ' ' + pageSize.height);
      const svgNs = 'http://www.w3.org/2000/svg';
      const DOT_R = 1.4; // mm

      if (vGuide) {
        let yMin = movingRect.yT, yMax = movingRect.yB;
        let fullPage = false;
        const dotYs = [movingRect.yT, movingRect.yB];
        for (const s of vGuide.sources) {
          if (!s.srcRange) { fullPage = true; }
          else {
            yMin = Math.min(yMin, s.srcRange[0]);
            yMax = Math.max(yMax, s.srcRange[1]);
            dotYs.push(s.srcRange[0], s.srcRange[1]);
          }
        }
        if (fullPage) { yMin = 0; yMax = pageSize.height; }
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', vGuide.xMm); line.setAttribute('y1', yMin);
        line.setAttribute('x2', vGuide.xMm); line.setAttribute('y2', yMax);
        line.setAttribute('class', 'align-line');
        svg.appendChild(line);
        for (const y of dotYs) {
          const c = document.createElementNS(svgNs, 'circle');
          c.setAttribute('cx', vGuide.xMm); c.setAttribute('cy', y);
          c.setAttribute('r', DOT_R);
          c.setAttribute('class', 'align-dot');
          svg.appendChild(c);
        }
      }
      if (hGuide) {
        let xMin = movingRect.xL, xMax = movingRect.xR;
        let fullPage = false;
        const dotXs = [movingRect.xL, movingRect.xR];
        for (const s of hGuide.sources) {
          if (!s.srcRange) { fullPage = true; }
          else {
            xMin = Math.min(xMin, s.srcRange[0]);
            xMax = Math.max(xMax, s.srcRange[1]);
            dotXs.push(s.srcRange[0], s.srcRange[1]);
          }
        }
        if (fullPage) { xMin = 0; xMax = pageSize.width; }
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', xMin); line.setAttribute('y1', hGuide.yMm);
        line.setAttribute('x2', xMax); line.setAttribute('y2', hGuide.yMm);
        line.setAttribute('class', 'align-line');
        svg.appendChild(line);
        for (const x of dotXs) {
          const c = document.createElementNS(svgNs, 'circle');
          c.setAttribute('cx', x); c.setAttribute('cy', hGuide.yMm);
          c.setAttribute('r', DOT_R);
          c.setAttribute('class', 'align-dot');
          svg.appendChild(c);
        }
      }
    }
    function clearAlignmentGuides() {
      const svg = document.getElementById('imgPlaceAlignGuides');
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    // スナップハイライト用: activeSnapCell を canvas-frame 上のオーバーレイ div に反映
    function updateActiveSnapCellOverlay() {
      const el = document.getElementById('imgPlaceActiveSnapCell');
      if (!el) return;
      if (!activeSnapCell) {
        el.style.display = 'none';
        return;
      }
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) { el.style.display = 'none'; return; }
      const c = activeSnapCell;
      const xL = c.xMm - c.widthMm / 2;
      const yT = c.yMm - c.heightMm / 2;
      el.style.display = '';
      el.style.left   = (xL / pageSize.width  * 100) + '%';
      el.style.top    = (yT / pageSize.height * 100) + '%';
      el.style.width  = (c.widthMm  / pageSize.width  * 100) + '%';
      el.style.height = (c.heightMm / pageSize.height * 100) + '%';
    }
    // カスタムセル個別の DOM 更新ヘルパー (リサイズ/移動中の頻繁更新で再描画を避けるため)
    function updateCustomCellDom(div, c) {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      const xL = c.xMm - c.widthMm / 2;
      const yT = c.yMm - c.heightMm / 2;
      div.style.left   = (xL / pageSize.width  * 100) + '%';
      div.style.top    = (yT / pageSize.height * 100) + '%';
      div.style.width  = (c.widthMm  / pageSize.width  * 100) + '%';
      div.style.height = (c.heightMm / pageSize.height * 100) + '%';
    }

    // カスタムセル: 編集 state (移動 / リサイズ)
    let customCellEditState = null; // { mode:'move'|'resize', cell, div, original, corner?, startXMm, startYMm, moved:bool }

    // カスタムセルを div として描画（編集モード ON 時はハンドル + × ボタン）
    function renderCustomCells() {
      const layer = document.getElementById('imgPlaceCustomCellLayer');
      if (!layer) return;
      // 描画中プレビューだけは保持
      const preview = layer.querySelector('.imgplace-custom-cell-preview');
      layer.innerHTML = '';
      if (preview) layer.appendChild(preview);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      const cells = customCellsByPage[currentPageIndex] || [];
      for (const c of cells) {
        const div = document.createElement('div');
        div.className = 'imgplace-custom-cell';
        updateCustomCellDom(div, c);
        div.title = customCellModeOn ? 'ドラッグで移動 / 隅を引っ張ってリサイズ / × で削除' : '';

        // ----- 本体ドラッグ = 移動 -----
        div.addEventListener('pointerdown', (e) => {
          if (!customCellModeOn) return;
          // ハンドルや×は別 handler が stopPropagation で先取り
          if (e.target !== div) return;
          e.preventDefault();
          e.stopPropagation();
          customCellEditState = {
            mode: 'move',
            cell: c,
            div: div,
            original: { xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm },
            startXMm: 0, startYMm: 0,
            moved: false
          };
          const start = getPagePosMm(e.clientX, e.clientY);
          if (start) {
            customCellEditState.startXMm = start.xMm;
            customCellEditState.startYMm = start.yMm;
          }
          try { div.setPointerCapture(e.pointerId); } catch (_e) {}
        });

        // ----- 4隅ハンドル: リサイズ -----
        ['nw','ne','sw','se'].forEach((corner) => {
          const h = document.createElement('div');
          h.className = 'imgplace-custom-cell-handle handle-' + corner;
          h.dataset.corner = corner;
          h.addEventListener('pointerdown', (e) => {
            if (!customCellModeOn) return;
            e.preventDefault();
            e.stopPropagation();
            customCellEditState = {
              mode: 'resize',
              cell: c,
              div: div,
              original: { xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm },
              corner: corner,
              startXMm: 0, startYMm: 0,
              moved: false
            };
            const start = getPagePosMm(e.clientX, e.clientY);
            if (start) {
              customCellEditState.startXMm = start.xMm;
              customCellEditState.startYMm = start.yMm;
            }
            try { h.setPointerCapture(e.pointerId); } catch (_e) {}
          });
          div.appendChild(h);
        });

        // ----- + 複製ボタン -----
        const copyBtn = document.createElement('div');
        copyBtn.className = 'imgplace-custom-cell-copy';
        copyBtn.textContent = '+';
        copyBtn.title = '複製';
        copyBtn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
        });
        copyBtn.addEventListener('click', (e) => {
          if (!customCellModeOn) return;
          e.stopPropagation();
          const pageSize = pageSizesMm[currentPageIndex];
          if (!pageSize) return;
          const OFFSET_MM = 5;
          const halfW = c.widthMm / 2;
          const halfH = c.heightMm / 2;
          // デフォルトで右下にオフセット、ページ外なら左上方向に反転
          let nx = c.xMm + OFFSET_MM;
          let ny = c.yMm + OFFSET_MM;
          if (nx + halfW > pageSize.width)  nx = c.xMm - OFFSET_MM;
          if (ny + halfH > pageSize.height) ny = c.yMm - OFFSET_MM;
          // ページ内 clamp
          nx = Math.max(halfW, Math.min(nx, pageSize.width  - halfW));
          ny = Math.max(halfH, Math.min(ny, pageSize.height - halfH));
          if (!customCellsByPage[currentPageIndex]) customCellsByPage[currentPageIndex] = [];
          customCellsByPage[currentPageIndex].push({
            xMm: nx, yMm: ny,
            widthMm: c.widthMm, heightMm: c.heightMm
          });
          renderCustomCells();
          scheduleAutosave && scheduleAutosave();
          setStatus('カスタムセル複製（合計 ' + customCellsByPage[currentPageIndex].length + ' 個）');
        });
        div.appendChild(copyBtn);

        // ----- × 削除ボタン -----
        const delBtn = document.createElement('div');
        delBtn.className = 'imgplace-custom-cell-delete';
        delBtn.textContent = '×';
        delBtn.title = '削除';
        delBtn.addEventListener('pointerdown', (e) => {
          // 移動 handler を発火させない
          e.stopPropagation();
        });
        delBtn.addEventListener('click', (e) => {
          if (!customCellModeOn) return;
          e.stopPropagation();
          const arr = customCellsByPage[currentPageIndex];
          if (!arr) return;
          const idx = arr.indexOf(c);
          if (idx !== -1) {
            arr.splice(idx, 1);
            if (arr.length === 0) delete customCellsByPage[currentPageIndex];
            renderCustomCells();
            scheduleAutosave && scheduleAutosave();
            setStatus('カスタムセル削除（残り ' + (arr.length) + ' 個）');
          }
        });
        div.appendChild(delBtn);

        layer.appendChild(div);
      }
    }

    // カスタムセル: 編集 (move/resize) のグローバル pointermove/up handler
    // div.setPointerCapture を使うので window 不要だが、保険で window でも捕捉
    function handleCustomCellEditMove(e) {
      if (!customCellEditState) return;
      const cur = getPagePosMm(e.clientX, e.clientY);
      if (!cur) return;
      const st = customCellEditState;
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      const MIN = 5; // 最小辺
      if (st.mode === 'move') {
        const dx = cur.xMm - st.startXMm;
        const dy = cur.yMm - st.startYMm;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) st.moved = true;
        let newCx = st.original.xMm + dx;
        let newCy = st.original.yMm + dy;
        // スナップ候補: 中心 + 4辺 (xL/xR/yT/yB) どれが揃ってもOK
        const halfW = st.cell.widthMm / 2;
        const halfH = st.cell.heightMm / 2;
        const xCands = [newCx - halfW, newCx + halfW, newCx];
        const yCands = [newCy - halfH, newCy + halfH, newCy];
        const snap = computeCustomCellSnap(xCands, yCands, st.cell);
        newCx += snap.dx;
        newCy += snap.dy;
        // ページ範囲内 clamp
        newCx = Math.max(halfW, Math.min(newCx, pageSize.width  - halfW));
        newCy = Math.max(halfH, Math.min(newCy, pageSize.height - halfH));
        st.cell.xMm = newCx;
        st.cell.yMm = newCy;
        updateCustomCellDom(st.div, st.cell);
        // ガイド線描画 (移動後 rect 範囲を渡す)
        renderAlignmentGuides(snap.vGuide, snap.hGuide, {
          xL: newCx - halfW, xR: newCx + halfW,
          yT: newCy - halfH, yB: newCy + halfH
        });
      } else if (st.mode === 'resize') {
        st.moved = true;
        const o = st.original;
        let xL = o.xMm - o.widthMm / 2;
        let xR = o.xMm + o.widthMm / 2;
        let yT = o.yMm - o.heightMm / 2;
        let yB = o.yMm + o.heightMm / 2;
        // 引いてる点を統合スナップ
        const snap = computeCustomCellSnap([cur.xMm], [cur.yMm], st.cell);
        const nx = cur.xMm + snap.dx;
        const ny = cur.yMm + snap.dy;
        const c = st.corner;
        if (c === 'nw') { xL = Math.min(nx, xR - MIN); yT = Math.min(ny, yB - MIN); }
        if (c === 'ne') { xR = Math.max(nx, xL + MIN); yT = Math.min(ny, yB - MIN); }
        if (c === 'sw') { xL = Math.min(nx, xR - MIN); yB = Math.max(ny, yT + MIN); }
        if (c === 'se') { xR = Math.max(nx, xL + MIN); yB = Math.max(ny, yT + MIN); }
        // ページ範囲内 clamp
        xL = Math.max(0, xL); yT = Math.max(0, yT);
        xR = Math.min(pageSize.width,  xR); yB = Math.min(pageSize.height, yB);
        st.cell.xMm = (xL + xR) / 2;
        st.cell.yMm = (yT + yB) / 2;
        st.cell.widthMm  = xR - xL;
        st.cell.heightMm = yB - yT;
        updateCustomCellDom(st.div, st.cell);
        // ガイド線描画 (リサイズ後 rect 範囲を渡す)
        renderAlignmentGuides(snap.vGuide, snap.hGuide, { xL, xR, yT, yB });
      }
    }
    function handleCustomCellEditEnd(e) {
      if (!customCellEditState) return;
      const wasMoved = customCellEditState.moved;
      const mode = customCellEditState.mode;
      customCellEditState = null;
      clearAlignmentGuides();
      if (wasMoved) {
        scheduleAutosave && scheduleAutosave();
        setStatus(mode === 'move' ? 'カスタムセル移動完了' : 'カスタムセルサイズ変更');
      }
    }
    // window レベルで補足（capture 漏れ対策）
    window.addEventListener('pointermove', handleCustomCellEditMove);
    window.addEventListener('pointerup',   handleCustomCellEditEnd);
    window.addEventListener('pointercancel', handleCustomCellEditEnd);

    // ----- Lv.2: 検出した線/矩形 → スナップ対象 (mm, 左上原点) に変換 -----
    // pdf座標 (pt, 左下原点) → 内部座標 (mm, 左上原点) 変換
    // 水平/垂直線のみ採用（斜め線は無視、0.5pt 以内の傾きは平行扱い）
    // 矩形は4辺すべてエッジを採用
    // セル検出: H/V 線の grid 候補ペアごとに4辺すべて実線で覆われてるかチェック
    // dedup: 0.3mm 以内は同一視（targets配列の爆発を防ぐ）
    function buildDetectedSnapTargets(lineData, page) {
      const baseViewport = page.getViewport({ scale: 1 });
      const pageHeightPt = baseViewport.height;
      const pageHeightMm = ptToMm(pageHeightPt);
      const PARALLEL_TOL_PT = 0.5; // 平行線判定の許容（傾き）
      const DEDUP_TOL_MM = 0.3;    // 重複除去の許容
      // typed lines (mm, 左上原点)
      const hLines = []; // { yMm, xMinMm, xMaxMm }
      const vLines = []; // { xMm, yMinMm, yMaxMm }

      for (const ln of lineData.lines) {
        const dx = Math.abs(ln.x2 - ln.x1);
        const dy = Math.abs(ln.y2 - ln.y1);
        if (dx <= PARALLEL_TOL_PT && dy > PARALLEL_TOL_PT) {
          // 縦線
          const xMm = ptToMm((ln.x1 + ln.x2) / 2);
          // y軸反転後は y1/y2 の min/max が逆転することに注意 → ptToMm + flip 後に min/max
          const yA = pageHeightMm - ptToMm(ln.y1);
          const yB = pageHeightMm - ptToMm(ln.y2);
          vLines.push({ xMm, yMinMm: Math.min(yA, yB), yMaxMm: Math.max(yA, yB) });
        } else if (dy <= PARALLEL_TOL_PT && dx > PARALLEL_TOL_PT) {
          // 横線（PDF y は下原点 → 上原点）
          const yPt = (ln.y1 + ln.y2) / 2;
          const yMm = pageHeightMm - ptToMm(yPt);
          const xA = ptToMm(ln.x1);
          const xB = ptToMm(ln.x2);
          hLines.push({ yMm, xMinMm: Math.min(xA, xB), xMaxMm: Math.max(xA, xB) });
        }
      }
      // 矩形の4辺も同様に typed line として登録
      for (const r of lineData.rects) {
        const xL = ptToMm(r.x);
        const xR = ptToMm(r.x + r.w);
        const yTop = pageHeightMm - ptToMm(r.y + r.h);
        const yBot = pageHeightMm - ptToMm(r.y);
        hLines.push({ yMm: yTop, xMinMm: xL, xMaxMm: xR });
        hLines.push({ yMm: yBot, xMinMm: xL, xMaxMm: xR });
        vLines.push({ xMm: xL, yMinMm: yTop, yMaxMm: yBot });
        vLines.push({ xMm: xR, yMinMm: yTop, yMaxMm: yBot });
      }
      // dedup（ソートして近接値を間引き）
      const dedup = (arr, tol) => {
        const sorted = arr.slice().sort((a, b) => a - b);
        const out = [];
        for (const v of sorted) {
          if (out.length === 0 || Math.abs(v - out[out.length - 1]) > tol) {
            out.push(v);
          }
        }
        return out;
      };
      const vXsMm = dedup(vLines.map(l => l.xMm), DEDUP_TOL_MM);
      const hYsMm = dedup(hLines.map(l => l.yMm), DEDUP_TOL_MM);

      // ----- セル検出 (all-pairs + 複数segment union coverage + leaf filter + min area) -----
      // 隣接 grid だけだと、grid に細かい分割線 (ラベル枠の letter/code 分割線等) があるとき
      // 大きい画像セルが「複数 grid 跨ぐ」せいで検出できない。
      // → i < i' と j < j' の全組合せをチェック (軸別バケットで高速化)
      // → JWW PDF は罫線が小刻みな segment 列で構成されるので、coverage は
      //    「複数 segment の union でカバーされていれば OK」(GAP_TOL_MM 内の隙間は許容)
      // → 内側により小さい valid セルがある「外枠的セル」は leaf filter で除外
      // → 面積最小値で文字セル (~64mm²) などのノイズを除外
      const COVERAGE_TOL_MM = 0.8;        // 線位置の許容 (やや緩め)
      const SHRINK_MM = 0.3;              // セル端から内側へ縮めて覆う必要長を判定 (緩め)
      const GAP_TOL_MM = 1.5;             // segment 間の小さい隙間を許容
      // 各辺 15mm 以上 = 「画像配置に使えるサイズの空きセル」のみ採用
      // (文字欄・ラベル欄は高さ ~8mm で除外される)
      const MIN_CELL_SIZE_MM = 15.0;
      const MIN_CELL_AREA_MM2 = 500;      // 面積 500mm² 未満は無視 (細長い帯状のノイズ対策)
      // 扁平率上限: 長辺/短辺 が これを超えるセルは「帯状」とみなして除外
      //   1.0 = 正方形、1.41 = A4、2 = よくある写真、4 = 細長すぎ
      const MAX_CELL_ASPECT_RATIO = 4.0;
      // 性能ガード: 上限の素朴な見積もり (実際は xR-xL < 5mm / 面積<500 で大半が早期スキップされるので
      // 2M でも実質コストは数十万 cover-check に収まる)
      const MAX_PAIRS = 2000000;

      // 軸別バケット: y / x を 0.5mm 単位で量子化、前後 ±1 step まで近傍検索
      const QUANT_MM = 0.5;
      const qk = (v) => Math.round(v / QUANT_MM);
      const hByY = new Map();
      for (const h of hLines) {
        const k = qk(h.yMm);
        if (!hByY.has(k)) hByY.set(k, []);
        hByY.get(k).push(h);
      }
      const vByX = new Map();
      for (const v of vLines) {
        const k = qk(v.xMm);
        if (!vByX.has(k)) vByX.set(k, []);
        vByX.get(k).push(v);
      }
      const getHAt = (y) => {
        const k = qk(y);
        const out = [];
        for (let dk = -1; dk <= 1; dk++) {
          const arr = hByY.get(k + dk);
          if (arr) for (const x of arr) out.push(x);
        }
        return out;
      };
      const getVAt = (x) => {
        const k = qk(x);
        const out = [];
        for (let dk = -1; dk <= 1; dk++) {
          const arr = vByX.get(k + dk);
          if (arr) for (const v of arr) out.push(v);
        }
        return out;
      };
      // segment 列 [{lo, hi}] が target [t0, t1] を union でカバーするか
      // GAP_TOL_MM 以内の隙間は連続扱い (JWW の小刻み segment 対策)
      const segmentsCover = (segments, t0, t1) => {
        if (segments.length === 0) return false;
        if (t1 <= t0) return true;
        const sorted = segments.slice().sort((a, b) => a.lo - b.lo);
        let pos = t0;
        for (const s of sorted) {
          if (s.hi < pos) continue;        // 既にカバー済み区間
          if (s.lo > pos + GAP_TOL_MM) return false; // 隙間でかすぎ
          if (s.hi > pos) pos = s.hi;
          if (pos >= t1) return true;
        }
        return pos >= t1;
      };
      const hasHCover = (yQuery, xL, xR) => {
        const xLN = xL + SHRINK_MM, xRN = xR - SHRINK_MM;
        const segs = [];
        for (const h of getHAt(yQuery)) {
          if (Math.abs(h.yMm - yQuery) > COVERAGE_TOL_MM) continue;
          segs.push({ lo: h.xMinMm, hi: h.xMaxMm });
        }
        return segmentsCover(segs, xLN, xRN);
      };
      const hasVCover = (xQuery, yT, yB) => {
        const yTN = yT + SHRINK_MM, yBN = yB - SHRINK_MM;
        const segs = [];
        for (const v of getVAt(xQuery)) {
          if (Math.abs(v.xMm - xQuery) > COVERAGE_TOL_MM) continue;
          segs.push({ lo: v.yMinMm, hi: v.yMaxMm });
        }
        return segmentsCover(segs, yTN, yBN);
      };

      const N = vXsMm.length, M = hYsMm.length;
      const totalPairs = (N * (N - 1) / 2) * (M * (M - 1) / 2);
      const allCells = [];
      if (N >= 2 && M >= 2 && totalPairs <= MAX_PAIRS) {
        for (let i = 0; i < N - 1; i++) {
          for (let i2 = i + 1; i2 < N; i2++) {
            const xL = vXsMm[i], xR = vXsMm[i2];
            if (xR - xL < MIN_CELL_SIZE_MM) continue;
            for (let j = 0; j < M - 1; j++) {
              for (let j2 = j + 1; j2 < M; j2++) {
                const yT = hYsMm[j], yB = hYsMm[j2];
                if (yB - yT < MIN_CELL_SIZE_MM) continue;
                const _w = xR - xL, _h = yB - yT;
                if (_w * _h < MIN_CELL_AREA_MM2) continue;
                // 扁平率チェック: 長辺/短辺 が閾値を超えるセルは「帯状」とみなして除外
                if (Math.max(_w, _h) / Math.min(_w, _h) > MAX_CELL_ASPECT_RATIO) continue;
                if (hasHCover(yT, xL, xR)
                    && hasHCover(yB, xL, xR)
                    && hasVCover(xL, yT, yB)
                    && hasVCover(xR, yT, yB)) {
                  allCells.push({
                    xL, xR, yT, yB,
                    xMm: (xL + xR) / 2,
                    yMm: (yT + yB) / 2,
                    widthMm: xR - xL,
                    heightMm: yB - yT
                  });
                }
              }
            }
          }
        }
      }

      // leaf filter: 自分の内側に他の valid セルが完全に収まっているセルは除外
      // (外枠 / 行全体 / 列全体など、もっと細かいセルに分割される「箱の箱」を弾く)
      const TOL = 0.5; // mm
      const leafCells = allCells.filter(c => {
        return !allCells.some(o => {
          if (o === c) return false;
          // o が c の内側に完全に収まる && o の方が小さい
          const inside = (o.xL >= c.xL - TOL) && (o.xR <= c.xR + TOL)
                      && (o.yT >= c.yT - TOL) && (o.yB <= c.yB + TOL);
          if (!inside) return false;
          const smaller = (o.widthMm < c.widthMm - TOL) || (o.heightMm < c.heightMm - TOL);
          return smaller;
        });
      });
      const cellCentersMm = leafCells.map(c => ({
        xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm
      }));

      // 診断ログ (0個 or デバッグ用) — window.imgPlaceDebug = true で有効
      if (cellCentersMm.length === 0 || window.imgPlaceDebug) {
        const overCap = totalPairs > MAX_PAIRS;
        console.log('[imgPlace cells] hLines=' + hLines.length + ' vLines=' + vLines.length
          + ' grid=' + N + 'x' + M
          + ' totalPairs=' + totalPairs + (overCap ? ' (over MAX_PAIRS=' + MAX_PAIRS + ' → 検出スキップ!)' : '')
          + ' allCells=' + allCells.length
          + ' leafCells=' + leafCells.length);
        // 各辺カバレッジの内訳を一部サンプル
        if (cellCentersMm.length === 0 && N >= 2 && M >= 2) {
          let sampleHpass = 0, sampleVpass = 0, samplePairs = 0;
          for (let i = 0; i < N - 1 && samplePairs < 100; i++) {
            for (let i2 = i + 1; i2 < N && samplePairs < 100; i2++) {
              for (let j = 0; j < M - 1 && samplePairs < 100; j++) {
                for (let j2 = j + 1; j2 < M && samplePairs < 100; j2++) {
                  samplePairs++;
                  if (hasHCover(hYsMm[j], vXsMm[i], vXsMm[i2])) sampleHpass++;
                  if (hasVCover(vXsMm[i], hYsMm[j], hYsMm[j2])) sampleVpass++;
                }
              }
            }
          }
          console.log('[imgPlace cells diag] (first ' + samplePairs + ' pairs) '
            + 'hCoverPass=' + sampleHpass + ' vCoverPass=' + sampleVpass
            + ' SHRINK=' + SHRINK_MM + ' COVERAGE_TOL=' + COVERAGE_TOL_MM
            + ' GAP_TOL=' + GAP_TOL_MM);
          // 線の y/x 値分布を確認
          console.log('[imgPlace cells diag] vXsMm sample:', vXsMm.slice(0, 10));
          console.log('[imgPlace cells diag] hYsMm sample:', hYsMm.slice(0, 10));
        }
      }

      return {
        vXsMm: vXsMm,
        hYsMm: hYsMm,
        cellCentersMm: cellCentersMm,
        pageHeightPt: pageHeightPt
      };
    }

    // ----- PoC: SVG オーバーレイに罫線を描画 -----
    // 入力: pdf座標 (pt, 左下原点) → SVG座標 (mm, 左上原点) に変換
    // snapTargets が渡されたら、セル中心に + マーカーも描画
    function renderLineOverlay(lineData, page, snapTargets) {
      if (!linesOverlay) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const pageWidthPt = baseViewport.width;
      const pageHeightPt = baseViewport.height;
      // viewBox を pt 単位で設定
      linesOverlay.setAttribute('viewBox', '0 0 ' + pageWidthPt + ' ' + pageHeightPt);
      // 中身クリア
      while (linesOverlay.firstChild) linesOverlay.removeChild(linesOverlay.firstChild);
      const svgNs = 'http://www.w3.org/2000/svg';
      // 線描画 (y は pdf座標→svg座標で反転)
      for (const ln of lineData.lines) {
        const el = document.createElementNS(svgNs, 'line');
        el.setAttribute('x1', ln.x1);
        el.setAttribute('y1', pageHeightPt - ln.y1);
        el.setAttribute('x2', ln.x2);
        el.setAttribute('y2', pageHeightPt - ln.y2);
        linesOverlay.appendChild(el);
      }
      // 矩形描画
      for (const r of lineData.rects) {
        const el = document.createElementNS(svgNs, 'rect');
        el.setAttribute('x', r.x);
        el.setAttribute('y', pageHeightPt - r.y - r.h); // y軸反転
        el.setAttribute('width', r.w);
        el.setAttribute('height', Math.abs(r.h));
        linesOverlay.appendChild(el);
      }
      // セル中心に + マーカー（mm → pt 変換、Y は SVG なので反転不要：snapTargets は既に上原点 mm）
      let cellCount = 0;
      if (snapTargets && Array.isArray(snapTargets.cellCentersMm)) {
        cellCount = snapTargets.cellCentersMm.length;
        const PT_PER_MM_LOCAL = 72 / 25.4;
        const MARK_PT = 6; // + マーカーの腕長 (pt)
        const g = document.createElementNS(svgNs, 'g');
        g.setAttribute('class', 'cell-marker');
        for (const c of snapTargets.cellCentersMm) {
          const cx = c.xMm * PT_PER_MM_LOCAL;
          const cy = c.yMm * PT_PER_MM_LOCAL;
          // 横棒
          const h = document.createElementNS(svgNs, 'line');
          h.setAttribute('x1', cx - MARK_PT); h.setAttribute('y1', cy);
          h.setAttribute('x2', cx + MARK_PT); h.setAttribute('y2', cy);
          g.appendChild(h);
          // 縦棒
          const v = document.createElementNS(svgNs, 'line');
          v.setAttribute('x1', cx); v.setAttribute('y1', cy - MARK_PT);
          v.setAttribute('x2', cx); v.setAttribute('y2', cy + MARK_PT);
          g.appendChild(v);
        }
        linesOverlay.appendChild(g);
      }
      const totalBefore = lineData.totalLinesBeforeFilter || lineData.lines.length;
      const filteredOut = totalBefore - lineData.lines.length;
      setStatus('罫線検出: 直線 ' + lineData.lines.length + '本 / 矩形 ' + lineData.rects.length + '個'
              + ' / セル ' + cellCount + '個'
              + (filteredOut > 0 ? '（極小線 ' + filteredOut + '本ノイズ除外）' : ''));
    }

    // ----- 現在ページのレンダリング -----
    async function renderCurrentPage() {
      if (!pdfjsDoc) return;
      // 描画中の要求は捨てずに「最後の1件」として覚える(サムネ連打で表示と配置先がズレる事故防止)。
      // renderCurrentPage は常に最新の currentPageIndex を描くため、フラグ1個で後勝ちキューになる
      if (isRendering) { renderPending = true; return; }
      isRendering = true;
      try {
        // レイアウト確定を待つ（初回 editorPanel 表示直後の clientWidth=0 対策）
        await new Promise(resolve => requestAnimationFrame(resolve));
        const page = await pdfjsDoc.getPage(currentPageIndex + 1);
        const baseViewport = page.getViewport({ scale: 1 });
        // canvas-frame の aspect-ratio を PDF サイズに合わせる
        // CSS の max-width/max-height と組み合わさって viewport にフィット
        if (canvasFrame) {
          canvasFrame.style.aspectRatio = baseViewport.width + ' / ' + baseViewport.height;
        }
        // aspect-ratio 設定後にレイアウト確定を待つ（clientWidth 取得前）
        await new Promise(resolve => requestAnimationFrame(resolve));
        // 動的スケール計算: 表示幅×DPR で必要解像度を決定。最低でも3倍密度を確保
        const containerWidth = (canvasFrame && canvasFrame.clientWidth)
          || (canvas && canvas.clientWidth)
          || baseViewport.width;
        const dpr = Math.max(window.devicePixelRatio || 1, 3); // 最低3倍密度
        const targetPx = Math.max(containerWidth, baseViewport.width) * dpr;
        let scale = targetPx / baseViewport.width;
        if (scale > MAX_RENDER_SCALE) scale = MAX_RENDER_SCALE; // メモリ上限ガード
        if (scale < 3) scale = 3; // 最低 3倍密度を強制（ベクター見た目に近づける）
        const viewport = page.getViewport({ scale: scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        // 表示サイズはCSSの "width: 100%; height: auto" に完全に任せる
        canvas.style.width = '';
        canvas.style.height = '';
        // Canvas の描画品質を最高に
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // intent: 'print' で印刷品質モード（テキスト・ベクターのアンチエイリアス改善）
        await page.render({
          canvasContext: ctx,
          viewport: viewport,
          intent: 'print'
        }).promise;
        updateMeta();
        renderPlacements();
        // Lv.2: 罫線スナップON時、現在ページから線を抽出 → 可視化 + スナップ対象に追加
        if (lineDetectionEnabled) {
          try {
            const lineData = await extractPageLines(page);
            detectedSnapTargets = buildDetectedSnapTargets(lineData, page);
            renderLineOverlay(lineData, page, detectedSnapTargets);
          } catch (err) {
            console.warn('[imgPlace] 罫線検出失敗:', err);
            detectedSnapTargets = null;
          }
        } else {
          detectedSnapTargets = null;
        }
        // カスタムセル（手動定義）の再描画
        renderCustomCells();
        // ページ切替時はハイライトもリセット
        if (activeSnapCell) {
          activeSnapCell = null;
          updateActiveSnapCellOverlay();
        }
      } catch (err) {
        console.error('[imgPlace] ページ描画失敗:', err);
        // 白紙キャンバスのまま当てずっぽうで配置されるのを防ぐため、画面にも警告を出す
        setStatus('⚠ ページの表示に失敗しました（ページが大きすぎる可能性）。このページへの配置は控えてください', 'error');
      } finally {
        isRendering = false;
        // 描画中に溜まった要求を消化(最新の currentPageIndex を描き直す)
        if (renderPending) {
          renderPending = false;
          renderCurrentPage();
        }
      }
    }

    // ----- リサイズ追従（debounced） -----
    let resizeTimer = null;
    if (typeof ResizeObserver === 'function' && canvasFrame) {
      const ro = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (pdfjsDoc) renderCurrentPage();
        }, 220);
      });
      ro.observe(canvasFrame);
    }

    // ----- 座標変換: 画面座標 → ページmm -----
    function getPagePosMm(clientX, clientY) {
      if (!canvasFrame) return null;
      const rect = canvasFrame.getBoundingClientRect();
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize || rect.width === 0 || rect.height === 0) return null;
      return {
        xMm: (clientX - rect.left) / rect.width * pageSize.width,
        yMm: (clientY - rect.top) / rect.height * pageSize.height
      };
    }

    // ----- リサイズ計算: 8ハンドル対応（四隅 + 四辺中央） -----
    // 動いているエッジだけを再計算、対辺は固定（anchor）
    function applyResize(corner, mouseXMm, mouseYMm, orig, lockAspect) {
      const MIN_MM = 5;
      let newX = orig.xMm, newY = orig.yMm;
      let newW = orig.widthMm, newH = orig.heightMm;

      const moveLeft   = corner === 'nw' || corner === 'sw' || corner === 'w';
      const moveRight  = corner === 'ne' || corner === 'se' || corner === 'e';
      const moveTop    = corner === 'nw' || corner === 'ne' || corner === 'n';
      const moveBottom = corner === 'sw' || corner === 'se' || corner === 's';

      // 水平方向の変化（左 or 右ヘリだけが動く）
      if (moveLeft) {
        const anchorRight = orig.xMm + orig.widthMm;
        newW = Math.max(MIN_MM, anchorRight - mouseXMm);
        newX = anchorRight - newW;
      } else if (moveRight) {
        newW = Math.max(MIN_MM, mouseXMm - orig.xMm);
        // newX = orig.xMm
      }
      // 垂直方向の変化（上 or 下ヘリだけが動く）
      if (moveTop) {
        const anchorBottom = orig.yMm + orig.heightMm;
        newH = Math.max(MIN_MM, anchorBottom - mouseYMm);
        newY = anchorBottom - newH;
      } else if (moveBottom) {
        newH = Math.max(MIN_MM, mouseYMm - orig.yMm);
        // newY = orig.yMm
      }

      // アスペクト比固定
      if (lockAspect && orig.widthMm > 0 && orig.heightMm > 0) {
        const aspect = orig.widthMm / orig.heightMm;
        const isCorner = (moveLeft || moveRight) && (moveTop || moveBottom);
        const isHEdge  = (moveLeft || moveRight) && !moveTop && !moveBottom; // 'w' or 'e'
        const isVEdge  = (moveTop || moveBottom) && !moveLeft && !moveRight; // 'n' or 's'

        if (isCorner) {
          // 4隅: 大きい方の縮尺に合わせて対角を anchor に伸縮
          if (newW / aspect > newH) {
            const adj = newW / aspect;
            if (moveTop) newY = (orig.yMm + orig.heightMm) - adj;
            newH = adj;
          } else {
            const adj = newH * aspect;
            if (moveLeft) newX = (orig.xMm + orig.widthMm) - adj;
            newW = adj;
          }
        } else if (isHEdge) {
          // 左右ヘリ: 幅変化に追従して高さも変える、元の縦中心線を保つ
          newH = newW / aspect;
          newY = orig.yMm + (orig.heightMm - newH) / 2;
        } else if (isVEdge) {
          // 上下ヘリ: 高さ変化に追従して幅も変える、元の横中心線を保つ
          newW = newH * aspect;
          newX = orig.xMm + (orig.widthMm - newW) / 2;
        }
      }

      return { xMm: newX, yMm: newY, widthMm: newW, heightMm: newH };
    }

    // ----- スナップ機能 -----
    // 18px相当をmmに換算（canvas表示幅 → ページ実寸）
    // 仕様§4.6は5pxだが現場感覚優先で広め（吸い付き強く）
    function getSnapThresholdMm() {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize || !canvasFrame) return 5;
      const rect = canvasFrame.getBoundingClientRect();
      if (rect.width === 0) return 5;
      return 18 / rect.width * pageSize.width;
    }
    // 現在ページの他の配置の矩形情報を取得
    // exclude: 単一ID (string) or Set<string>。指定IDは結果から除外
    function getOtherPlacementRects(exclude) {
      let excludeSet;
      if (exclude instanceof Set) excludeSet = exclude;
      else if (exclude == null) excludeSet = new Set();
      else excludeSet = new Set([exclude]);
      const result = [];
      for (const p of placements) {
        if (excludeSet.has(p.id)) continue;
        if (p.pageIndex !== currentPageIndex) continue;
        result.push({
          left: p.xMm,
          top: p.yMm,
          right: p.xMm + p.widthMm,
          bottom: p.yMm + p.heightMm,
          centerX: p.xMm + p.widthMm / 2,
          centerY: p.yMm + p.heightMm / 2
        });
      }
      return result;
    }
    // ref が targets のどれかと threshold 以内なら最も近いのを返す
    function findClosest(ref, targets, threshold) {
      let best = null;
      for (const t of targets) {
        const diff = t - ref;
        if (Math.abs(diff) < threshold && (!best || Math.abs(diff) < Math.abs(best.delta))) {
          best = { delta: diff, target: t };
        }
      }
      return best;
    }
    // 移動用スナップ計算: 左右端・中央 vs 他画像エッジ・他画像中心線・ページ中央線・検出罫線・セル中心
    function computeSnapForMove(newX, newY, w, h) {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return { dx: 0, dy: 0, guides: [] };
      const threshold = getSnapThresholdMm();
      // マルチ選択時は全ての選択中placementを除外（一緒に移動中なので互いに snap しない）
      const others = getOtherPlacementRects(selectedPlacementIds);
      const vTargets = [pageSize.width / 2];
      const hTargets = [pageSize.height / 2];
      for (const r of others) {
        vTargets.push(r.left, r.right, r.centerX);
        hTargets.push(r.top, r.bottom, r.centerY);
      }
      // Lv.2: 検出した罫線/矩形エッジもスナップ対象に
      if (detectedSnapTargets) {
        for (const x of detectedSnapTargets.vXsMm) vTargets.push(x);
        for (const y of detectedSnapTargets.hYsMm) hTargets.push(y);
      }
      // ===== セル中心スナップ（XY同時、最優先） =====
      // 画像中心が threshold 内のセル中心があれば、per-axis snap より優先して XY 同時に吸い付く
      // 「マルチ選択時はセル中心スナップを無効化」(複数枚を一点に集約してしまうため)
      // 検出セル + カスタムセル を統合した getActiveCells() を使用
      const cellsForSnap = (!selectedPlacementIds || selectedPlacementIds.size <= 1) ? getActiveCells() : [];
      if (cellsForSnap.length > 0) {
        const imgCx = newX + w / 2;
        const imgCy = newY + h / 2;
        let bestCell = null;
        let bestDist2 = Infinity;
        for (const c of cellsForSnap) {
          const ddx = Math.abs(c.xMm - imgCx);
          const ddy = Math.abs(c.yMm - imgCy);
          if (ddx > threshold || ddy > threshold) continue;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestCell = c;
          }
        }
        if (bestCell) {
          return {
            dx: bestCell.xMm - imgCx,
            dy: bestCell.yMm - imgCy,
            guides: [
              { type: 'v', mm: bestCell.xMm },
              { type: 'h', mm: bestCell.yMm }
            ],
            cell: bestCell
          };
        }
      }
      let bestX = null;
      for (const ref of [newX, newX + w, newX + w / 2]) {
        const s = findClosest(ref, vTargets, threshold);
        if (s && (!bestX || Math.abs(s.delta) < Math.abs(bestX.delta))) bestX = s;
      }
      let bestY = null;
      for (const ref of [newY, newY + h, newY + h / 2]) {
        const s = findClosest(ref, hTargets, threshold);
        if (s && (!bestY || Math.abs(s.delta) < Math.abs(bestY.delta))) bestY = s;
      }
      const guides = [];
      if (bestX) guides.push({ type: 'v', mm: bestX.target });
      if (bestY) guides.push({ type: 'h', mm: bestY.target });
      return {
        dx: bestX ? bestX.delta : 0,
        dy: bestY ? bestY.delta : 0,
        guides: guides
      };
    }
    // リサイズ用スナップ計算: 動いているエッジだけを対象に（検出罫線含む）
    function computeSnapForResize(corner, rect) {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return { snapX: null, snapY: null, guides: [] };
      const threshold = getSnapThresholdMm();
      const others = getOtherPlacementRects(selectedPlacementId);
      const vTargets = [pageSize.width / 2];
      const hTargets = [pageSize.height / 2];
      for (const r of others) {
        vTargets.push(r.left, r.right, r.centerX);
        hTargets.push(r.top, r.bottom, r.centerY);
      }
      // Lv.2: 検出した罫線/矩形エッジもスナップ対象に
      if (detectedSnapTargets) {
        for (const x of detectedSnapTargets.vXsMm) vTargets.push(x);
        for (const y of detectedSnapTargets.hYsMm) hTargets.push(y);
      }
      const isLeftMoving   = corner === 'nw' || corner === 'sw' || corner === 'w';
      const isRightMoving  = corner === 'ne' || corner === 'se' || corner === 'e';
      const isTopMoving    = corner === 'nw' || corner === 'ne' || corner === 'n';
      const isBottomMoving = corner === 'sw' || corner === 'se' || corner === 's';
      let snapX = null, snapY = null;
      // 水平方向: 動いてるエッジ + 中心線も候補に。最も近い target を採用
      if (isLeftMoving || isRightMoving) {
        const candidates = [];
        if (isLeftMoving)  candidates.push({ edge: 'left',    val: rect.left });
        if (isRightMoving) candidates.push({ edge: 'right',   val: rect.right });
        candidates.push({ edge: 'centerX', val: (rect.left + rect.right) / 2 });
        for (const c of candidates) {
          const s = findClosest(c.val, vTargets, threshold);
          if (s && (!snapX || Math.abs(s.delta) < Math.abs(snapX.delta))) {
            snapX = { edge: c.edge, delta: s.delta, target: s.target };
          }
        }
      }
      // 垂直方向: 同上
      if (isTopMoving || isBottomMoving) {
        const candidates = [];
        if (isTopMoving)    candidates.push({ edge: 'top',     val: rect.top });
        if (isBottomMoving) candidates.push({ edge: 'bottom',  val: rect.bottom });
        candidates.push({ edge: 'centerY', val: (rect.top + rect.bottom) / 2 });
        for (const c of candidates) {
          const s = findClosest(c.val, hTargets, threshold);
          if (s && (!snapY || Math.abs(s.delta) < Math.abs(snapY.delta))) {
            snapY = { edge: c.edge, delta: s.delta, target: s.target };
          }
        }
      }
      const guides = [];
      if (snapX) guides.push({ type: 'v', mm: snapX.target });
      if (snapY) guides.push({ type: 'h', mm: snapY.target });
      return { snapX: snapX, snapY: snapY, guides: guides };
    }
    // スナップトグルボタン表示更新
    function updateSnapBtn() {
      if (!snapBtn) return;
      snapBtn.dataset.snap = snapEnabled ? 'on' : 'off';
      if (snapLabel) snapLabel.textContent = snapEnabled ? 'スナップ ON' : 'スナップ OFF';
    }

    // ----- 選択ヘルパー -----
    function selectSingle(id) {
      selectedPlacementIds = new Set([id]);
      selectedPlacementId = id;
    }
    function clearSelection() {
      selectedPlacementIds = new Set();
      selectedPlacementId = null;
    }
    function toggleSelected(id) {
      if (selectedPlacementIds.has(id)) {
        selectedPlacementIds.delete(id);
        if (selectedPlacementId === id) {
          // primary を選択中の他のものに更新（最後に追加されたもの優先）
          const remain = [...selectedPlacementIds];
          selectedPlacementId = remain.length > 0 ? remain[remain.length - 1] : null;
        }
      } else {
        selectedPlacementIds.add(id);
        selectedPlacementId = id;
      }
    }
    function removeFromSelection(id) {
      selectedPlacementIds.delete(id);
      if (selectedPlacementId === id) {
        const remain = [...selectedPlacementIds];
        selectedPlacementId = remain.length > 0 ? remain[remain.length - 1] : null;
      }
    }

    // ----- 配置削除（複数選択対応） -----
    function deletePlacement(id) {
      const target = placements.find(p => p.id === id);
      const affectedPage = target ? target.pageIndex : currentPageIndex;
      placements = placements.filter(p => p.id !== id);
      removeFromSelection(id);
      renderPlacements();
      renderLibrary(); // バッジ数更新
      queueThumbUpdate(affectedPage);
    }
    function deleteSelected() {
      if (selectedPlacementIds.size === 0) return;
      const idsToDelete = [...selectedPlacementIds];
      placements = placements.filter(p => !selectedPlacementIds.has(p.id));
      clearSelection();
      renderPlacements();
      renderLibrary();
    }

    // ----- ゴミ箱の表示制御 -----
    function isOverTrash(clientX, clientY) {
      if (!trashEl) return false;
      const rect = trashEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return clientX >= rect.left && clientX <= rect.right
          && clientY >= rect.top && clientY <= rect.bottom;
    }
    function showTrash() {
      if (trashEl) trashEl.classList.add('visible');
    }
    function hideTrash() {
      if (trashEl) trashEl.classList.remove('visible', 'hover');
    }

    // ----- ドラッグゴースト（カーソル追従の半透明コピー） -----
    function createDragGhost(placement, imgMeta, clientX, clientY) {
      if (!canvasFrame) return null;
      const frameRect = canvasFrame.getBoundingClientRect();
      const pageSize = pageSizesMm[placement.pageIndex];
      if (!pageSize || frameRect.width === 0) return null;
      // 元配置の画面座標
      const plLeftPx = frameRect.left + (placement.xMm / pageSize.width) * frameRect.width;
      const plTopPx = frameRect.top + (placement.yMm / pageSize.height) * frameRect.height;
      const plWidthPx = (placement.widthMm / pageSize.width) * frameRect.width;
      const plHeightPx = (placement.heightMm / pageSize.height) * frameRect.height;
      // カーソルの「画像内オフセット」を保持（自然なドラッグ感のため）
      const offsetX = clientX - plLeftPx;
      const offsetY = clientY - plTopPx;
      const ghost = document.createElement('div');
      ghost.className = 'imgplace-drag-ghost';
      ghost.style.width = plWidthPx + 'px';
      ghost.style.height = plHeightPx + 'px';
      ghost.style.left = (clientX - offsetX) + 'px';
      ghost.style.top = (clientY - offsetY) + 'px';
      const g = document.createElement('img');
      g.src = imgMeta.dataUrl;
      g.alt = imgMeta.filename || '';
      ghost.appendChild(g);
      document.body.appendChild(ghost);
      return { ghost: ghost, offsetX: offsetX, offsetY: offsetY };
    }
    function updateDragGhostPos(ghostInfo, clientX, clientY) {
      if (!ghostInfo || !ghostInfo.ghost) return;
      ghostInfo.ghost.style.left = (clientX - ghostInfo.offsetX) + 'px';
      ghostInfo.ghost.style.top = (clientY - ghostInfo.offsetY) + 'px';
    }
    function destroyDragGhost(ghostInfo) {
      if (ghostInfo && ghostInfo.ghost && ghostInfo.ghost.parentNode) {
        ghostInfo.ghost.parentNode.removeChild(ghostInfo.ghost);
      }
    }

    // ----- 整列関数（複数選択時のみ機能） -----
    function getSelectedPlacements() {
      const ids = [...selectedPlacementIds];
      return ids
        .map(id => placements.find(p => p.id === id))
        .filter(p => p && p.pageIndex === currentPageIndex);
    }
    // 横並び等間隔: 左端から右端の範囲を等間隔配置、Yは最初の選択画像に揃える
    function alignHEqualSpacing() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const firstY = pls[0].yMm; // selectedPlacementIds の最初に追加された画像
      const sortedByX = pls.slice().sort((a, b) => a.xMm - b.xMm);
      const leftmost = sortedByX[0];
      const rightmost = sortedByX[sortedByX.length - 1];
      const totalSpan = (rightmost.xMm + rightmost.widthMm) - leftmost.xMm;
      const sumWidths = sortedByX.reduce((s, p) => s + p.widthMm, 0);
      const gap = (totalSpan - sumWidths) / (sortedByX.length - 1);
      let cursor = leftmost.xMm;
      for (const p of sortedByX) {
        p.xMm = cursor;
        p.yMm = firstY;
        cursor += p.widthMm + gap;
      }
      renderPlacements();
    }
    // 上端揃え: Y座標を最小値に
    function alignTop() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const minY = Math.min(...pls.map(p => p.yMm));
      pls.forEach(p => { p.yMm = minY; });
      renderPlacements();
    }
    // 下端揃え: Y+H を最大値に
    function alignBottom() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const maxBottom = Math.max(...pls.map(p => p.yMm + p.heightMm));
      pls.forEach(p => { p.yMm = maxBottom - p.heightMm; });
      renderPlacements();
    }
    // 縦中央揃え: Y中心を平均値に
    function alignCenterVertical() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const avgCenterY = pls.reduce((s, p) => s + p.yMm + p.heightMm / 2, 0) / pls.length;
      pls.forEach(p => { p.yMm = avgCenterY - p.heightMm / 2; });
      renderPlacements();
    }
    // 幅統一: Primary（最後クリック）の幅に全選択を揃える。各画像のAR Lockが ON なら高さも比率連動
    function unifyWidth() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const primary = placements.find(p => p.id === selectedPlacementId);
      if (!primary) return;
      const targetW = primary.widthMm;
      for (const p of pls) {
        if (p.id === primary.id) continue;
        if (p.aspectLocked !== false && p.widthMm > 0 && p.heightMm > 0) {
          const aspect = p.widthMm / p.heightMm;
          p.heightMm = targetW / aspect;
        }
        p.widthMm = targetW;
      }
      renderPlacements();
    }
    // キャプション一括プロパティ設定（マルチ選択の全画像の全キャプションに適用）
    function bulkSetCaptionProperty(prop, value) {
      const pls = getSelectedPlacements();
      if (pls.length < 1) return;
      for (const pl of pls) {
        normalizeCaptions(pl);
        for (const cap of pl.captions) {
          cap[prop] = value;
        }
      }
      renderPlacements();
    }

    // 高さ統一: 同上の高さ版
    function unifyHeight() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const primary = placements.find(p => p.id === selectedPlacementId);
      if (!primary) return;
      const targetH = primary.heightMm;
      for (const p of pls) {
        if (p.id === primary.id) continue;
        if (p.aspectLocked !== false && p.widthMm > 0 && p.heightMm > 0) {
          const aspect = p.widthMm / p.heightMm;
          p.widthMm = targetH * aspect;
        }
        p.heightMm = targetH;
      }
      renderPlacements();
    }

    // ----- プロパティパネル: 値だけ同期（DOM再構築せず、入力中のフィールドは触らない） -----
    function syncPropsInputValues(pl) {
      const active = document.activeElement;
      if (propsInputs.x && active !== propsInputs.x) propsInputs.x.value = pl.xMm.toFixed(1);
      if (propsInputs.y && active !== propsInputs.y) propsInputs.y.value = pl.yMm.toFixed(1);
      if (propsInputs.w && active !== propsInputs.w) propsInputs.w.value = pl.widthMm.toFixed(1);
      if (propsInputs.h && active !== propsInputs.h) propsInputs.h.value = pl.heightMm.toFixed(1);
    }

    // ----- プロパティパネル: 入力変更を反映 -----
    function handlePropsInputChange(propKey, value) {
      const pl = placements.find(p => p.id === selectedPlacementId);
      if (!pl) return;
      if (propKey === 'widthMm') {
        if (value <= 0) return;
        // アスペクト比固定なら H 連動
        if (pl.aspectLocked !== false && pl.widthMm > 0 && pl.heightMm > 0) {
          const aspect = pl.widthMm / pl.heightMm;
          pl.heightMm = value / aspect;
        }
        pl.widthMm = value;
      } else if (propKey === 'heightMm') {
        if (value <= 0) return;
        // アスペクト比固定なら W 連動
        if (pl.aspectLocked !== false && pl.widthMm > 0 && pl.heightMm > 0) {
          const aspect = pl.widthMm / pl.heightMm;
          pl.widthMm = value * aspect;
        }
        pl.heightMm = value;
      } else {
        // X/Y はクランプなし（直接入力でページ外配置も許容）
        pl[propKey] = value;
      }
      renderPlacements();
    }

    // ----- プロパティパネル描画 -----
    function renderProps() {
      const propsEl = document.getElementById('imgPlaceProps');
      if (!propsEl) return;
      const count = selectedPlacementIds.size;
      const selected = (count === 1 && selectedPlacementId)
        ? placements.find(p => p.id === selectedPlacementId)
        : null;
      // smart-sync 用キー: 単一選択なら ID + キャプション数、マルチ選択は "multi:N"
      // キャプション数を含むことで add/remove 時に確実にDOM再構築させる
      if (selected) normalizeCaptions(selected);
      const newKey = count > 1
        ? ('multi:' + count)
        : (selected ? (selected.id + ':cap' + selected.captions.length) : '');
      const currentKey = propsEl.dataset.propsKey || '';

      // 同じ単一placementの継続表示なら値同期だけで終了（フォーカス保持）
      if (currentKey === newKey && count === 1 && selected && propsInputs.x) {
        syncPropsInputValues(selected);
        return;
      }

      // 構造変更 → 完全再構築
      propsEl.innerHTML = '';
      propsEl.dataset.propsKey = newKey;
      propsInputs = { x: null, y: null, w: null, h: null };

      const title = document.createElement('div');
      title.className = 'imgplace-props-title';
      title.textContent = 'プロパティ';
      propsEl.appendChild(title);

      // 0個選択: 空メッセージ
      if (count === 0) {
        const empty = document.createElement('div');
        empty.className = 'imgplace-props-empty';
        empty.textContent = '画像を選択してください';
        propsEl.appendChild(empty);
        return;
      }

      // 2個以上選択: マルチ選択UI（カウント + 整列ボタン）
      if (count > 1) {
        const countDiv = document.createElement('div');
        countDiv.className = 'imgplace-props-count';
        countDiv.textContent = count + ' 個の画像を選択中';
        propsEl.appendChild(countDiv);

        const alignTitle = document.createElement('div');
        alignTitle.className = 'imgplace-align-title';
        alignTitle.textContent = '整列（Y軸）';
        propsEl.appendChild(alignTitle);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'imgplace-align-buttons';
        const buttons = [
          ['横並び等間隔', alignHEqualSpacing],
          ['上端揃え',     alignTop],
          ['下端揃え',     alignBottom],
          ['縦中央揃え',   alignCenterVertical]
        ];
        for (const [label, fn] of buttons) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-align-btn';
          btn.textContent = label;
          btn.addEventListener('click', fn);
          btnGroup.appendChild(btn);
        }
        propsEl.appendChild(btnGroup);

        // サイズ統一セクション
        const sizeTitle = document.createElement('div');
        sizeTitle.className = 'imgplace-align-title';
        sizeTitle.textContent = 'サイズ統一';
        propsEl.appendChild(sizeTitle);
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'imgplace-align-buttons';
        const sizeButtons = [
          ['幅を統一',   unifyWidth],
          ['高さを統一', unifyHeight]
        ];
        for (const [label, fn] of sizeButtons) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-align-btn';
          btn.textContent = label;
          btn.addEventListener('click', fn);
          sizeGroup.appendChild(btn);
        }
        propsEl.appendChild(sizeGroup);

        const hint = document.createElement('div');
        hint.className = 'imgplace-props-hint';
        hint.style.paddingLeft = '0';
        hint.style.marginTop = '8px';
        hint.textContent = '基準は最後にクリックした画像。AR固定 ON の画像は比率を維持して連動。';
        propsEl.appendChild(hint);

        // ===== キャプション一括設定 =====
        const capBulkTitle = document.createElement('div');
        capBulkTitle.className = 'imgplace-align-title';
        capBulkTitle.textContent = 'キャプション一括';
        propsEl.appendChild(capBulkTitle);
        // ボタングループ生成ヘルパー
        function makeBulkRow(labelText, options, propKey) {
          const row = document.createElement('div');
          row.className = 'imgplace-caption-toggle';
          const lbl = document.createElement('span');
          lbl.className = 'imgplace-caption-toggle-label';
          lbl.textContent = labelText;
          row.appendChild(lbl);
          for (const [val, label] of options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'imgplace-caption-toggle-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => bulkSetCaptionProperty(propKey, val));
            row.appendChild(btn);
          }
          propsEl.appendChild(row);
        }
        makeBulkRow('揃え',   [['left','左'], ['center','中'], ['right','右']],            'align');
        makeBulkRow('サイズ', [['small','小'], ['medium','中'], ['large','大']],          'size');
        makeBulkRow('位置',   [['above','上'], ['below','下']],                            'position');
        makeBulkRow('太字',   [[false,'標準'], [true,'太字']],                              'bold');

        const capBulkHint = document.createElement('div');
        capBulkHint.className = 'imgplace-props-hint';
        capBulkHint.style.paddingLeft = '0';
        capBulkHint.style.marginTop = '6px';
        capBulkHint.textContent = '選択中の全画像の全キャプションに即時適用。フォントは下部の一括フォントで変更。';
        propsEl.appendChild(capBulkHint);
        return;
      }

      // X/Y/W/H 数値入力行
      function makeInputRow(labelText, propKey) {
        const row = document.createElement('div');
        row.className = 'imgplace-input-row';
        const lbl = document.createElement('label');
        lbl.textContent = labelText;
        row.appendChild(lbl);
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.value = selected[propKey].toFixed(1);
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          if (isNaN(v)) return;
          handlePropsInputChange(propKey, v);
        });
        row.appendChild(input);
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = 'mm';
        row.appendChild(unit);
        propsEl.appendChild(row);
        return input;
      }
      propsInputs.x = makeInputRow('X', 'xMm');
      propsInputs.y = makeInputRow('Y', 'yMm');
      propsInputs.w = makeInputRow('W', 'widthMm');
      propsInputs.h = makeInputRow('H', 'heightMm');

      // 区切り
      const hr = document.createElement('hr');
      propsEl.appendChild(hr);

      // アスペクト比固定チェックボックス
      const row = document.createElement('label');
      row.className = 'imgplace-props-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.aspectLocked !== false;
      cb.addEventListener('change', () => {
        selected.aspectLocked = cb.checked;
      });
      const txt = document.createElement('span');
      txt.textContent = 'アスペクト比を固定';
      row.appendChild(cb);
      row.appendChild(txt);
      propsEl.appendChild(row);
      const hint = document.createElement('div');
      hint.className = 'imgplace-props-hint';
      hint.textContent = 'リサイズ中に Shift で一時反転';
      propsEl.appendChild(hint);

      // ===== キャプション編集セクション（複数キャプション対応） =====
      const capSection = document.createElement('div');
      capSection.className = 'imgplace-caption-section';
      const capTitle = document.createElement('div');
      capTitle.className = 'imgplace-align-title';
      capTitle.textContent = 'キャプション';
      capSection.appendChild(capTitle);

      // selected.captions を確実に配列に
      normalizeCaptions(selected);

      // 複数キャプションある時のみ「全キャプション一括」セクション
      if (selected.captions.length >= 2) {
        const bulkBox = document.createElement('div');
        bulkBox.className = 'imgplace-caption-bulk-single';
        const bulkTitle = document.createElement('div');
        bulkTitle.className = 'imgplace-caption-bulk-title';
        bulkTitle.textContent = '全キャプション一括';
        bulkBox.appendChild(bulkTitle);

        function applyBulkSingle(prop, value) {
          for (const cap of selected.captions) {
            cap[prop] = value;
          }
          // 個別カードの active クラスも更新するため、propsKey を無効化して完全再構築
          propsEl.dataset.propsKey = '';
          renderPlacements();
        }
        function makeBulkRow(labelText, options, prop) {
          const row = document.createElement('div');
          row.className = 'imgplace-caption-toggle';
          const lbl = document.createElement('span');
          lbl.className = 'imgplace-caption-toggle-label';
          lbl.textContent = labelText;
          row.appendChild(lbl);
          for (const [val, label] of options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'imgplace-caption-toggle-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => applyBulkSingle(prop, val));
            row.appendChild(btn);
          }
          bulkBox.appendChild(row);
        }
        makeBulkRow('揃え',   [['left','左'], ['center','中'], ['right','右']],   'align');
        makeBulkRow('サイズ', [['small','小'], ['medium','中'], ['large','大']], 'size');
        makeBulkRow('位置',   [['above','上'], ['below','下']],                  'position');
        makeBulkRow('太字',   [[false,'標準'], [true,'太字']],                    'bold');

        capSection.appendChild(bulkBox);
      }

      // 各キャプションをカードとして描画
      function renderCaptionCard(cap, index) {
        const card = document.createElement('div');
        card.className = 'imgplace-caption-card';

        // テキスト入力
        const capInput = document.createElement('input');
        capInput.type = 'text';
        capInput.className = 'imgplace-caption-input';
        capInput.placeholder = '例: 3 台';
        capInput.value = cap.text || '';
        capInput.addEventListener('input', () => {
          cap.text = capInput.value;
          renderPlacements(); // smart-sync で props は再構築されない → 入力フォーカス保持
        });
        card.appendChild(capInput);

        // 削除ボタン (×)
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'imgplace-caption-remove';
        removeBtn.textContent = '×';
        removeBtn.title = 'このキャプションを削除';
        removeBtn.addEventListener('click', () => {
          selected.captions.splice(index, 1);
          // propsKey が変わるので renderProps は自動で完全再構築
          renderPlacements();
        });
        card.appendChild(removeBtn);

        // 揃え（左/中/右）
        const alignToggle = document.createElement('div');
        alignToggle.className = 'imgplace-caption-toggle';
        const alignLbl = document.createElement('span');
        alignLbl.className = 'imgplace-caption-toggle-label';
        alignLbl.textContent = '揃え';
        alignToggle.appendChild(alignLbl);
        const alignOptions = [['left', '左'], ['center', '中'], ['right', '右']];
        const alignBtns = [];
        for (const [val, label] of alignOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((cap.align || 'center') === val ? ' active' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            cap.align = val;
            for (const b of alignBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          alignBtns.push(btn);
          alignToggle.appendChild(btn);
        }
        card.appendChild(alignToggle);

        // サイズ（小/中/大）
        const sizeToggle = document.createElement('div');
        sizeToggle.className = 'imgplace-caption-toggle';
        const sizeLbl = document.createElement('span');
        sizeLbl.className = 'imgplace-caption-toggle-label';
        sizeLbl.textContent = 'サイズ';
        sizeToggle.appendChild(sizeLbl);
        const sizeOptions = [['small', '小'], ['medium', '中'], ['large', '大']];
        const sizeBtns = [];
        for (const [val, label] of sizeOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((cap.size || 'medium') === val ? ' active' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            cap.size = val;
            for (const b of sizeBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          sizeBtns.push(btn);
          sizeToggle.appendChild(btn);
        }
        card.appendChild(sizeToggle);

        // 位置（上/下）
        const posToggle = document.createElement('div');
        posToggle.className = 'imgplace-caption-toggle';
        const posLbl = document.createElement('span');
        posLbl.className = 'imgplace-caption-toggle-label';
        posLbl.textContent = '位置';
        posToggle.appendChild(posLbl);
        const posOptions = [['above', '上'], ['below', '下']];
        const posBtns = [];
        for (const [val, label] of posOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((cap.position || 'below') === val ? ' active' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            cap.position = val;
            for (const b of posBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          posBtns.push(btn);
          posToggle.appendChild(btn);
        }
        card.appendChild(posToggle);

        // 太字（標準/太字）
        const boldToggle = document.createElement('div');
        boldToggle.className = 'imgplace-caption-toggle';
        const boldLbl = document.createElement('span');
        boldLbl.className = 'imgplace-caption-toggle-label';
        boldLbl.textContent = '太字';
        boldToggle.appendChild(boldLbl);
        const boldOptions = [[false, '標準'], [true, '太字']];
        const boldBtns = [];
        for (const [val, label] of boldOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((!!cap.bold) === val ? ' active' : '');
          btn.textContent = label;
          if (val === true) btn.style.fontWeight = '700'; // "太字" ボタンは太字表示
          btn.addEventListener('click', () => {
            cap.bold = val;
            for (const b of boldBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          boldBtns.push(btn);
          boldToggle.appendChild(btn);
        }
        card.appendChild(boldToggle);

        return card;
      }

      for (let i = 0; i < selected.captions.length; i++) {
        capSection.appendChild(renderCaptionCard(selected.captions[i], i));
      }

      // + キャプション追加ボタン
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'imgplace-caption-add';
      addBtn.textContent = '+ キャプション追加';
      addBtn.addEventListener('click', () => {
        selected.captions.push({ text: '', align: 'center', size: 'medium' });
        renderPlacements(); // propsKey 変化で完全再構築
      });
      capSection.appendChild(addBtn);

      propsEl.appendChild(capSection);
    }

    // キャプションのサイズマップ（mm単位）
    const CAPTION_SIZE_MM = { small: 3, medium: 4, large: 5 };
    // 旧 pl.caption (単一) → pl.captions (配列) に正規化
    function normalizeCaptions(pl) {
      if (!pl.captions) {
        if (pl.caption && pl.caption.text) {
          pl.captions = [pl.caption];
        } else {
          pl.captions = [];
        }
        delete pl.caption;
      }
    }

    // ----- 配置オーバーレイ描画 -----
    function renderPlacements() {
      if (!overlay) return;
      overlay.innerHTML = '';
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) { renderProps(); return; }
      const frameRect = canvasFrame ? canvasFrame.getBoundingClientRect() : null;
      const pxPerMm = (frameRect && frameRect.width > 0)
        ? frameRect.width / pageSize.width
        : 4; // フォールバック
      for (const pl of placements) {
        if (pl.pageIndex !== currentPageIndex) continue;
        const img = imageLibrary.find(im => im.id === pl.imageId);
        if (!img) continue;
        const isSelected = selectedPlacementIds.has(pl.id);
        const isPrimary = pl.id === selectedPlacementId;
        // ゴースト透明化は Primary のみ。マルチドラッグ時の他選択は普通に動いて見える
        const isDraggingSource = dragState && dragState.mode === 'move' && dragState.placementId === pl.id;
        const el = document.createElement('div');
        el.className = 'imgplace-placement'
          + (isSelected ? ' selected' : '')
          + (isPrimary ? ' primary' : '')
          + (isDraggingSource ? ' dragging-source' : '');
        el.dataset.placementId = pl.id;
        el.style.left = (pl.xMm / pageSize.width * 100) + '%';
        el.style.top = (pl.yMm / pageSize.height * 100) + '%';
        el.style.width = (pl.widthMm / pageSize.width * 100) + '%';
        el.style.height = (pl.heightMm / pageSize.height * 100) + '%';
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.alt = img.filename;
        el.appendChild(imgEl);

        // 配置クリック: 選択 + 移動ドラッグ開始
        el.addEventListener('pointerdown', (e) => {
          // ハンドルクリック時はハンドル側で stopPropagation するのでここに来ない
          e.preventDefault();
          e.stopPropagation();

          // タッチイベント時は activeTouches に追加して、2 指目ならピンチ開始
          if (e.pointerType === 'touch') {
            // 3本目以降のタッチは無視 (activeTouches leak で pinchState 残留を防ぐ)
            if (activeTouches.size >= 2) return;
            activeTouches.set(e.pointerId, {
              clientX: e.clientX, clientY: e.clientY,
              placementId: pl.id
            });
            if (activeTouches.size === 2) {
              // 2 指目: 1 指目で触ってた配置を対象にピンチ開始
              const pts = [...activeTouches.values()];
              const firstPid = pts[0].placementId;
              const targetPl = placements.find(p => p.id === firstPid);
              if (targetPl) {
                const dx = pts[1].clientX - pts[0].clientX;
                const dy = pts[1].clientY - pts[0].clientY;
                const startDist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                // 既存のドラッグを中止（ゴーストとゴミ箱を破棄）
                if (dragState) {
                  if (dragState.ghost) destroyDragGhost(dragState.ghost);
                  dragState = null;
                  const mp = document.getElementById('modeImgPlace');
                  if (mp) mp.classList.remove('imgplace-dragging');
                  hideTrash();
                }
                pinchState = {
                  placementId: targetPl.id,
                  startDistance: startDist,
                  original: {
                    xMm: targetPl.xMm, yMm: targetPl.yMm,
                    widthMm: targetPl.widthMm, heightMm: targetPl.heightMm
                  }
                };
                selectSingle(targetPl.id);
                renderPlacements();
                return; // ピンチ開始したので通常のドラッグ設定はスキップ
              }
            }
          }

          // Ctrl/Cmd+クリック: 選択トグルのみ（ドラッグ開始しない）
          if (e.ctrlKey || e.metaKey) {
            toggleSelected(pl.id);
            renderPlacements();
            return;
          }

          // 通常クリック: 選択外なら単独選択に置き換え、選択中ならそのまま Primary 更新
          if (!selectedPlacementIds.has(pl.id)) {
            selectSingle(pl.id);
          } else {
            selectedPlacementId = pl.id; // Primary を最新クリックに
          }

          const start = getPagePosMm(e.clientX, e.clientY);
          if (start) {
            const ghostInfo = createDragGhost(pl, img, e.clientX, e.clientY);
            // マルチ選択の場合、Primary 以外の他選択の元位置も記録（一緒に動かすため）
            const multiOriginals = [];
            for (const id of selectedPlacementIds) {
              if (id === pl.id) continue;
              const otherPl = placements.find(p => p.id === id);
              if (otherPl) {
                multiOriginals.push({
                  id: id,
                  xMm: otherPl.xMm,
                  yMm: otherPl.yMm,
                  widthMm: otherPl.widthMm,
                  heightMm: otherPl.heightMm
                });
              }
            }
            dragState = {
              mode: 'move',
              placementId: pl.id,
              startMouseXMm: start.xMm,
              startMouseYMm: start.yMm,
              original: { xMm: pl.xMm, yMm: pl.yMm, widthMm: pl.widthMm, heightMm: pl.heightMm },
              overTrash: false,
              ghost: ghostInfo,
              multiOriginals: multiOriginals
            };
            const modePanel = document.getElementById('modeImgPlace');
            if (modePanel) modePanel.classList.add('imgplace-dragging');
            showTrash();
          }
          renderPlacements();
        });

        // リサイズハンドル（Primary 選択のみ表示）: 四隅 + 四辺中央の計8個
        if (isPrimary && selectedPlacementIds.size === 1) {
          const corners = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
          for (const corner of corners) {
            const h = document.createElement('div');
            h.className = 'imgplace-resize-handle imgplace-resize-' + corner;
            h.dataset.corner = corner;
            h.addEventListener('pointerdown', (e) => {
              e.preventDefault();
              e.stopPropagation();
              const start = getPagePosMm(e.clientX, e.clientY);
              if (!start) return;
              dragState = {
                mode: 'resize',
                corner: corner,
                placementId: pl.id,
                startMouseXMm: start.xMm,
                startMouseYMm: start.yMm,
                original: { xMm: pl.xMm, yMm: pl.yMm, widthMm: pl.widthMm, heightMm: pl.heightMm }
              };
              const modePanel = document.getElementById('modeImgPlace');
              if (modePanel) modePanel.classList.add('imgplace-dragging');
            });
            el.appendChild(h);
          }
        }

        overlay.appendChild(el);

        // キャプション描画（複数対応・上下スタック、空文字列はスキップ）
        normalizeCaptions(pl);
        if (pl.captions.length > 0) {
          const drawCaption = (cap, yMm) => {
            const sizeMm = CAPTION_SIZE_MM[cap.size || 'medium'] || 4;
            const fontSizePx = Math.max(8, sizeMm * pxPerMm);
            const capEl = document.createElement('div');
            capEl.className = 'imgplace-caption';
            capEl.style.left = (pl.xMm / pageSize.width * 100) + '%';
            capEl.style.top = (yMm / pageSize.height * 100) + '%';
            capEl.style.width = (pl.widthMm / pageSize.width * 100) + '%';
            capEl.style.textAlign = cap.align || 'center';
            capEl.style.fontSize = fontSizePx + 'px';
            capEl.style.fontFamily = captionFont;
            capEl.style.fontWeight = cap.bold ? '700' : '400';
            capEl.textContent = cap.text;
            overlay.appendChild(capEl);
          };
          // 下スタック: 画像下端 + 3mm から下方向へ
          let cursorBelow = pl.yMm + pl.heightMm + 3;
          // 上スタック: 画像上端 - 3mm から上方向へ（先頭が画像に最も近い）
          let cursorAbove = pl.yMm - 3;
          for (const cap of pl.captions) {
            if (!cap.text || !cap.text.trim()) continue;
            const sizeMm = CAPTION_SIZE_MM[cap.size || 'medium'] || 4;
            const heightMm = sizeMm * 1.15;
            const pos = cap.position || 'below';
            if (pos === 'above') {
              // 上配置: heightMm 分を引いた位置に描画
              const yMm = cursorAbove - heightMm;
              drawCaption(cap, yMm);
              cursorAbove = yMm - 1; // 次の上キャプション位置（1mm gap）
            } else {
              drawCaption(cap, cursorBelow);
              cursorBelow += heightMm + 1;
            }
          }
        }
      }
      // スナップガイド線を描画（配置の上に重ねる）
      if (pageSize && activeGuides.length > 0) {
        for (const g of activeGuides) {
          const guideEl = document.createElement('div');
          guideEl.className = 'imgplace-guide imgplace-guide-' + g.type;
          if (g.type === 'v') {
            guideEl.style.left = (g.mm / pageSize.width * 100) + '%';
          } else {
            guideEl.style.top = (g.mm / pageSize.height * 100) + '%';
          }
          overlay.appendChild(guideEl);
        }
      }
      // 選択状態に応じてプロパティパネルも更新
      renderProps();
      // 状態変化を autosave 対象として debounce 登録
      scheduleAutosave();
    }

    // ----- サムネイル一覧 -----
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
    function calcInitialSizeMm(imageMeta) {
      // 72dpi換算: px / 72 * 25.4 = mm (1pt = 1/72 inch, 1mm = 1/25.4 inch)
      let widthMm = imageMeta.originalWidthPx / 72 * 25.4;
      let heightMm = imageMeta.originalHeightPx / 72 * 25.4;
      const pageSize = pageSizesMm[currentPageIndex];
      if (pageSize) {
        if (sizeCapEnabled) {
          // ページの 1/3 を上限に、幅/高さ両軸で厳しい方の比率を採用
          const maxW = pageSize.width / 3;
          const maxH = pageSize.height / 3;
          const ratio = Math.min(1, maxW / widthMm, maxH / heightMm);
          if (ratio < 1) { widthMm *= ratio; heightMm *= ratio; }
        } else {
          // 上限解除時もページ範囲を超えないよう保険 (はみ出し配置防止)
          const ratio = Math.min(1, pageSize.width / widthMm, pageSize.height / heightMm);
          if (ratio < 1) { widthMm *= ratio; heightMm *= ratio; }
        }
      }
      return { widthMm, heightMm };
    }

    // ----- 配置: 現在ページの中央 -----
    function placeAtCenter(imageId) {
      const img = imageLibrary.find(im => im.id === imageId);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!img || !pageSize) return;
      const { widthMm, heightMm } = calcInitialSizeMm(img);
      const xMm = (pageSize.width - widthMm) / 2;
      const yMm = (pageSize.height - heightMm) / 2;
      pushPlacement(img.id, xMm, yMm, widthMm, heightMm);
    }

    // ----- 配置: ドロップ位置を中心に -----
    function placeAtPoint(imageId, dropCenterXMm, dropCenterYMm) {
      const img = imageLibrary.find(im => im.id === imageId);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!img || !pageSize) return;
      const { widthMm, heightMm } = calcInitialSizeMm(img);
      let xMm = dropCenterXMm - widthMm / 2;
      let yMm = dropCenterYMm - heightMm / 2;
      // ページ範囲内にクランプ
      xMm = Math.max(0, Math.min(xMm, pageSize.width - widthMm));
      yMm = Math.max(0, Math.min(yMm, pageSize.height - heightMm));
      pushPlacement(img.id, xMm, yMm, widthMm, heightMm);
    }

    function pushPlacement(imageId, xMm, yMm, widthMm, heightMm) {
      const id = 'pl_' + (++plSeq);
      placements.push({
        id: id,
        pageIndex: currentPageIndex,
        imageId: imageId,
        xMm: xMm,
        yMm: yMm,
        widthMm: widthMm,
        heightMm: heightMm,
        aspectLocked: true,
        captions: [] // 複数キャプション対応（旧 caption: 単一 を置き換え）
      });
      selectSingle(id); // 配置直後は単独選択（既存マルチ選択はリセット）
      renderPlacements();
      renderLibrary();  // バッジ更新
      queueThumbUpdate(currentPageIndex);
    }

    // ----- 画像ライブラリのドロップゾーン配線 -----
    if (libDropzone && libInput) {
      libDropzone.addEventListener('click', () => libInput.click());
      // ドロップゾーン上でホイール → libList にスクロール転送 (画像沢山ある時操作性UP)
      libDropzone.addEventListener('wheel', (e) => {
        if (!libList) return;
        // libList が実際にスクロール可能な時のみ転送 + ページスクロール抑止
        if (libList.scrollHeight > libList.clientHeight) {
          e.preventDefault();
          libList.scrollTop += e.deltaY;
        }
      }, { passive: false });
      libDropzone.addEventListener('dragover', (e) => {
        // ライブラリ自身からのドラッグ（draggingLibImageId）はライブラリへの再ドロップを許可しない
        if (draggingLibImageId) return;
        e.preventDefault();
        libDropzone.classList.add('dragover');
      });
      libDropzone.addEventListener('dragleave', () => libDropzone.classList.remove('dragover'));
      libDropzone.addEventListener('drop', (e) => {
        if (draggingLibImageId) return;
        e.preventDefault();
        libDropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          addImagesFromFiles(e.dataTransfer.files);
        }
      });
      libInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
          addImagesFromFiles(e.target.files);
          e.target.value = '';
        }
      });
    }

    // ----- キャンバスへの画像ドロップ（ライブラリからD&D配置） -----
    if (canvasFrame) {
      canvasFrame.addEventListener('dragover', (e) => {
        if (!draggingLibImageId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        canvasFrame.classList.add('drag-target');
      });
      canvasFrame.addEventListener('dragleave', (e) => {
        // canvasFrame 外に出た時のみ解除（子要素間移動を無視）
        if (e.target === canvasFrame) {
          canvasFrame.classList.remove('drag-target');
        }
      });
      canvasFrame.addEventListener('drop', (e) => {
        if (!draggingLibImageId) return;
        e.preventDefault();
        canvasFrame.classList.remove('drag-target');
        const pageSize = pageSizesMm[currentPageIndex];
        if (!pageSize) return;
        const rect = canvasFrame.getBoundingClientRect();
        const xPx = e.clientX - rect.left;
        const yPx = e.clientY - rect.top;
        const xMm = (xPx / rect.width) * pageSize.width;
        const yMm = (yPx / rect.height) * pageSize.height;
        // dataTransfer の中身を見て単一 or 複数 を判別
        const payload = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
        if (payload.startsWith('imgplace-lib-multi:')) {
          const ids = payload.slice('imgplace-lib-multi:'.length).split(',').filter(Boolean);
          // ドロップ点から右下方向に少しずつオフセットして並べる
          const OFFSET_MM = 5;
          ids.forEach((id, i) => {
            placeAtPoint(id, xMm + i * OFFSET_MM, yMm + i * OFFSET_MM);
          });
          setStatus(ids.length + ' 枚を配置 (ドロップ点から右下にオフセット)');
        } else {
          placeAtPoint(draggingLibImageId, xMm, yMm);
        }
        draggingLibImageId = null;
      });

      // 順次配置モード中: canvas クリックで Queue の先頭を配置
      canvasFrame.addEventListener('click', (e) => {
        if (!placeQueueMode || placeQueue.length === 0) return;
        // 配置済み画像クリックや他要素クリックでは反応しない (ターゲット限定)
        if (e.target !== canvasFrame && e.target.tagName !== 'CANVAS') return;
        const pos = getPagePosMm(e.clientX, e.clientY);
        if (!pos) return;
        const nextId = placeQueue.shift();
        placeAtPoint(nextId, pos.xMm, pos.yMm);
        if (placeQueue.length === 0) {
          stopPlaceQueueMode('全て配置完了');
        } else {
          setStatus('順次配置: クリックで次を配置 (残り ' + placeQueue.length + ' 枚 / Esc でキャンセル)');
          updateQueuePreviewContent(); // 次の画像のプレビューに切替
        }
      });
      // canvas 上で pointer 動いたらプレビュー追従
      canvasFrame.addEventListener('pointermove', (e) => {
        if (placeQueueMode && placeQueue.length > 0) {
          moveQueuePreview(e.clientX, e.clientY);
        }
      });
      canvasFrame.addEventListener('pointerleave', () => {
        if (placeQueueMode) hideQueuePreview();
      });
    }
    // 順次配置モード制御
    function startPlaceQueueMode() {
      if (libSelectedIds.length === 0) {
        setStatus('画像ライブラリで配置したい画像を選択してください', 'error');
        return;
      }
      placeQueue = libSelectedIds.slice();
      placeQueueMode = true;
      const mode = document.getElementById('modeImgPlace');
      if (mode) mode.classList.add('imgplace-place-queue-mode');
      setStatus('順次配置: クリックで次を配置 (残り ' + placeQueue.length + ' 枚 / Esc でキャンセル)');
      updatePlaceQueueBtn();
      updateQueuePreviewContent(); // 1枚目のプレビュー内容セット
    }
    function stopPlaceQueueMode(reason) {
      placeQueue = [];
      placeQueueMode = false;
      const mode = document.getElementById('modeImgPlace');
      if (mode) mode.classList.remove('imgplace-place-queue-mode');
      setStatus(reason || '順次配置モード終了');
      updatePlaceQueueBtn();
      hideQueuePreview();
    }
    // ----- 順次配置プレビュー (カーソル追従、サムネ+ファイル名) -----
    function updateQueuePreviewContent() {
      const el = document.getElementById('imgPlaceQueuePreview');
      if (!el) return;
      if (!placeQueueMode || placeQueue.length === 0) {
        el.classList.remove('visible');
        return;
      }
      const nextId = placeQueue[0];
      const img = imageLibrary.find(im => im.id === nextId);
      if (!img) { el.classList.remove('visible'); return; }
      const imgEl = document.getElementById('imgPlaceQueuePreviewImg');
      const nameEl = document.getElementById('imgPlaceQueuePreviewName');
      const metaEl = document.getElementById('imgPlaceQueuePreviewMeta');
      if (imgEl) imgEl.src = img.dataUrl;
      if (nameEl) nameEl.textContent = img.filename;
      if (metaEl) {
        const orderInfo = (libSelectedIds.length - placeQueue.length + 1) + '/' + libSelectedIds.length;
        metaEl.textContent = '次 ' + orderInfo + ' · ' + img.originalWidthPx + '×' + img.originalHeightPx;
      }
      // 表示は pointermove で起動 (canvas に入った時)
    }
    function hideQueuePreview() {
      const el = document.getElementById('imgPlaceQueuePreview');
      if (el) el.classList.remove('visible');
    }
    function moveQueuePreview(clientX, clientY) {
      const el = document.getElementById('imgPlaceQueuePreview');
      if (!el || !placeQueueMode || placeQueue.length === 0) return;
      el.classList.add('visible');
      // カーソル右下に少しオフセット (カーソル隠さないよう)
      const offsetX = 18, offsetY = 18;
      // 画面端近くなら左/上に反転
      const w = el.offsetWidth || 260, h = el.offsetHeight || 76;
      let x = clientX + offsetX;
      let y = clientY + offsetY;
      if (x + w > window.innerWidth) x = clientX - w - 8;
      if (y + h > window.innerHeight) y = clientY - h - 8;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }
    // 順次配置ボタンの表示・ラベル更新
    function updatePlaceQueueBtn() {
      const btn = document.getElementById('imgPlacePlaceQueueBtn');
      if (!btn) return;
      if (placeQueueMode) {
        btn.textContent = '⏹ 順次配置中止 (残り' + placeQueue.length + ')';
        btn.dataset.active = 'on';
        btn.style.display = '';
      } else if (libSelectedIds.length > 0) {
        btn.textContent = '🎯 順次配置 (' + libSelectedIds.length + '枚)';
        btn.dataset.active = 'off';
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    }
    // Esc キーで順次配置キャンセル + 複数選択解除 (lib / pages)
    window.addEventListener('keydown', (e) => {
      const panel = document.getElementById('modeImgPlace');
      if (!panel || !panel.classList.contains('active')) return;
      if (e.key === 'Escape') {
        if (placeQueueMode) {
          stopPlaceQueueMode('順次配置キャンセル');
        } else if (libSelectedIds.length > 0) {
          clearLibSelection();
        } else if (pageSelectedIndices.size > 0) {
          pageSelectedIndices.clear();
          pageLastClickedIndex = null;
          updatePageSelectionDom();
          setStatus('');
        }
      }
    });

    // ----- ラバーバンド選択 -----
    function startRubberBand(e) {
      const start = getPagePosMm(e.clientX, e.clientY);
      if (!start) return;
      rubberState = {
        startXMm: start.xMm,
        startYMm: start.yMm,
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastXMm: start.xMm,
        lastYMm: start.yMm,
        moved: false,
        el: null,
        // Shift 押下中は既存選択に追加、それ以外は置換
        addMode: !!e.shiftKey
      };
    }
    function updateRubberBand(e) {
      if (!rubberState) return;
      const dx = Math.abs(e.clientX - rubberState.startClientX);
      const dy = Math.abs(e.clientY - rubberState.startClientY);
      if (!rubberState.moved && (dx > 3 || dy > 3)) {
        rubberState.moved = true;
        rubberState.el = document.createElement('div');
        rubberState.el.className = 'imgplace-rubber';
        overlay.appendChild(rubberState.el);
      }
      if (rubberState.moved) {
        const cur = getPagePosMm(e.clientX, e.clientY);
        if (!cur) return;
        rubberState.lastXMm = cur.xMm;
        rubberState.lastYMm = cur.yMm;
        const pageSize = pageSizesMm[currentPageIndex];
        if (pageSize && rubberState.el) {
          const x1 = Math.min(rubberState.startXMm, cur.xMm);
          const y1 = Math.min(rubberState.startYMm, cur.yMm);
          const x2 = Math.max(rubberState.startXMm, cur.xMm);
          const y2 = Math.max(rubberState.startYMm, cur.yMm);
          rubberState.el.style.left = (x1 / pageSize.width * 100) + '%';
          rubberState.el.style.top = (y1 / pageSize.height * 100) + '%';
          rubberState.el.style.width = ((x2 - x1) / pageSize.width * 100) + '%';
          rubberState.el.style.height = ((y2 - y1) / pageSize.height * 100) + '%';
        }
      }
    }
    function completeRubberBand() {
      if (!rubberState) return;
      if (rubberState.moved) {
        // 矩形と交差する全配置を取得
        const x1 = Math.min(rubberState.startXMm, rubberState.lastXMm);
        const y1 = Math.min(rubberState.startYMm, rubberState.lastYMm);
        const x2 = Math.max(rubberState.startXMm, rubberState.lastXMm);
        const y2 = Math.max(rubberState.startYMm, rubberState.lastYMm);
        const insideIds = placements
          .filter(p =>
            p.pageIndex === currentPageIndex &&
            p.xMm < x2 && p.xMm + p.widthMm > x1 &&
            p.yMm < y2 && p.yMm + p.heightMm > y1
          )
          .map(p => p.id);
        if (!rubberState.addMode) {
          selectedPlacementIds = new Set();
        }
        for (const id of insideIds) {
          selectedPlacementIds.add(id);
        }
        if (insideIds.length > 0) {
          selectedPlacementId = insideIds[insideIds.length - 1];
        } else if (selectedPlacementIds.size === 0) {
          selectedPlacementId = null;
        }
      } else {
        // 動いてない＝ただのクリック → 選択クリア（Shift時は維持）
        if (!rubberState.addMode) {
          clearSelection();
        }
      }
      if (rubberState.el && rubberState.el.parentNode) {
        rubberState.el.parentNode.removeChild(rubberState.el);
      }
      rubberState = null;
      renderPlacements();
    }

    // ----- 背景クリック/ドラッグでラバーバンド開始 -----
    if (canvasFrame) {
      canvasFrame.addEventListener('pointerdown', (e) => {
        // canvas / overlay 直接クリック時のみ（placement・ハンドルは stopPropagation 済）
        if (e.target === canvasFrame || e.target === canvas || e.target === overlay) {
          startRubberBand(e);
        }
      });
    }

    // ----- ドラッグ追従: window.pointermove -----
    window.addEventListener('pointermove', (e) => {
      // タッチ位置追跡 + ピンチリサイズ適用（最優先、他のドラッグより前）
      if (e.pointerType === 'touch') {
        const ent = activeTouches.get(e.pointerId);
        if (ent) {
          ent.clientX = e.clientX;
          ent.clientY = e.clientY;
        }
        if (pinchState && activeTouches.size >= 2) {
          const pts = [...activeTouches.values()].slice(0, 2);
          const dx = pts[1].clientX - pts[0].clientX;
          const dy = pts[1].clientY - pts[0].clientY;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const scale = dist / pinchState.startDistance;
          const pl = placements.find(p => p.id === pinchState.placementId);
          if (pl) {
            const MIN_MM = 5;
            const newW = Math.max(MIN_MM, pinchState.original.widthMm * scale);
            const newH = Math.max(MIN_MM, pinchState.original.heightMm * scale);
            pl.widthMm = newW;
            pl.heightMm = newH;
            // 中心固定: 元の center が変わらないよう xMm/yMm を補正
            pl.xMm = pinchState.original.xMm + (pinchState.original.widthMm - newW) / 2;
            pl.yMm = pinchState.original.yMm + (pinchState.original.heightMm - newH) / 2;
            renderPlacements();
          }
          return; // 他のドラッグ処理スキップ
        }
      }
      // ラバーバンド進行中は他のドラッグロジックを bypass
      if (rubberState) {
        updateRubberBand(e);
        return;
      }
      if (!dragState) return;
      // 移動モード中はゴミ箱との重なり判定（カーソル基準、ゴースト位置は後でスナップ後の配置に追従させる）
      if (dragState.mode === 'move') {
        const over = isOverTrash(e.clientX, e.clientY);
        dragState.overTrash = over;
        if (trashEl) trashEl.classList.toggle('hover', over);
        if (dragState.ghost && dragState.ghost.ghost) {
          dragState.ghost.ghost.classList.toggle('over-trash', over);
        }
      }
      const current = getPagePosMm(e.clientX, e.clientY);
      if (!current) return;
      const pl = placements.find(p => p.id === dragState.placementId);
      if (!pl) return;
      if (dragState.mode === 'move') {
        let dx = current.xMm - dragState.startMouseXMm;
        let dy = current.yMm - dragState.startMouseYMm;
        // Shift拘束: 大きい方の軸だけ採用（水平または垂直のみ移動）
        // マルチドラッグでも primary の dx/dy が拘束されると、後段の dxApplied/dyApplied 経由で全選択に伝搬
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const pageSize = pageSizesMm[pl.pageIndex];
        let newX = dragState.original.xMm + dx;
        let newY = dragState.original.yMm + dy;
        // スナップ適用（clamp の前に行う）
        if (snapEnabled) {
          const snap = computeSnapForMove(newX, newY, dragState.original.widthMm, dragState.original.heightMm);
          newX += snap.dx;
          newY += snap.dy;
          activeGuides = snap.guides;
          // セルスナップ中ならハイライト
          if (snap.cell !== activeSnapCell) {
            activeSnapCell = snap.cell || null;
            updateActiveSnapCellOverlay();
          }
        } else {
          activeGuides = [];
          if (activeSnapCell) {
            activeSnapCell = null;
            updateActiveSnapCellOverlay();
          }
        }
        // ページ範囲内にクランプ（移動時のみ）
        if (pageSize) {
          newX = Math.max(0, Math.min(newX, pageSize.width - dragState.original.widthMm));
          newY = Math.max(0, Math.min(newY, pageSize.height - dragState.original.heightMm));
        }
        pl.xMm = newX;
        pl.yMm = newY;
        // マルチドラッグ: 他選択も同 delta（Primary の実移動量）で移動、それぞれページ範囲内にクランプ
        if (dragState.multiOriginals && dragState.multiOriginals.length > 0) {
          const dxApplied = pl.xMm - dragState.original.xMm;
          const dyApplied = pl.yMm - dragState.original.yMm;
          for (const m of dragState.multiOriginals) {
            const otherPl = placements.find(p => p.id === m.id);
            if (!otherPl) continue;
            let newOX = m.xMm + dxApplied;
            let newOY = m.yMm + dyApplied;
            if (pageSize) {
              newOX = Math.max(0, Math.min(newOX, pageSize.width - m.widthMm));
              newOY = Math.max(0, Math.min(newOY, pageSize.height - m.heightMm));
            }
            otherPl.xMm = newOX;
            otherPl.yMm = newOY;
          }
        }
        // ゴーストの位置決め: ハイブリッド方式
        // - カーソルが canvas-frame 内: スナップ後の配置位置に追従（ヘリ/中心がガイドに吸付く視覚）
        // - カーソルが canvas-frame 外: カーソルに自由追従（ゴミ箱までドラッグ可能に）
        if (dragState.ghost && dragState.ghost.ghost && pageSize) {
          const frameRect = canvasFrame.getBoundingClientRect();
          const cursorOutside = (e.clientX < frameRect.left) || (e.clientX > frameRect.right)
                              || (e.clientY < frameRect.top)  || (e.clientY > frameRect.bottom);
          if (cursorOutside) {
            // 自由追従（drag start 時に記録した cursor-to-image オフセットを保ったまま）
            dragState.ghost.ghost.style.left = (e.clientX - dragState.ghost.offsetX) + 'px';
            dragState.ghost.ghost.style.top  = (e.clientY - dragState.ghost.offsetY) + 'px';
          } else if (frameRect.width > 0) {
            const plLeftPx = frameRect.left + pl.xMm / pageSize.width * frameRect.width;
            const plTopPx  = frameRect.top  + pl.yMm / pageSize.height * frameRect.height;
            dragState.ghost.ghost.style.left = plLeftPx + 'px';
            dragState.ghost.ghost.style.top  = plTopPx  + 'px';
          }
        }
      } else if (dragState.mode === 'resize') {
        // デフォルトのアスペクト比固定 (pl.aspectLocked) を Shift で一時反転
        const lockDefault = pl.aspectLocked !== false;
        const lockAspect = lockDefault !== !!e.shiftKey;
        const r = applyResize(dragState.corner, current.xMm, current.yMm, dragState.original, lockAspect);
        pl.xMm = r.xMm;
        pl.yMm = r.yMm;
        pl.widthMm = r.widthMm;
        pl.heightMm = r.heightMm;
        // スナップは AR 非固定時のみ適用（固定時は比率が崩れるので無効化）
        if (snapEnabled && !lockAspect) {
          const rect = {
            left: pl.xMm,
            top: pl.yMm,
            right: pl.xMm + pl.widthMm,
            bottom: pl.yMm + pl.heightMm
          };
          const snap = computeSnapForResize(dragState.corner, rect);
          const cornerNow = dragState.corner;
          const isLeftNow   = cornerNow === 'nw' || cornerNow === 'sw' || cornerNow === 'w';
          const isTopNow    = cornerNow === 'nw' || cornerNow === 'ne' || cornerNow === 'n';
          if (snap.snapX) {
            if (snap.snapX.edge === 'left') {
              pl.xMm = snap.snapX.target;
              pl.widthMm -= snap.snapX.delta;
            } else if (snap.snapX.edge === 'right') {
              pl.widthMm += snap.snapX.delta;
            } else if (snap.snapX.edge === 'centerX') {
              // 中心線スナップ: 動いてない側を anchor として反対側を調整
              if (isLeftNow) {
                const rightAnchor = pl.xMm + pl.widthMm;
                const newLeft = 2 * snap.snapX.target - rightAnchor;
                pl.widthMm = rightAnchor - newLeft;
                pl.xMm = newLeft;
              } else { // 右が動く（'ne'/'se'/'e'）
                const leftAnchor = pl.xMm;
                const newRight = 2 * snap.snapX.target - leftAnchor;
                pl.widthMm = newRight - leftAnchor;
              }
            }
          }
          if (snap.snapY) {
            if (snap.snapY.edge === 'top') {
              pl.yMm = snap.snapY.target;
              pl.heightMm -= snap.snapY.delta;
            } else if (snap.snapY.edge === 'bottom') {
              pl.heightMm += snap.snapY.delta;
            } else if (snap.snapY.edge === 'centerY') {
              if (isTopNow) {
                const bottomAnchor = pl.yMm + pl.heightMm;
                const newTop = 2 * snap.snapY.target - bottomAnchor;
                pl.heightMm = bottomAnchor - newTop;
                pl.yMm = newTop;
              } else {
                const topAnchor = pl.yMm;
                const newBottom = 2 * snap.snapY.target - topAnchor;
                pl.heightMm = newBottom - topAnchor;
              }
            }
          }
          activeGuides = snap.guides;
        } else {
          activeGuides = [];
        }
      }
      renderPlacements();
    });

    // ----- ドラッグ終了（ゴミ箱判定込み） -----
    function endDrag() {
      if (!dragState) return;
      // ゴミ箱上で離した場合は削除
      const deleteId = (dragState.mode === 'move' && dragState.overTrash) ? dragState.placementId : null;
      // マルチ選択時は選択中の全配置を削除対象に
      let deleteIds = [];
      if (deleteId) {
        if (selectedPlacementIds && selectedPlacementIds.size > 1 && selectedPlacementIds.has(deleteId)) {
          deleteIds = Array.from(selectedPlacementIds);
        } else {
          deleteIds = [deleteId];
        }
      }
      // ゴースト破棄
      if (dragState.ghost) destroyDragGhost(dragState.ghost);
      dragState = null;
      // スナップガイド + セルハイライトもクリア
      activeGuides = [];
      if (activeSnapCell) {
        activeSnapCell = null;
        updateActiveSnapCellOverlay();
      }
      const modePanel = document.getElementById('modeImgPlace');
      if (modePanel) modePanel.classList.remove('imgplace-dragging');
      hideTrash();
      if (deleteIds.length > 0) {
        for (const id of deleteIds) deletePlacement(id); // 各 deletePlacement 内で renderPlacements が呼ばれるが、軽量なのでOK
        if (deleteIds.length > 1) setStatus(deleteIds.length + ' 個の配置を削除');
      } else {
        renderPlacements(); // dragging-source クラス除去とガイドクリアのため再描画
        // 移動/リサイズ commit 後にもサムネ更新 (位置・サイズ変化反映)
        queueThumbUpdate(currentPageIndex);
      }
    }
    function endPointerInteraction(e) {
      // タッチの up/cancel: activeTouches から削除、pinch 終了判定
      if (e && e.pointerType === 'touch') {
        activeTouches.delete(e.pointerId);
        if (pinchState && activeTouches.size < 2) {
          // ピンチ終了（残り 1 本指でも自動でドラッグに移行はしない、一度離してから再開）
          pinchState = null;
          return;
        }
      }
      if (rubberState) {
        completeRubberBand();
        return;
      }
      endDrag();
    }
    window.addEventListener('pointerup', endPointerInteraction);
    window.addEventListener('pointercancel', endPointerInteraction);

    // ----- キーボード: Delete / Backspace で選択中の配置を削除 -----
    window.addEventListener('keydown', (e) => {
      // 画像配置タブが active な時のみ反応
      const panel = document.getElementById('modeImgPlace');
      if (!panel || !panel.classList.contains('active')) return;
      // 入力フィールドにフォーカス中は無視
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPlacementIds.size > 0) {
        e.preventDefault();
        deleteSelected(); // マルチ選択時は全部削除
      }
    });

    // ----- Lv.2: 罫線スナップトグルボタン -----
    // ON: 現ページの罫線を抽出 → SVGで可視化 + スナップ対象に登録
    // OFF: オーバーレイクリア + detectedSnapTargets を null に
    if (lineDetectBtn) {
      lineDetectBtn.addEventListener('click', async () => {
        lineDetectionEnabled = !lineDetectionEnabled;
        lineDetectBtn.dataset.active = lineDetectionEnabled ? 'on' : 'off';
        lineDetectBtn.textContent = lineDetectionEnabled ? '📐 罫線スナップ ON' : '📐 罫線スナップ OFF';
        if (linesOverlay) linesOverlay.classList.toggle('visible', lineDetectionEnabled);
        // 即時に現ページを再解析
        if (lineDetectionEnabled && pdfjsDoc) {
          try {
            const page = await pdfjsDoc.getPage(currentPageIndex + 1);
            const lineData = await extractPageLines(page);
            detectedSnapTargets = buildDetectedSnapTargets(lineData, page);
            renderLineOverlay(lineData, page, detectedSnapTargets);
          } catch (err) {
            console.warn('[imgPlace] 罫線検出失敗:', err);
            setStatus('罫線検出失敗: ' + (err.message || err), 'error');
            detectedSnapTargets = null;
          }
        } else {
          // OFF時はオーバーレイ中身クリア + スナップ対象も解除
          if (linesOverlay) {
            while (linesOverlay.firstChild) linesOverlay.removeChild(linesOverlay.firstChild);
          }
          detectedSnapTargets = null;
        }
      });
    }

    // ----- 1/3 サイズ制限トグルボタン -----
    const sizeCapBtn = document.getElementById('imgPlaceSizeCapBtn');
    function applySizeCapBtnState() {
      if (!sizeCapBtn) return;
      sizeCapBtn.dataset.active = sizeCapEnabled ? 'on' : 'off';
      sizeCapBtn.textContent = sizeCapEnabled ? '📏 1/3制限 ON' : '📏 1/3制限 OFF';
    }
    applySizeCapBtnState();
    if (sizeCapBtn) {
      sizeCapBtn.addEventListener('click', () => {
        sizeCapEnabled = !sizeCapEnabled;
        try { localStorage.setItem('imgPlaceSizeCap', sizeCapEnabled ? 'on' : 'off'); } catch (_e) {}
        applySizeCapBtnState();
        setStatus(sizeCapEnabled
          ? '配置サイズ上限: ページの1/3 (以降の配置に適用)'
          : '配置サイズ上限: なし (原寸 / ページ範囲内のみ保険)');
      });
    }

    // ----- カスタムセル トグル + 描画 / 削除 -----
    // ----- 列幅スプリッター: 左/右ペインの幅をドラッグで可変、localStorage 永続化 -----
    (function setupSplitters() {
      const editor = document.querySelector('#modeImgPlace .imgplace-editor');
      const leftSp = document.getElementById('imgPlaceSplitterLeft');
      const rightSp = document.getElementById('imgPlaceSplitterRight');
      if (!editor) return;
      // localStorage から復元 (初回は default)
      try {
        const lw = localStorage.getItem('imgPlaceLeftW');
        const rw = localStorage.getItem('imgPlaceRightW');
        if (lw && /^\d+px$/.test(lw)) editor.style.setProperty('--imgplace-left', lw);
        if (rw && /^\d+px$/.test(rw)) editor.style.setProperty('--imgplace-right', rw);
      } catch (_e) {}
      const MIN_LEFT = 80;
      const MIN_RIGHT = 160;
      function attach(sp, side) {
        if (!sp) return;
        sp.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          try { sp.setPointerCapture(e.pointerId); } catch (_) {}
          sp.classList.add('dragging');
          document.body.style.cursor = 'col-resize';
          const startX = e.clientX;
          const editorRect = editor.getBoundingClientRect();
          const cs = getComputedStyle(editor);
          const initLeft = parseFloat(cs.getPropertyValue('--imgplace-left')) || 180;
          const initRight = parseFloat(cs.getPropertyValue('--imgplace-right')) || 280;
          // canvas 列が小さくなりすぎないよう、左右合計の上限を editor 幅の80%にキャップ
          const maxSumW = editorRect.width * 0.8;
          function onMove(ev) {
            const dx = ev.clientX - startX;
            if (side === 'left') {
              let w = Math.max(MIN_LEFT, initLeft + dx);
              // 右ペインが現状幅のとき、左+右が maxSumW を超えないよう抑制
              if (w + initRight > maxSumW) w = maxSumW - initRight;
              editor.style.setProperty('--imgplace-left', w + 'px');
            } else {
              let w = Math.max(MIN_RIGHT, initRight - dx);
              if (initLeft + w > maxSumW) w = maxSumW - initLeft;
              editor.style.setProperty('--imgplace-right', w + 'px');
            }
          }
          function onEnd() {
            sp.classList.remove('dragging');
            document.body.style.cursor = '';
            sp.removeEventListener('pointermove', onMove);
            sp.removeEventListener('pointerup', onEnd);
            sp.removeEventListener('pointercancel', onEnd);
            try {
              const cur = getComputedStyle(editor);
              const lw = cur.getPropertyValue('--imgplace-left').trim();
              const rw = cur.getPropertyValue('--imgplace-right').trim();
              if (lw) localStorage.setItem('imgPlaceLeftW', lw);
              if (rw) localStorage.setItem('imgPlaceRightW', rw);
            } catch (_) {}
          }
          sp.addEventListener('pointermove', onMove);
          sp.addEventListener('pointerup', onEnd);
          sp.addEventListener('pointercancel', onEnd);
        });
      }
      attach(leftSp, 'left');
      attach(rightSp, 'right');

      // ウィンドウ縮小時、固定値の左/右ペインが canvas を潰しすぎないよう比例縮小
      function clampColumnsToViewport() {
        const W = editor.clientWidth;
        if (W < 100) return;
        const MIN_CANVAS = 280;
        const SPLITTER_TOTAL = 12;
        const maxSum = W - MIN_CANVAS - SPLITTER_TOTAL;
        const cs2 = getComputedStyle(editor);
        const leftStr = cs2.getPropertyValue('--imgplace-left').trim();
        const rightStr = cs2.getPropertyValue('--imgplace-right').trim();
        // ユーザーが固定値 (px) に設定済の時のみ介入。clamp() デフォルトはそのまま CSS に任せる
        const leftFixed = leftStr.match(/^(\d+(?:\.\d+)?)px$/);
        const rightFixed = rightStr.match(/^(\d+(?:\.\d+)?)px$/);
        if (!leftFixed && !rightFixed) return;
        const lv = leftFixed ? parseFloat(leftFixed[1]) : 0;
        const rv = rightFixed ? parseFloat(rightFixed[1]) : 0;
        if (lv + rv > maxSum && maxSum > 0) {
          const ratio = maxSum / (lv + rv);
          if (leftFixed) editor.style.setProperty('--imgplace-left', Math.max(80, Math.round(lv * ratio)) + 'px');
          if (rightFixed) editor.style.setProperty('--imgplace-right', Math.max(160, Math.round(rv * ratio)) + 'px');
        }
      }
      window.addEventListener('resize', clampColumnsToViewport);
      // 初回 + editor サイズ変化時にも実行
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => clampColumnsToViewport());
        ro.observe(editor);
      }
      clampColumnsToViewport();
    })();

    // ----- 右サイドバー 上下スプリッター: props ↔ library -----
    (function setupSidebarSplitter() {
      const sidebar = document.querySelector('#modeImgPlace .imgplace-sidebar');
      const sp = document.getElementById('imgPlaceSidebarSplitter');
      const propsEl = document.getElementById('imgPlaceProps');
      if (!sidebar || !sp || !propsEl) return;
      // localStorage から復元
      try {
        const ph = localStorage.getItem('imgPlacePropsH');
        if (ph && /^\d+px$/.test(ph)) sidebar.style.setProperty('--imgplace-props-h', ph);
      } catch (_e) {}
      const MIN_PROPS = 60;
      const MIN_LIB = 120;
      sp.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { sp.setPointerCapture(e.pointerId); } catch (_) {}
        sp.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        const startY = e.clientY;
        // 自然コンテンツ高さを測る: CSS var を一時クリア → auto に戻る → 測定 → 復元
        // ※同一 JS 同期実行なので画面チラつき無し
        const savedVar = sidebar.style.getPropertyValue('--imgplace-props-h');
        sidebar.style.removeProperty('--imgplace-props-h');
        const naturalH = propsEl.offsetHeight;
        if (savedVar) sidebar.style.setProperty('--imgplace-props-h', savedVar);
        const propsRect = propsEl.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const initH = propsRect.height;
        // sidebar 余裕: 全高 - MIN_LIB - splitter - gap
        const maxBySidebar = sidebarRect.height - MIN_LIB - 6 - 12;
        // コンテンツ自然サイズで cap (これ以上広げても中身ないので無意味)
        const maxByContent = naturalH;
        const maxH = Math.max(MIN_PROPS, Math.min(maxBySidebar, maxByContent));
        function onMove(ev) {
          const dy = ev.clientY - startY;
          let h = Math.max(MIN_PROPS, Math.min(maxH, initH + dy));
          sidebar.style.setProperty('--imgplace-props-h', h + 'px');
        }
        function onEnd() {
          sp.classList.remove('dragging');
          document.body.style.cursor = '';
          sp.removeEventListener('pointermove', onMove);
          sp.removeEventListener('pointerup', onEnd);
          sp.removeEventListener('pointercancel', onEnd);
          try {
            const ph = getComputedStyle(sidebar).getPropertyValue('--imgplace-props-h').trim();
            if (ph) localStorage.setItem('imgPlacePropsH', ph);
          } catch (_) {}
        }
        sp.addEventListener('pointermove', onMove);
        sp.addEventListener('pointerup', onEnd);
        sp.addEventListener('pointercancel', onEnd);
      });

      // sidebar 高さが縮んだ時、固定 props 高さがライブラリを潰さないよう再 clamp
      function clampSidebarToViewport() {
        const H = sidebar.clientHeight;
        if (H < 100) return;
        const cs3 = getComputedStyle(sidebar);
        const phStr = cs3.getPropertyValue('--imgplace-props-h').trim();
        const phFixed = phStr.match(/^(\d+(?:\.\d+)?)px$/);
        if (!phFixed) return;
        const ph = parseFloat(phFixed[1]);
        const maxAllow = H - MIN_LIB - 6 - 12;
        if (ph > maxAllow && maxAllow > MIN_PROPS) {
          sidebar.style.setProperty('--imgplace-props-h', Math.round(maxAllow) + 'px');
        }
      }
      window.addEventListener('resize', clampSidebarToViewport);
      if (typeof ResizeObserver === 'function') {
        const ro2 = new ResizeObserver(() => clampSidebarToViewport());
        ro2.observe(sidebar);
      }
      clampSidebarToViewport();
    })();

    // ----- カスタムセル トグル + 描画 / 削除 -----
    // ON: ドラッグで矩形追加 / 既存矩形クリックで削除
    // OFF: 編集不可だがスナップ対象としては有効
    const customCellBtn = document.getElementById('imgPlaceCustomCellBtn');
    const customCellLayer = document.getElementById('imgPlaceCustomCellLayer');
    if (customCellBtn && customCellLayer) {
      customCellBtn.addEventListener('click', () => {
        customCellModeOn = !customCellModeOn;
        customCellBtn.dataset.active = customCellModeOn ? 'on' : 'off';
        customCellBtn.textContent = customCellModeOn ? '✏️ カスタムセル ON' : '✏️ カスタムセル OFF';
        customCellLayer.classList.toggle('active', customCellModeOn);
        // ON 直後に既存セルを再描画（hover/title が変わる）
        renderCustomCells();
        if (customCellModeOn) {
          setStatus('カスタムセル: ドラッグで追加 / 隅でリサイズ / 本体ドラッグで移動 / × 削除 / + 複製');
        } else {
          clearAlignmentGuides();
          setStatus('');
        }
      });

      // 描画: layer 自身への pointerdown のみ（既存セル div への click は別 handler）
      customCellLayer.addEventListener('pointerdown', (e) => {
        if (!customCellModeOn) return;
        if (e.target !== customCellLayer) return; // 既存セル click は放置
        const startRaw = getPagePosMm(e.clientX, e.clientY);
        if (!startRaw) return;
        // 検出罫線 + 他カスタムセルエッジへのスナップ (始点)
        const startSnap = computeCustomCellSnap([startRaw.xMm], [startRaw.yMm], null);
        const startX = startRaw.xMm + startSnap.dx;
        const startY = startRaw.yMm + startSnap.dy;
        const preview = document.createElement('div');
        preview.className = 'imgplace-custom-cell-preview';
        customCellLayer.appendChild(preview);
        customCellDrawState = {
          startX: startX, startY: startY,
          curX: startX,   curY: startY,
          preview: preview,
          pointerId: e.pointerId
        };
        try { customCellLayer.setPointerCapture(e.pointerId); } catch (_e) {}
        // 始点ガイド (短すぎてもとりあえず描画)
        renderAlignmentGuides(startSnap.vGuide, startSnap.hGuide,
          { xL: startX, xR: startX, yT: startY, yB: startY });
        e.preventDefault();
        e.stopPropagation();
      });
      customCellLayer.addEventListener('pointermove', (e) => {
        if (!customCellDrawState) return;
        const curRaw = getPagePosMm(e.clientX, e.clientY);
        if (!curRaw) return;
        // 終点も検出罫線 + 他カスタムセルエッジへスナップ
        const curSnap = computeCustomCellSnap([curRaw.xMm], [curRaw.yMm], null);
        customCellDrawState.curX = curRaw.xMm + curSnap.dx;
        customCellDrawState.curY = curRaw.yMm + curSnap.dy;
        const ds = customCellDrawState;
        const pageSize = pageSizesMm[currentPageIndex];
        if (!pageSize) return;
        const xL = Math.min(ds.startX, ds.curX);
        const xR = Math.max(ds.startX, ds.curX);
        const yT = Math.min(ds.startY, ds.curY);
        const yB = Math.max(ds.startY, ds.curY);
        ds.preview.style.left   = (xL / pageSize.width  * 100) + '%';
        ds.preview.style.top    = (yT / pageSize.height * 100) + '%';
        ds.preview.style.width  = ((xR - xL) / pageSize.width  * 100) + '%';
        ds.preview.style.height = ((yB - yT) / pageSize.height * 100) + '%';
        // 終点のガイドを更新 (描画中の rect 範囲を movingRect として渡す)
        renderAlignmentGuides(curSnap.vGuide, curSnap.hGuide, { xL, xR, yT, yB });
      });
      const finishCustomDraw = (e) => {
        if (!customCellDrawState) return;
        const ds = customCellDrawState;
        if (ds.preview && ds.preview.parentNode) ds.preview.parentNode.removeChild(ds.preview);
        clearAlignmentGuides();
        const xL = Math.min(ds.startX, ds.curX);
        const xR = Math.max(ds.startX, ds.curX);
        const yT = Math.min(ds.startY, ds.curY);
        const yB = Math.max(ds.startY, ds.curY);
        const w = xR - xL, h = yB - yT;
        customCellDrawState = null;
        // 5mm未満は無視（ノイズ）
        if (w >= 5 && h >= 5) {
          if (!customCellsByPage[currentPageIndex]) customCellsByPage[currentPageIndex] = [];
          customCellsByPage[currentPageIndex].push({
            xMm: (xL + xR) / 2,
            yMm: (yT + yB) / 2,
            widthMm: w,
            heightMm: h
          });
          renderCustomCells();
          scheduleAutosave && scheduleAutosave();
          setStatus('カスタムセル追加（合計 ' + customCellsByPage[currentPageIndex].length + ' 個）');
        }
      };
      customCellLayer.addEventListener('pointerup', finishCustomDraw);
      customCellLayer.addEventListener('pointercancel', finishCustomDraw);
    }

    // ----- スナップトグルボタン -----
    if (snapBtn) {
      updateSnapBtn(); // 初期表示（localStorage の値を反映）
      snapBtn.addEventListener('click', () => {
        snapEnabled = !snapEnabled;
        try {
          localStorage.setItem('imgPlaceSnapEnabled', snapEnabled ? 'true' : 'false');
        } catch (e) { /* localStorage 不可環境では無視 */ }
        updateSnapBtn();
        scheduleAutosave(); // ui_state.snap_enabled も autosave 対象
      });
    }

    // ----- キャプションフォント selector -----
    if (fontSelect) {
      // 初期値を復元（option の value と一致するものを selected に）
      const matchingOption = Array.from(fontSelect.options).find(o => o.value === captionFont);
      if (matchingOption) fontSelect.value = captionFont;
      fontSelect.addEventListener('change', () => {
        captionFont = fontSelect.value;
        try {
          localStorage.setItem('imgPlaceCaptionFont', captionFont);
        } catch (e) { /* 無視 */ }
        renderPlacements(); // 全キャプションを新フォントで再描画 (内部で scheduleAutosave 呼ばれる)
      });
    }

    // ----- ファイルダウンロードヘルパー -----
    // モバイル (iOS/Android) のみ Web Share API を使い、共有シートで保存先を選ばせる
    // デスクトップは Windows 11 の共有ダイアログ等が邪魔なので、常に標準 <a download> 使用
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
