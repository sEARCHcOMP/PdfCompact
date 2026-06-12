  function makeTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }
  function isTimestampEnabled(toggleId) {
    const el = document.getElementById(toggleId);
    return !!(el && el.classList.contains('active'));
  }
  function appendTimestamp(baseName, toggleId) {
    if (!isTimestampEnabled(toggleId)) return baseName;
    return `${baseName}_${makeTimestamp()}`;
  }
  function setupTimestampToggle(toggleId, previewId) {
    const btn = document.getElementById(toggleId);
    const preview = document.getElementById(previewId);
    if (!btn) return;
    function updatePreview() {
      if (!preview) return;
      preview.textContent = btn.classList.contains('active') ? `_${makeTimestamp()}` : '';
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      btn.classList.toggle('active');
      updatePreview();
    });
    // Refresh preview every minute while visible so it stays accurate
    setInterval(() => { if (btn.offsetParent !== null) updatePreview(); }, 30000);
    updatePreview();
  }
  // Set up all 4 timestamp toggles once DOM is ready
  setupTimestampToggle('compressFilenameTs', 'compressFilenameTsPreview');
  setupTimestampToggle('imgFilenameTs', 'imgFilenameTsPreview');
  setupTimestampToggle('convFilenameTs', 'convFilenameTsPreview');
  setupTimestampToggle('editFilenameTs', 'editFilenameTsPreview');

  // =========================================================
  // MODE TAB SWITCHING
  // =========================================================
  function restartWarpAnimations(panel) {
    if (!panel) return;
    // Find every brand-mark / dropzone-icon inside the panel and force animation restart
    const iconEls = panel.querySelectorAll('.brand-mark, .dropzone-icon');
    iconEls.forEach(el => {
      // Disable animation temporarily
      el.style.animation = 'none';
      // Reset SVG line-draw animations too
      el.querySelectorAll('svg > *').forEach(child => {
        child.style.animation = 'none';
      });
      // Force browser to flush styles (reflow)
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight;
      // Re-enable — CSS animation rule kicks back in from scratch
      requestAnimationFrame(() => {
        el.style.animation = '';
        el.querySelectorAll('svg > *').forEach(child => {
          child.style.animation = '';
        });
      });
    });
  }

  // モード(data-mode) → ガイド側セクション ID マッピング
  const GUIDE_SECTION_MAP = {
    compress: 'part-compress',
    imgtopdf: 'part-imgtopdf',
    convert: 'part-convert',
    pdfedit: 'part-edit',
    imgplace: 'part-imgplace'
  };
  // 取説 iframe を該当セクションまでスクロール (ドック表示中の時のみ意味あり)
  // behavior: 'smooth' (タブ切替時のアニメ) or 'auto' (再表示時の瞬間移動)
  function scrollGuideToSection(mode, behavior) {
    const sectionId = GUIDE_SECTION_MAP[mode];
    if (!sectionId) return;
    // ガイドが開いてない時は早期 return (毎タブ切替で iframe 触らない)
    const modal = document.getElementById('guideModal');
    if (!modal || !modal.classList.contains('open')) return;
    const iframe = document.getElementById('guideFrame');
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (!doc) return;
      const target = doc.getElementById(sectionId);
      if (target) target.scrollIntoView({ behavior: behavior || 'smooth', block: 'start' });
    } catch (e) { /* CORS 等で読めない場合は黙殺 */ }
  }

  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.mode;
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.mode-panel').forEach(p => p.classList.remove('active'));
      const panelIdMap = {
        compress: 'modeCompress',
        imgtopdf: 'modeImgToPdf',
        convert: 'modeConvert',
        pdfedit: 'modePdfEdit',
        imgplace: 'modeImgPlace',
        redact: 'modeRedact'
      };
      const targetId = panelIdMap[target] || 'modeCompress';
      const targetPanel = document.getElementById(targetId);
      targetPanel.classList.add('active');
      // Retrigger the warp-in animation on newly-active panel's icons
      restartWarpAnimations(targetPanel);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // 取説ドックが開いてたら該当セクションへスクロール
      scrollGuideToSection(target);
    });
  });

  // =========================================================
  // IMAGE → PDF TOOL (isolated scope)
  // =========================================================
