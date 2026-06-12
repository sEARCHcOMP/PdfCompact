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
