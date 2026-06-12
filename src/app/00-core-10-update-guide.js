  function semverGt(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }
  // バージョンラベルを footer と トップブランドの両方に表示
  function showVersionLabel() {
    const labels = ['appVersionLabel', 'appVersionTopLabel'];
    for (const id of labels) {
      const el = document.getElementById(id);
      if (el) el.textContent = 'v' + APP_VERSION;
    }
  }
  // blob 経由ダウンロード (URL をアドレスバーに出さない)
  async function downloadUpdate(url, dlBtn) {
    if (!url) return;
    const origLabel = dlBtn ? dlBtn.textContent : '';
    try {
      if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = 'DL中...'; }
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'pdf_compact_bundle.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
      if (dlBtn) dlBtn.textContent = 'DL完了 ✓';
    } catch (e) {
      alert('ダウンロード失敗: ' + (e.message || e) + '\nオフラインや設定不備の可能性あり');
      if (dlBtn) dlBtn.textContent = origLabel || 'DL';
    } finally {
      if (dlBtn) dlBtn.disabled = false;
    }
  }
  // バナー表示
  function showUpdateBanner(manifest) {
    const banner = document.getElementById('updateBanner');
    if (!banner) return;
    const versionLabel = document.getElementById('updateVersionLabel');
    const notes = document.getElementById('updateNotes');
    const dlBtn = document.getElementById('updateDlBtn');
    const closeBtn = document.getElementById('updateCloseBtn');
    if (versionLabel) versionLabel.textContent = manifest.version;
    if (notes) {
      notes.textContent = '';
      notes.classList.remove('scrolling');
      notes.style.removeProperty('--un-shift');
      notes.style.removeProperty('--un-dur');
      var _inner = document.createElement('span');
      _inner.className = 'un-inner';
      _inner.textContent = manifest.notes || '';
      notes.appendChild(_inner);
      // レイアウト確定後に溢れ量を測り、溢れてたらゆっくり往復スクロール
      requestAnimationFrame(function(){
        var ov = _inner.scrollHeight - notes.clientHeight;
        if (ov > 4) {
          notes.style.setProperty('--un-shift', (-ov) + 'px');
          notes.style.setProperty('--un-dur', Math.max(7, Math.round(ov / 10) + 6) + 's');
          notes.classList.add('scrolling');
        }
      });
    }
    if (dlBtn) {
      dlBtn.onclick = () => {
        downloadUpdate(_downloadUrl(manifest), dlBtn);
      };
    }
    if (closeBtn) {
      closeBtn.onclick = () => {
        banner.style.display = 'none';
        try { localStorage.setItem('pdfCompactUpdateDismissed', manifest.version); } catch (_e) {}
      };
    }
    banner.style.display = '';
  }
  // 起動時チェック (オフライン/未設定なら静かに何もしない)
  async function checkForUpdate() {
    const url = _manifestUrl();
    if (!url) return;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = await res.json();
      if (!manifest || typeof manifest.version !== 'string') return;
      if (!semverGt(manifest.version, APP_VERSION)) return;
      // 同じバージョンを既に閉じてたら再通知しない
      let dismissed = '';
      try { dismissed = localStorage.getItem('pdfCompactUpdateDismissed') || ''; } catch (_e) {}
      if (dismissed === manifest.version) return;
      showUpdateBanner(manifest);
    } catch (e) {
      // ネットワークエラー / CORS / 無効JSON はオフライン扱いで黙殺
      console.debug('[updateCheck] skipped:', e && e.message);
    }
  }
  // 取説を起動時に自動でドック表示 (ユーザー要件)
  // × で閉じたら sessionStorage に記録、当セッション内は再表示しない
  const GUIDE_AUTO_OPEN_DISMISS_KEY = 'pdfCompact.guideAutoOpenDismissed';
  function autoOpenGuide() {
    // スマホでは自動表示しない (全画面モーダルが立ち上がってツール触れない問題回避)
    // ユーザーが「使い方」ボタン押下した時のみ全画面表示する
    // iPad portrait (768px) はドック可能なので自動表示する
    if (window.innerWidth < 700) return;
    try {
      // 当セッションで × を押されてたらスキップ
      if (sessionStorage.getItem(GUIDE_AUTO_OPEN_DISMISS_KEY) === '1') return;
    } catch(_) {}
    // 既に開いてる場合はスキップ (二重起動防止)
    const modal = document.getElementById('guideModal');
    if (modal && modal.classList.contains('open')) return;
    if (typeof window.openGuide === 'function') {
      try { window.openGuide(); } catch(e) { console.debug('autoOpenGuide failed:', e); }
    }
  }
  // DOMContentLoaded 後にバージョンラベル表示 + 2秒遅延でチェック + 取説自動表示
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      showVersionLabel();
      setTimeout(checkForUpdate, 2000);
      // ページレンダリング完了後に取説オープン (少し遅らせて他の init を邪魔しない)
      setTimeout(autoOpenGuide, 100);
      setTimeout(initSettingsHint, 800);
    });
  } else {
    showVersionLabel();
    setTimeout(checkForUpdate, 2000);
    setTimeout(autoOpenGuide, 100);
    setTimeout(initSettingsHint, 800);
  }

  // Defensive: wrap in try so a missing library doesn't block function declarations below
  try {
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  } catch (e) { console.warn('pdf.js worker setup failed:', e); }

  // ===== Guide modal =====
  function openGuide() {
    const modal = document.getElementById('guideModal');
    const iframe = document.getElementById('guideFrame');
    const srcEl = document.getElementById('guideSource');
    if (!modal || !iframe || !srcEl) {
      console.error('Guide elements missing', { modal: !!modal, iframe: !!iframe, srcEl: !!srcEl });
      alert('取説の読み込みに失敗しました。ページを再読み込みしてください。');
      return;
    }
    const src = srcEl.textContent || srcEl.innerHTML || '';
    if (!src || src.length < 100) {
      console.error('Guide source empty or too short:', src.length);
      alert('取説の内容が空です。ページを再読み込みしてください。');
      return;
    }

    // Show modal first
    modal.classList.add('open');
    // 常にドック表示で開く (ユーザー要件: 「開いたら右に出す、不要なら×で閉じる」)
    // 過去の docked 状態は記憶しない (= 全画面切替は当セッションのみ有効)
    setGuideDocked(true, false);

    // Install anchor-click interceptor inside the iframe doc.
    // This prevents hash links from navigating (which triggers the Claude
    // artifact viewer's "loading" error) and scrolls manually instead.
    function installAnchorHandler() {
      try {
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (!doc || doc.__anchorHandlerInstalled) return;
        doc.__anchorHandlerInstalled = true;
        // ガイド側の topnav-cta 「ツールを開く」を非表示 (親側の × ボタンと役割重複するため)
        // 親 JS で style 注入 (ガイド HTML 内に script 入れると外側の <script type="text/html"> が早期終了する)
        try {
          const hideStyle = doc.createElement('style');
          hideStyle.textContent = '.topnav-cta { display: none !important; }';
          (doc.head || doc.documentElement).appendChild(hideStyle);
        } catch (e2) { /* ignore */ }
        // 現在の active タブに合わせて該当セクションへスクロール
        // (iframe load 中にタブ切替された場合に備えて、ここで再取得する)
        const _currentTab = document.querySelector('.mode-tab.active');
        const _currentMode = _currentTab ? _currentTab.dataset.mode : null;
        if (_currentMode && typeof scrollGuideToSection === 'function') {
          try { scrollGuideToSection(_currentMode, 'auto'); } catch(_) {}
        }
        doc.addEventListener('click', function(e) {
          let el = e.target;
          // Walk up to find an anchor with href
          while (el && el !== doc.body && el.tagName !== 'A') {
            el = el.parentNode;
          }
          if (!el || el.tagName !== 'A') return;
          const href = el.getAttribute('href');
          if (!href || href.charAt(0) !== '#') return;
          e.preventDefault();
          const id = href.slice(1);
          if (!id) {
            // href="#" → scroll to top
            (doc.documentElement || doc.body).scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }
          const target = doc.getElementById(id);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, true);
      } catch (e) {
        console.warn('Anchor handler install failed:', e);
      }
    }

    // onload fires for srcdoc and data URL paths
    iframe.onload = installAnchorHandler;

    // Write content into iframe — try multiple methods for max compatibility
    let written = false;
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        doc.open();
        doc.write(src);
        doc.close();
        written = true;
        // doc.write doesn't always fire iframe.onload → install synchronously
        installAnchorHandler();
      }
    } catch (e) {
      console.warn('iframe.contentDocument.write failed:', e);
    }

    // Fallback: srcdoc attribute
    if (!written) {
      try {
        iframe.srcdoc = src;
        written = true;
      } catch (e) {
        console.warn('iframe.srcdoc failed:', e);
      }
    }

    // Last resort: data URL (works everywhere but URL-encodes)
    if (!written) {
      try {
        iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(src);
      } catch (e) {
        console.error('All iframe load methods failed:', e);
        alert('取説の表示に失敗しました。ブラウザを変更してお試しください。');
      }
    }
  }
  function closeGuide() {
    const modal = document.getElementById('guideModal');
    const iframe = document.getElementById('guideFrame');
    if (modal) {
      modal.classList.remove('open');
      // docked 状態も解除 (html の padding-right も外す)
      modal.classList.remove('docked');
      document.body.classList.remove('guide-docked');
      document.documentElement.style.removeProperty('padding-right');
      document.body.style.overflow = '';
    }
    // × で閉じた場合、当セッションは自動表示しない (リロードまでは再オープンしない)
    try { sessionStorage.setItem(GUIDE_AUTO_OPEN_DISMISS_KEY, '1'); } catch(_) {}
    setTimeout(() => {
      if (iframe) {
        // Clear all possible content sources
        try { iframe.srcdoc = ''; } catch(e) {}
        try { iframe.removeAttribute('srcdoc'); } catch(e) {}
        try { iframe.src = 'about:blank'; } catch(e) {}
      }
    }, 320);
  }
  // ===== 取説のドック切替 (右側ピン留め ⇔ 全画面モーダル) =====
  const GUIDE_DOCK_KEY = 'pdfCompact.guideDocked.v2'; // v3.3.2: 旧キーが auto-save で汚染されてたので刷新
  const GUIDE_DOCK_W_KEY = 'pdfCompact.guideDockWidth';
  const GUIDE_DOCK_MIN = 320;
  // スマホ・狭画面ではドック禁止 (ドック幅 > viewport で tool が完全に隠れる)
  // iPad portrait (768px) はギリギリ通すため 700px 閾値
  const GUIDE_DOCK_MIN_VIEWPORT = 700;
  function isMobileViewport() {
    return window.innerWidth < GUIDE_DOCK_MIN_VIEWPORT;
  }
  // viewport 適応のデフォルトドック幅 (iPad portrait 768 → 345px, iPad landscape 1024 → 460px, PC → 480px)
  function getGuideDockDefault() {
    return Math.min(480, Math.max(GUIDE_DOCK_MIN, Math.floor(window.innerWidth * 0.45)));
  }
  // 旧キー (v3.3.0/3.3.1) を削除 (新規ユーザーは影響なし、旧ユーザーはリセット)
  try { localStorage.removeItem('pdfCompact.guideDocked'); } catch(e) {}
  function getGuideDockMax() {
    // 画面幅の 70% を上限 (ツール側が狭くなりすぎないように)
    return Math.max(GUIDE_DOCK_MIN + 100, Math.floor(window.innerWidth * 0.7));
  }
  function applyGuideDockWidth(px) {
    const clamped = Math.max(GUIDE_DOCK_MIN, Math.min(getGuideDockMax(), px));
    document.documentElement.style.setProperty('--guide-dock-w', clamped + 'px');
    // padding-right は html 要素に inline で設定 (body だと Chrome の何かに弾かれて効かない)
    if (document.body.classList.contains('guide-docked')) {
      document.documentElement.style.setProperty('padding-right', clamped + 'px', 'important');
    }
    try { localStorage.setItem(GUIDE_DOCK_W_KEY, String(clamped)); } catch(e) {}
    return clamped;
  }
  // persist=true なら設定保存 (ユーザー操作)、false なら表示変更のみ (openGuide からの自動適用)
  function setGuideDocked(docked, persist) {
    if (persist === undefined) persist = true;
    const modal = document.getElementById('guideModal');
    if (!modal) return;
    // スマホ・狭画面では強制的に全画面モーダル化 (docked を許可するとツール側が完全に隠れる)
    if (docked && isMobileViewport()) {
      docked = false;
    }
    const btn = document.getElementById('guideDockBtn');
    if (docked) {
      modal.classList.add('docked');
      document.body.classList.add('guide-docked');
      // body の overflow を戻す (docked なら下のツール操作できる必要あり)
      document.body.style.overflow = '';
      if (btn) btn.title = '全画面表示に戻す';
      // 保存された幅を適用 (この中で body の padding-right も inline 設定される)
      let saved = parseInt(localStorage.getItem(GUIDE_DOCK_W_KEY) || '0', 10);
      if (!saved || isNaN(saved)) saved = getGuideDockDefault();
      applyGuideDockWidth(saved);
      if (persist) { try { localStorage.setItem(GUIDE_DOCK_KEY, '1'); } catch(e) {} }
    } else {
      modal.classList.remove('docked');
      document.body.classList.remove('guide-docked');
      // html の inline padding-right を解除 (CSS のデフォルトに戻す)
      document.documentElement.style.removeProperty('padding-right');
      // モーダル開いてる時のみ overflow hidden に戻す
      if (modal.classList.contains('open')) {
        document.body.style.overflow = 'hidden';
      }
      if (btn) btn.title = '右側にドッキング (ツールと並べて表示)';
      if (persist) { try { localStorage.setItem(GUIDE_DOCK_KEY, '0'); } catch(e) {} }
    }
  }
  function toggleGuideDock() {
    const modal = document.getElementById('guideModal');
    if (!modal) return;
    setGuideDocked(!modal.classList.contains('docked'), true);
  }

  // スプリッターのドラッグでドック幅をリアルタイム調整
  (function initGuideDockSplitter() {
    const start = () => {
      const splitter = document.getElementById('guideDockSplitter');
      if (!splitter) return;
      let dragging = false;
      const onDown = (e) => {
        dragging = true;
        splitter.classList.add('dragging');
        document.body.classList.add('guide-dock-resizing');
        try { splitter.setPointerCapture(e.pointerId); } catch(_) {}
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        // パネルは右端固定 → 幅 = viewport幅 - クリックX
        const newW = window.innerWidth - e.clientX;
        applyGuideDockWidth(newW);
      };
      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('guide-dock-resizing');
        try { splitter.releasePointerCapture(e.pointerId); } catch(_) {}
      };
      splitter.addEventListener('pointerdown', onDown);
      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
      splitter.addEventListener('pointercancel', onUp);
      // setPointerCapture が失敗するブラウザ用フォールバック:
      // ポインタが iframe 上に逃げて離されても確実に dragging を解除
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();

  // 起動時: 保存された ドック幅を CSS var に反映 (即用意しないと初回ガクッと動く)
  (function restoreGuideDockWidth() {
    let saved = parseInt(localStorage.getItem(GUIDE_DOCK_W_KEY) || '0', 10);
    if (!saved || isNaN(saved)) saved = getGuideDockDefault();
    // 大画面で保存 → 小画面で起動した時、視窗の 70% を超えないよう clamp
    const clamped = Math.max(GUIDE_DOCK_MIN, Math.min(getGuideDockMax(), saved));
    document.documentElement.style.setProperty('--guide-dock-w', clamped + 'px');
  })();

  // ウィンドウリサイズ時にドック幅を再 clamp (ブラウザ縮めた時のはみ出し防止)
  // モバイル幅に縮んだ時はドックを強制解除して全画面モーダル化
  window.addEventListener('resize', () => {
    if (!document.body.classList.contains('guide-docked')) return;
    // モバイル幅になったらドック解除 (ツール側が完全に隠れるのを防ぐ)
    if (isMobileViewport()) {
      setGuideDocked(false, false);
      return;
    }
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--guide-dock-w'), 10) || getGuideDockDefault();
    applyGuideDockWidth(cur);
  });
  window.addEventListener('message', (e) => {
    if (e.data === 'closeGuide') closeGuide();
  });
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('guideModal');
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeGuide();
    }
  });
  document.getElementById('guideModal').addEventListener('click', (e) => {
    if (e.target.id === 'guideModal') closeGuide();
  });

  // ===== Success celebration modal =====
  let successAutoCloseTimer = null;
