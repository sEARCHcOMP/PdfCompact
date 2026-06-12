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
