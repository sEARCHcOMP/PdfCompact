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
