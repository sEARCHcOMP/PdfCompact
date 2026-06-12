  (function pdfEditModule() {
    'use strict';

    let sources = [];
    let pages = [];
    let splits = new Set();
    let dragIdx = null;

    const $ = (id) => document.getElementById(id);
    const dropzone = $('editDropzone');
    const fileInput = $('editFileInput');
    const listPanel = $('editListPanel');
    const actionBar = $('editActionBar');
    const totalStats = $('editTotalStats');
    const pageGrid = $('editPageGrid');
    const generateBtn = $('editGenerateBtn');
    const clearBtn = $('editClearBtn');
    const selectAllBtn = $('editSelectAll');
    const deleteSelectedBtn = $('editDeleteSelected');
    const rotateSelectedBtn = $('editRotateSelected');
    const clearSplitsBtn = $('editClearSplits');
    const statusMsg = $('editStatusMsg');
    const progressWrap = $('editProgressWrap');
    const progressBar = $('editProgressBar');
    const extractSelectedBtn = $('editExtractSelected');
    const filenameInput = $('editFilenameInput');
    const filenameBar = $('editFilenameBar');
    const filenameClear = $('editFilenameClear');
    const autoCompressBtn = $('editAutoCompress');
    // Wire auto-compress toggle
    if (autoCompressBtn) {
      autoCompressBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        autoCompressBtn.classList.toggle('active');
      });
    }

    function setStatus(text, type) {
      if (statusMsg) {
        statusMsg.textContent = text;
        statusMsg.className = 'img-status-msg' + (type ? ' ' + type : '');
      }
      // ミラー: アクションバー中央 (常時見える位置)
      const abs = document.getElementById('editActionBarStatus');
      if (abs) {
        abs.textContent = text || '';
        abs.classList.toggle('visible', !!text);
        abs.classList.toggle('error', type === 'error');
        abs.classList.toggle('success', type === 'success' || type === 'done');
      }
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    ['dragenter','dragover'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave','drop'].forEach(e => {
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
      sources = [];
      pages = [];
      splits.clear();
      setStatus('');
      render();
    });
    generateBtn.addEventListener('click', generateOutput);

    selectAllBtn.addEventListener('click', () => {
      const allSelected = pages.length > 0 && pages.every(p => p.selected);
      pages.forEach(p => p.selected = !allSelected);
      render();
    });
    deleteSelectedBtn.addEventListener('click', () => {
      const before = pages.length;
      const oldSplits = new Set(splits);
      const keep = pages.map((p, i) => ({ p, keep: !p.selected, oldIdx: i }));
      const kept = keep.filter(x => x.keep);
      const newSplits = new Set();
      for (let i = 0; i < kept.length - 1; i++) {
        const oldIdx = kept[i].oldIdx;
        if (oldSplits.has(oldIdx)) newSplits.add(i);
      }
      pages = kept.map(x => x.p);
      splits = newSplits;
      if (pages.length < before) setStatus(`${before - pages.length}ページ削除`, 'success');
      render();
    });
    rotateSelectedBtn.addEventListener('click', () => {
      const selected = pages.filter(p => p.selected);
      if (selected.length === 0) return;
      selected.forEach(p => { p.rotation = (p.rotation + 90) % 360; });
      render();
    });
    clearSplitsBtn.addEventListener('click', () => {
      splits.clear();
      setStatus('分割ポイントを解除', 'info');
      render();
    });

    extractSelectedBtn.addEventListener('click', async () => {
      const selected = pages.filter(p => p.selected);
      if (selected.length === 0) return;
      await generateOutput({ onlySelected: true });
    });

    // Filename input: live-sanitize and toggle clear button
    filenameInput.addEventListener('input', () => {
      const v = filenameInput.value;
      // Strip dangerous characters as you type
      const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
      if (v !== cleaned) filenameInput.value = cleaned;
      filenameClear.classList.toggle('visible', !!filenameInput.value);
    });
    filenameClear.addEventListener('click', () => {
      filenameInput.value = '';
      filenameClear.classList.remove('visible');
      filenameInput.focus();
    });

    async function addFiles(fileList) {
      const arr = [...fileList].filter(f =>
        f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      if (arr.length === 0) {
        setStatus('⚠ PDFファイルのみ対応しています', 'error');
        return;
      }
      setStatus('');
      let loaded = 0;
      const total = arr.length;
      const failedNames = [];   // 読込失敗を覚えて最後にまとめて表示(直後の setStatus('') で消さない)
      for (const file of arr) {
        try {
          setStatus(`PDF読込中... (${loaded+1}/${total}) ${file.name}`, 'info');
          await addPdf(file);
        } catch (err) {
          console.error('PDF load failed:', file.name, err);
          failedNames.push(file.name + (String(err && err.message).indexOf('PROTECTED_PDF') >= 0 ? '(保護付きPDFのため編集不可)' : ''));
        }
        loaded++;
      }
      // 失敗があれば消えないまとめ表示。このまま生成するとその分は入らない事も明示(無言欠落防止)
      setStatus(failedNames.length ? `⚠ ${failedNames.length}件を読み込めませんでした: ${failedNames.join(' / ')} — このまま生成すると、その分は含まれません` : '');
      render();
      // ドロップ後、結果が見える位置へ自動スクロール
      requestAnimationFrame(() => {
        if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    async function addPdf(file) {
      const buffer = await file.arrayBuffer();
      const pdfJsBuf = buffer.slice(0);
      const pdfDoc = await pdfjsLib.getDocument({ data: pdfJsBuf }).promise;
      // 保護付き(オーナーパスワード/編集制限)PDF は読込時点で弾く。
      // pdf-lib 1.17.1 は復号できないため、ignoreEncryption:true で強行すると
      // 「成功」表示のまま中身の壊れたPDFを出力してしまう(プレビューは pdf.js が
      // 透過復号するので正常に見え、提出後に発覚する最悪パターン)。
      // getPermissions() は暗号化なしなら null、保護付きなら権限配列を返す。
      let _perms = null;
      try { _perms = await pdfDoc.getPermissions(); } catch (_e) { /* 判定不能は通す(誤遮断防止) */ }
      if (_perms !== null) throw new Error('PROTECTED_PDF');
      // しおり(目次)の有無を記録 — 複数PDF結合 (copyPages) ではしおりが引き継がれないため、生成時の通知に使う。
      // getOutline() はしおり無しなら null、有りなら配列を返す (pdf.js)
      let _outline = null;
      try { _outline = await pdfDoc.getOutline(); } catch (_e) { /* 取得失敗は「しおり無し」扱い(誤通知防止) */ }
      const sourceId = 'src_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      sources.push({ id: sourceId, name: file.name, buffer: buffer, hasOutline: !!(_outline && _outline.length > 0) });

      const numPages = pdfDoc.numPages;
      for (let p = 1; p <= numPages; p++) {
        setStatus(`サムネ生成中... ${file.name} ${p}/${numPages}`, 'info');
        await new Promise(r => setTimeout(r, 0));
        const page = await pdfDoc.getPage(p);
        const native = page.getViewport({ scale: 1 });
        const maxDim = 240;
        const scale = Math.min(maxDim / native.width, maxDim / native.height, 1.5);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const thumbUrl = canvas.toDataURL('image/jpeg', 0.75);
        canvas.width = 0; canvas.height = 0;

        pages.push({
          id: sourceId + '_p' + p,
          sourceId: sourceId,
          sourcePageIndex: p - 1,
          rotation: 0,
          thumbUrl: thumbUrl,
          sourceName: file.name,
          selected: false
        });
      }
    }

    function render() {
      if (pages.length === 0) {
        listPanel.style.display = 'none';
        actionBar.style.display = 'none';
        filenameBar.style.display = 'none';
        pageGrid.innerHTML = '';
        totalStats.textContent = '0 ページ';
        return;
      }

      listPanel.style.display = 'block';
      actionBar.style.display = 'flex';
      filenameBar.style.display = 'flex';

      const selectedCount = pages.filter(p => p.selected).length;
      const splitCount = splits.size;
      const outputCount = splitCount + 1;
      let statsHtml = `<strong style="color:white;">${pages.length}</strong> ページ`;
      if (selectedCount > 0) statsHtml += ` · <span style="color:#6b8eff;">${selectedCount}選択中</span>`;
      if (splitCount > 0) statsHtml += ` · ${outputCount}個のPDFに分割`;
      totalStats.innerHTML = statsHtml;

      // Auto-compress toggle: only relevant when splitting (causes size explosion)
      if (autoCompressBtn) {
        autoCompressBtn.style.display = splitCount > 0 ? 'inline-flex' : 'none';
      }

      deleteSelectedBtn.disabled = selectedCount === 0;
      rotateSelectedBtn.disabled = selectedCount === 0;
      extractSelectedBtn.disabled = selectedCount === 0;
      clearSplitsBtn.disabled = splitCount === 0;

      const htmlParts = [];

      pages.forEach((p, i) => {
        const rotStyle = p.rotation ? `style="transform: rotate(${p.rotation}deg);"` : '';
        const srcBadge = `<div class="edit-page-src-badge" title="${escapeHtml(p.sourceName)}">${escapeHtml(p.sourceName)} p.${p.sourcePageIndex + 1}</div>`;
        const rotBadge = p.rotation ? `<span class="edit-split-info" style="margin-left:auto;">${p.rotation}°</span>` : '';
        const isSplitAfter = i < pages.length - 1 && splits.has(i);
        const splitChipCls = isSplitAfter ? 'edit-split-chip active' : 'edit-split-chip';

        const card = `
          <div class="edit-page-card${p.selected ? ' selected' : ''}" draggable="true" data-idx="${i}">
            ${srcBadge}
            <button class="edit-page-checkbox" data-toggle-select="${i}" type="button" title="${p.selected ? 'このページを選択解除' : 'このページを選択'}" aria-label="選択"></button>
            <div class="edit-page-actions">
              <button class="edit-page-action-btn rotate" data-rotate="${i}" title="90°回転" aria-label="回転">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
              </button>
              <button class="edit-page-action-btn remove" data-remove="${i}" title="削除" aria-label="削除">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div class="edit-page-thumb-wrap">
              <img class="edit-page-thumb" src="${p.thumbUrl}" ${rotStyle} alt="page">
            </div>
            <div class="edit-page-meta">
              <span class="edit-page-num">${i + 1}</span>
              <span class="edit-page-src-label" title="${escapeHtml(p.sourceName)}">${escapeHtml(p.sourceName)}</span>
              ${rotBadge}
            </div>
          </div>`;

        // Split chip on right edge (except last)
        let splitChip = '';
        if (i < pages.length - 1) {
          splitChip = `
            <button class="${splitChipCls}" data-split="${i}" type="button" title="${isSplitAfter ? 'ここで分割中 - クリックで解除' : 'ここで分割する'}" aria-label="分割ポイント">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6" cy="6" r="3"/>
                <circle cx="6" cy="18" r="3"/>
                <line x1="20" y1="4" x2="8.12" y2="15.88"/>
                <line x1="14.47" y1="14.48" x2="20" y2="20"/>
                <line x1="8.12" y1="8.12" x2="12" y2="12"/>
              </svg>
            </button>`;
        }

        htmlParts.push(`<div class="edit-page-slot">${card}${splitChip}</div>`);

        if (isSplitAfter) {
          let segNum = 2;
          for (let j = 0; j < i; j++) if (splits.has(j)) segNum++;
          htmlParts.push(`
            <div class="edit-segment-divider">
              <div class="edit-segment-divider-chip">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="6" cy="6" r="3"/>
                  <circle cx="6" cy="18" r="3"/>
                  <line x1="20" y1="4" x2="8.12" y2="15.88"/>
                  <line x1="14.47" y1="14.48" x2="20" y2="20"/>
                  <line x1="8.12" y1="8.12" x2="12" y2="12"/>
                </svg>
                PART ${segNum} START
              </div>
            </div>`);
        }
      });

      const html = htmlParts.join('');

      pageGrid.innerHTML = html;

      pageGrid.querySelectorAll('[data-rotate]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.rotate;
          pages[idx].rotation = (pages[idx].rotation + 90) % 360;
          render();
        });
      });
      pageGrid.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.remove;
          const oldSplits = new Set(splits);
          splits = new Set();
          oldSplits.forEach(s => {
            if (s < idx) splits.add(s);
            else if (s > idx) splits.add(s - 1);
          });
          pages.splice(idx, 1);
          render();
        });
      });
      pageGrid.querySelectorAll('[data-split]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.split;
          if (splits.has(idx)) splits.delete(idx);
          else splits.add(idx);
          render();
        });
      });
      pageGrid.querySelectorAll('[data-toggle-select]').forEach(cb => {
        cb.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +cb.dataset.toggleSelect;
          pages[idx].selected = !pages[idx].selected;
          render();
        });
      });

      pageGrid.querySelectorAll('.edit-page-card').forEach(card => {
        card.addEventListener('dragstart', ev => {
          dragIdx = +card.dataset.idx;
          card.classList.add('dragging');
          ev.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          dragIdx = null;
          pageGrid.querySelectorAll('.edit-page-card').forEach(c => c.classList.remove('dragover-card'));
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
            const item = pages.splice(dragIdx, 1)[0];
            pages.splice(toIdx, 0, item);
            // 並び替えると分割位置の意味が変わるため解除する。無言で消すと
            // 「3分割のつもりが1本の結合PDF」事故になるので、消した時だけ告知する
            const hadSplits = splits.size > 0;
            splits.clear();
            if (hadSplits) setStatus('並び替えたため、分割ポイント(✂)を解除しました。必要なら付け直してください', 'info');
            render();
          }
        });
      });
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 200);
    }

    async function generateOutput(opts) {
      opts = opts || {};
      const onlySelected = !!opts.onlySelected;
      const workingPages = onlySelected ? pages.filter(p => p.selected) : pages;
      if (workingPages.length === 0) return;
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      if (progressWrap) progressWrap.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      setStatus(onlySelected ? '選択ページを抽出中...' : 'PDFを組み立て中...', 'info');
      await new Promise(r => setTimeout(r, 50));
      let successFlag = false;

      try {
        const { PDFDocument, degrees } = PDFLib;

        // Only load sources that are referenced
        const neededSourceIds = new Set(workingPages.map(p => p.sourceId));
        const sourceDocsCache = {};
        for (const src of sources) {
          if (neededSourceIds.has(src.id)) {
            sourceDocsCache[src.id] = await PDFDocument.load(src.buffer, { ignoreEncryption: true });
          }
        }

        // Build segments: if onlySelected, no splitting (single output)
        const segments = [];
        if (onlySelected) {
          segments.push(workingPages);
        } else {
          let currentSeg = [];
          workingPages.forEach((p, i) => {
            currentSeg.push(p);
            if (splits.has(i)) {
              segments.push(currentSeg);
              currentSeg = [];
            }
          });
          if (currentSeg.length > 0) segments.push(currentSeg);
        }

        const outputBlobs = [];
        const totalWork = workingPages.length;
        let doneWork = 0;
        const debugSizes = [];

        // Check if all pages in all segments come from a single source PDF.
        // If so, we can use a much more efficient approach: clone the source and remove unused pages.
        // This lets pdf-lib's object tree properly prune dead resources on save.
        const allSourceIds = new Set();
        workingPages.forEach(p => allSourceIds.add(p.sourceId));
        const singleSource = allSourceIds.size === 1;
        // 複数ソース結合 (戦略B) では copyPages がしおり(目次)を引き継がない。
        // 元PDFのいずれかにしおりがある場合だけ、完了時に一言通知する (単一ソースのクローン方式では保持されるので出さない)
        const outlineLost = !singleSource && sources.some(src => allSourceIds.has(src.id) && src.hasOutline);

        for (let s = 0; s < segments.length; s++) {
          const seg = segments[s];
          setStatus(`セグメント ${s+1}/${segments.length} を組み立て中...`, 'info');
          await new Promise(r => setTimeout(r, 0));

          let outDoc;
          if (singleSource) {
            // STRATEGY A: Clone source, remove unused pages (best for pruning dead resources)
            const sourceId = [...allSourceIds][0];
            const src = sources.find(sr => sr.id === sourceId);
            // Load a fresh copy of the source document
            outDoc = await PDFDocument.load(src.buffer, { ignoreEncryption: true });

            // Determine which original page indices to keep, in what order
            const keepIndices = seg.map(p => p.sourcePageIndex);
            const numOrigPages = outDoc.getPageCount();

            // Remove pages not in the keep list (iterate from end to preserve indices)
            const keepSet = new Set(keepIndices);
            for (let i = numOrigPages - 1; i >= 0; i--) {
              if (!keepSet.has(i)) outDoc.removePage(i);
            }

            // Now outDoc has only the kept pages, but in original order.
            // We need to reorder to match seg order + apply rotations.
            // Build a map: originalIndex → current index in outDoc (after removal)
            const sortedKept = [...keepSet].sort((a, b) => a - b);
            const origToCurrent = new Map();
            sortedKept.forEach((origIdx, curIdx) => origToCurrent.set(origIdx, curIdx));

            // Get pages once, then reorder via movePage
            for (let targetIdx = 0; targetIdx < seg.length; targetIdx++) {
              const p = seg[targetIdx];
              const currentIdx = origToCurrent.get(p.sourcePageIndex);
              if (currentIdx === undefined) continue;
              // Apply rotation
              const page = outDoc.getPage(currentIdx);
              if (p.rotation) {
                const existing = page.getRotation().angle;
                page.setRotation(degrees((existing + p.rotation) % 360));
              }
            }
            // 並び順をユーザーの希望順に揃える。
            // 注意: pdf-lib 1.17.1 に movePage は存在しない(呼ぶと TypeError で生成が必ず失敗していた)。
            // removePage + insertPage の組で同じ「ページ移動」を行う(insertPage は同一文書の PDFPage を受け取れる)。
            const desiredOrder = seg.map(p => p.sourcePageIndex);
            // Only reorder if the current order differs from desired order
            const currentOrder = sortedKept.slice();
            if (desiredOrder.some((v, i) => v !== currentOrder[i])) {
              // outDoc のページは sortedKept 順で並んでいる → desiredOrder へ1枚ずつ移動
              const workingOrder = currentOrder.slice();
              for (let i = 0; i < desiredOrder.length; i++) {
                const want = desiredOrder[i];
                const curPos = workingOrder.indexOf(want);
                if (curPos !== i && curPos >= 0) {
                  const pg = outDoc.getPage(curPos);
                  outDoc.removePage(curPos);
                  outDoc.insertPage(i, pg);
                  // Update workingOrder to reflect move
                  const [moved] = workingOrder.splice(curPos, 1);
                  workingOrder.splice(i, 0, moved);
                }
              }
            }

            doneWork += seg.length;
            if (progressBar) progressBar.style.width = Math.round(doneWork / totalWork * 100) + '%';
          } else {
            // STRATEGY B: Multiple sources — use copyPages (may have some bloat from shared resources,
            // but this is the only way to combine pages from multiple PDFs)
            outDoc = await PDFDocument.create();
            const bySource = new Map();
            seg.forEach((p, localIdx) => {
              if (!bySource.has(p.sourceId)) bySource.set(p.sourceId, []);
              bySource.get(p.sourceId).push({ page: p, localIdx });
            });

            const copiedByLocalIdx = new Array(seg.length);
            for (const [sourceId, entries] of bySource) {
              const srcDoc = sourceDocsCache[sourceId];
              const indices = entries.map(e => e.page.sourcePageIndex);
              const copiedBatch = await outDoc.copyPages(srcDoc, indices);
              copiedBatch.forEach((cp, i) => {
                copiedByLocalIdx[entries[i].localIdx] = { page: entries[i].page, copied: cp };
              });
            }

            for (let i = 0; i < seg.length; i++) {
              const entry = copiedByLocalIdx[i];
              if (!entry) continue;
              const { page: p, copied } = entry;
              if (p.rotation) {
                const existing = copied.getRotation().angle;
                copied.setRotation(degrees((existing + p.rotation) % 360));
              }
              outDoc.addPage(copied);
              doneWork++;
              if (progressBar) progressBar.style.width = Math.round(doneWork / totalWork * 100) + '%';
            }
          }

          // Save with aggressive compression options
          const bytes = await outDoc.save({
            useObjectStreams: true,
            addDefaultPage: false,
            updateFieldAppearances: false
          });
          debugSizes.push(bytes.length);
          const blob = new Blob([bytes], { type: 'application/pdf' });
          outputBlobs.push(blob);
        }

        // Log for debugging (visible in browser console)
        const originalSize = Array.from(neededSourceIds).reduce((sum, id) => {
          const src = sources.find(s => s.id === id);
          return sum + (src ? src.buffer.byteLength : 0);
        }, 0);
        const totalOutSize = debugSizes.reduce((a, b) => a + b, 0);
        console.log(`[PDF Edit] 戦略: ${singleSource ? 'クローン+削除 (単一ソース)' : 'copyPages (複数ソース)'}`);
        console.log(`[PDF Edit] 元サイズ: ${(originalSize/1024/1024).toFixed(2)}MB → 出力合計: ${(totalOutSize/1024/1024).toFixed(2)}MB (${segments.length}分割)`);
        if (segments.length > 1) {
          console.log(`[PDF Edit] セグメント別サイズ:`, debugSizes.map(b => `${(b/1024/1024).toFixed(2)}MB`).join(', '));
        }

        // AUTO-COMPRESS: If splitting and toggle is on, apply photo-mode compression to each segment
        const autoCompressEnabled = outputBlobs.length > 1
          && autoCompressBtn
          && autoCompressBtn.classList.contains('active');
        let compressedInfo = null;
        if (autoCompressEnabled) {
          const beforeSize = totalOutSize;
          const compressedBlobs = [];
          const targetDpi = 150;      // balanced quality
          const jpegQuality = 0.72;   // balanced compression
          for (let i = 0; i < outputBlobs.length; i++) {
            setStatus(`分割${i+1}/${outputBlobs.length} を軽量化中...`, 'info');
            await new Promise(r => setTimeout(r, 0));
            try {
              const smallBlob = await compressPdfBlobPhotoMode(
                outputBlobs[i], targetDpi, jpegQuality,
                (pn, tot) => {
                  setStatus(`分割${i+1}/${outputBlobs.length} 軽量化中: ページ ${pn}/${tot}`, 'info');
                }
              );
              compressedBlobs.push(smallBlob);
            } catch (err) {
              console.warn(`[PDF Edit] 分割${i+1}の軽量化失敗、元データを使用:`, err);
              compressedBlobs.push(outputBlobs[i]);
            }
            if (progressBar) {
              const pct = Math.round((i + 1) / outputBlobs.length * 100);
              progressBar.style.width = pct + '%';
            }
          }
          const afterSize = compressedBlobs.reduce((a, b) => a + b.size, 0);
          compressedInfo = { beforeSize, afterSize };
          console.log(`[PDF Edit] 自動軽量化: ${(beforeSize/1024/1024).toFixed(2)}MB → ${(afterSize/1024/1024).toFixed(2)}MB`);
          // Replace outputBlobs
          outputBlobs.length = 0;
          outputBlobs.push(...compressedBlobs);
        }

        // v3.6.0: 出力前メタデータ除去 — 単一/ZIP/自動軽量化済みの全経路を一括カバー
        if (window.PdfSanitize) {
          for (let _i = 0; _i < outputBlobs.length; _i++) {
            outputBlobs[_i] = await window.PdfSanitize.process(outputBlobs[_i]);
          }
        }

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        const userName = (filenameInput.value || '').trim();

        if (outputBlobs.length === 1) {
          const blob = outputBlobs[0];
          const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
          const defaultPrefix = onlySelected ? 'extracted' : 'edited';
          let finalName;
          if (userName) {
            finalName = `${appendTimestamp(userName, 'editFilenameTs')}.pdf`;
          } else {
            finalName = `${defaultPrefix}_${ts}.pdf`;
          }
          triggerDownload(blob, finalName);
          setStatus(`✓ ${workingPages.length}ページ · ${sizeMB} MB · DL完了${outlineLost ? ' — ※しおり(目次)は結合では引き継がれません' : ''}`, 'success');
          showSuccess({
            title: onlySelected ? 'ページ抽出完了' : 'PDF編集完了',
            subtitle: outlineLost ? 'ダウンロードが始まりました ※しおり(目次)は結合では引き継がれません' : 'ダウンロードが始まりました',
            stats: [
              { label: '出力ページ', value: `${workingPages.length} ページ`, highlight: true },
              { label: 'ファイルサイズ', value: `${sizeMB} MB` },
              { label: 'ファイル名', value: finalName }
            ]
          });
          successFlag = true;
        } else {
          setStatus('ZIP作成中...', 'info');
          const zip = new JSZip();
          const tsSuffix = isTimestampEnabled('editFilenameTs') ? `_${makeTimestamp()}` : '';
          outputBlobs.forEach((b, i) => {
            const partBase = userName ? `${userName}_${i+1}` : `part${i+1}`;
            zip.file(`${partBase}${tsSuffix}.pdf`, b);
          });
          const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          const sizeMB = (zipBlob.size / (1024 * 1024)).toFixed(2);
          let zipName;
          if (userName) {
            zipName = `${appendTimestamp(userName, 'editFilenameTs')}.zip`;
          } else {
            zipName = `edited_split_${ts}.zip`;
          }
          triggerDownload(zipBlob, zipName);
          setStatus(`✓ ${outputBlobs.length}個のPDFに分割 · ZIP ${sizeMB} MB · DL完了${outlineLost ? ' — ※しおり(目次)は結合では引き継がれません' : ''}`, 'success');
          const editStats = [
            { label: '分割数', value: `${outputBlobs.length} 個`, highlight: true },
            { label: '総ページ', value: `${workingPages.length} ページ` },
            { label: 'ZIPサイズ', value: `${sizeMB} MB` }
          ];
          if (compressedInfo) {
            const reduction = Math.round((1 - compressedInfo.afterSize / compressedInfo.beforeSize) * 100);
            editStats.push({
              label: '軽量化',
              value: `-${reduction}%`,
              highlight: 'green'
            });
          }
          showSuccess({
            title: 'PDF分割完了',
            subtitle: (compressedInfo ? `${outputBlobs.length}個を軽量化してZIPでDL` : `${outputBlobs.length}個のPDFをZIPでDL`) + (outlineLost ? ' ※しおり(目次)は結合では引き継がれません' : ''),
            stats: editStats
          });
          successFlag = true;
        }
      } catch (err) {
        console.error(err);
        setStatus(`✕ エラー: ${err.message}`, 'error');
      }

      generateBtn.disabled = false;
      clearBtn.disabled = false;
      // PDF出力成功時のみ保持データを破棄 (sources/pages/splits まとめてリセット)
      if (successFlag) {
        sources = [];
        pages = [];
        splits.clear();
        render();
      }
      setTimeout(() => {
        if (progressWrap) progressWrap.classList.remove('active');
      }, 1500);
    }

    render();
  })();

  // =========================================================
  // IMG PLACE MODE (PDFに画像配置 - Phase 1 / 段階A: 基盤)
  // =========================================================
