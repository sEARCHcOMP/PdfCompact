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
