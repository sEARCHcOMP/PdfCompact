  /* ===== 設定モーダル wiring (success-modal と同じ開閉作法) ===== */
  var PDFC_SETTINGS_KEY = 'pdfc_settings_v1';
  var PDFC_SETTINGS_DEFAULTS = {
    stripMetadata: true,      // rank1: 出力PDFのメタデータを消す (既定ON)
    watermark: false,         // rank2 (v3.7.0): 透かし ON/OFF (既定OFF / opt-in)
    watermarkText: '社外秘'   // rank2: 焼く文言 (既定はプリセット先頭)
  };
  var pdfcSettings = (function loadPdfcSettings() {
    var s = {};
    for (var k in PDFC_SETTINGS_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(PDFC_SETTINGS_DEFAULTS, k)) s[k] = PDFC_SETTINGS_DEFAULTS[k];
    }
    try {
      var raw = localStorage.getItem(PDFC_SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (var key in s) {
            if (Object.prototype.hasOwnProperty.call(parsed, key)) s[key] = parsed[key];
          }
        }
      }
    } catch (e) { console.debug('pdfc settings load failed, using defaults:', e); }
    return s;
  })();
  function savePdfcSettings() {
    try { localStorage.setItem(PDFC_SETTINGS_KEY, JSON.stringify(pdfcSettings)); }
    catch (e) { console.warn('pdfc settings save failed:', e); }
  }
  /* M13対策: 別タブでの設定変更を反映する。storage イベントは「他タブが書いた時」
     だけ発火する(自タブの savePdfcSettings では発火しない)。これが無いと各タブが
     起動時スナップショットを抱え続け、古いタブの全量上書き保存で設定が無言で巻き戻る。 */
  function reloadPdfcSettingsFromStorage() {
    try {
      var raw = localStorage.getItem(PDFC_SETTINGS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      for (var k in PDFC_SETTINGS_DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(PDFC_SETTINGS_DEFAULTS, k)) continue;
        pdfcSettings[k] = (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, k))
          ? parsed[k] : PDFC_SETTINGS_DEFAULTS[k];
      }
    } catch (e) { console.debug('pdfc settings reload failed:', e); }
  }
  window.addEventListener('storage', function (e) {
    if (e.key !== null && e.key !== PDFC_SETTINGS_KEY) return;   // key=null は clear() による全消し
    reloadPdfcSettingsFromStorage();
    // 設定モーダルを開いていたらトグル・チップ・プレビュー表示も即同期する
    var modal = document.getElementById('settingsModal');
    if (modal && modal.classList.contains('open')) syncSettingsUiFromState();
  });
  /* グローバル公開: 各モードIIFE / window.PdfSanitize から設定を読む唯一の窓口 */
  window.PdfSanitizeSettings = {
    get: function (key) { return pdfcSettings[key]; },
    all: function () { var c = {}; for (var k in pdfcSettings) c[k] = pdfcSettings[k]; return c; },
    metadataEnabled: function () { return pdfcSettings.stripMetadata !== false; },
    watermarkEnabled: function () { return pdfcSettings.watermark === true; },
    watermarkText: function () {
      var t = (pdfcSettings.watermarkText || '').trim();
      return t || '社外秘';   // 空保存でも helper 側がコケない保険
    }
  };
  /* 透かしプリセット定義 (HTML のチップ value と一致させる) */
  var WM_PRESETS = ['社外秘', '複製禁止', 'DRAFT'];

  /* 絵文字(サロゲートペア=U+10000以上)は透かしフォント(NotoSansJP)にグリフが無く、
     プレビューでは見えても出力PDFで欠落する。UI側の保存/プレビュー経路で除去する (M14) */
  function wmStripUnsupported(t) {
    return String(t == null ? '' : t).replace(/[\u{10000}-\u{10FFFF}]/gu, '');
  }
  /* 除去が起きた時だけ入力欄下の注記を表示する */
  function wmShowEmojiNote(show) {
    var note = document.getElementById('setWatermarkEmojiNote');
    if (note) note.hidden = !show;
  }

  /* いま焼かれる実効テキスト (カスタム選択中はテキスト欄の値) */
  function wmEffectiveText() {
    var customChecked = document.querySelector('.wm-chip-input[data-custom]:checked');
    if (customChecked) {
      var inp = document.getElementById('setWatermarkText');
      return inp ? wmStripUnsupported(inp.value).trim() : '';
    }
    var presetChecked = document.querySelector('.wm-chip-input[data-preset]:checked');
    return presetChecked ? presetChecked.value : '';
  }

  /* プレビュー更新: 空なら警告表示に切替 */
  function wmRenderPreview() {
    var box = document.getElementById('setWatermarkPreview');
    var sample = document.getElementById('setWatermarkPreviewSample');
    if (!box || !sample) return;
    var customChecked = document.querySelector('.wm-chip-input[data-custom]:checked');
    var txt = wmEffectiveText();
    if (!txt) {
      box.classList.add('is-empty');
      sample.textContent = customChecked ? '文字を入れてください' : '—';
    } else {
      box.classList.remove('is-empty');
      sample.textContent = txt;
    }
  }

  /* state(watermarkText) → UI。開くたび正しいチップを選び直す */
  function syncWatermarkUi() {
    var on   = document.getElementById('setWatermark');
    var wrap = document.getElementById('setWatermarkTextWrap');
    var customWrap = document.getElementById('setWatermarkCustomWrap');
    var inp  = document.getElementById('setWatermarkText');
    if (!on || !wrap) return;

    var enabled = (pdfcSettings.watermark === true);
    on.checked = enabled;
    wrap.hidden = !enabled;

    var saved = (pdfcSettings.watermarkText || '').trim();
    var isPreset = WM_PRESETS.indexOf(saved) !== -1;
    var targetVal = isPreset ? saved : '__custom__';
    if (!saved) targetVal = '社外秘';            // 初回(空)はプリセット先頭

    var chips = document.querySelectorAll('.wm-chip-input');
    for (var i = 0; i < chips.length; i++) {
      chips[i].checked = (chips[i].value === targetVal);
    }
    var custom = (targetVal === '__custom__');
    if (customWrap) customWrap.hidden = !custom;
    if (inp) inp.value = custom ? wmStripUnsupported(saved) : '';   // 旧保存の絵文字も表示前に除去 (M14)
    wmShowEmojiNote(false);   // 開き直し/同期時は注記をリセット

    wmRenderPreview();
  }

  function syncSettingsUiFromState() {
    var meta = document.getElementById('setMetaStrip');
    if (meta) meta.checked = (pdfcSettings.stripMetadata !== false);
    syncWatermarkUi();   // 透かしUIの状態復元 (rank2)
  }
  function openSettings() {
    var modal = document.getElementById('settingsModal');
    if (!modal) { console.error('settingsModal missing'); return; }
    markSettingsSeen();
    syncSettingsUiFromState();
    modal.classList.add('open');
  }
  function closeSettings() {
    var modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('open');
  }
  window.openSettings = openSettings;
  window.closeSettings = closeSettings;
  /* 設定の新機能コーチマーク (v3.7.1): 一度開いたら二度と出さない */
  var SETTINGS_SEEN_KEY = 'pdfCompact.settingsSeen';
  function markSettingsSeen() {
    try { localStorage.setItem(SETTINGS_SEEN_KEY, '1'); } catch(_) {}
    document.body.classList.remove('settings-unseen');
    var cm = document.getElementById('settingsCoachmark'); if (cm) cm.classList.remove('show');
  }
  function initSettingsHint() {
    var seen = false; try { seen = localStorage.getItem(SETTINGS_SEEN_KEY) === '1'; } catch(_) {}
    if (seen) return;
    document.body.classList.add('settings-unseen');
    var closeBtn = document.getElementById('settingsCoachClose');
    if (closeBtn && !closeBtn.__bound) { closeBtn.__bound = true; closeBtn.addEventListener('click', markSettingsSeen); }
    if (window.innerWidth >= 720) {
      var btn = document.getElementById('settingsBtn'); var cm = document.getElementById('settingsCoachmark');
      if (btn && cm) {
        var r = btn.getBoundingClientRect();
        cm.style.top = (r.bottom + 10) + 'px';
        cm.style.right = Math.max(8, (window.innerWidth - r.right)) + 'px';
        cm.classList.add('show');
        setTimeout(function(){ cm.classList.remove('show'); }, 12000);
      }
    }
  }
  /* トグル変更 → 即 state 反映 + 即保存 (おっちゃんが「保存」を押し忘れても効く) */
  /* 透かしUI 変更 → state へ即保存 (閉じ忘れても効く) */
  function bindWatermarkControls() {
    var on  = document.getElementById('setWatermark');
    var inp = document.getElementById('setWatermarkText');
    var customWrap = document.getElementById('setWatermarkCustomWrap');
    var wrap = document.getElementById('setWatermarkTextWrap');

    if (on) {
      on.addEventListener('change', function () {
        pdfcSettings.watermark = !!on.checked;
        if (wrap) wrap.hidden = !on.checked;
        if (on.checked) {
          if (!(pdfcSettings.watermarkText || '').trim()) {
            pdfcSettings.watermarkText = '社外秘';   // 初回ONでプリセット先頭
          }
          syncWatermarkUi();
        }
        savePdfcSettings();
      });
    }

    var chipGroup = document.querySelector('.wm-chips');
    if (chipGroup) {
      chipGroup.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('wm-chip-input')) return;
        var custom = !!t.getAttribute('data-custom');
        if (customWrap) customWrap.hidden = !custom;
        if (custom) {
          if (inp) {
            if (WM_PRESETS.indexOf((pdfcSettings.watermarkText || '').trim()) !== -1) inp.value = '';
            inp.focus();
          }
        }
        pdfcSettings.watermarkText = wmEffectiveText();
        wmRenderPreview();
        savePdfcSettings();
      });
    }

    if (inp) {
      inp.addEventListener('input', function () {
        // 絵文字は透かしに焼けない → 入力時点で除去し、除去が起きた時だけ注記を出す (M14)
        var cleaned = wmStripUnsupported(inp.value);
        if (cleaned !== inp.value) {
          inp.value = cleaned;
          wmShowEmojiNote(true);
        } else {
          wmShowEmojiNote(false);
        }
        pdfcSettings.watermarkText = cleaned.trim();
        wmRenderPreview();
        savePdfcSettings();
      });
    }
  }

  (function bindSettingsControls() {
    var meta = document.getElementById('setMetaStrip');
    if (meta) {
      meta.addEventListener('change', function () {
        pdfcSettings.stripMetadata = !!meta.checked;
        savePdfcSettings();
      });
    }
    bindWatermarkControls();   // 透かしUIバインド (rank2)。1回だけ
  })();
  /* 閉じる作法: 背景クリック + ESC (success-modal と同一パターン) */
  (function bindSettingsClose() {
    var modal = document.getElementById('settingsModal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target.id === 'settingsModal') closeSettings();
      });
    }
    document.addEventListener('keydown', function (e) {
      var m = document.getElementById('settingsModal');
      if (e.key === 'Escape' && m && m.classList.contains('open')) closeSettings();
    });
  })();
