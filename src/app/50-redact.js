  (function redactModule(){
    'use strict';
    var L = window.pdfjsLib;
    var upload = document.getElementById('redactUpload');
    var fileInput = document.getElementById('redactFileInput');
    var editor = document.getElementById('redactEditor');
    var wrap = document.getElementById('redactCanvasWrap');
    var canvas = document.getElementById('redactCanvas');
    var textLayer = document.getElementById('redactTextLayer');
    var overlay = document.getElementById('redactOverlay');
    var cellsLayer = document.getElementById('redactCells');
    var pageInfo = document.getElementById('redactPageInfo');
    var prevBtn = document.getElementById('redactPrev');
    var nextBtn = document.getElementById('redactNext');
    var clearBtn = document.getElementById('redactClearPage');
    var resetBtn = document.getElementById('redactResetBtn');
    var modeTextBtn = document.getElementById('redactModeText');
    var modeRectBtn = document.getElementById('redactModeRect');
    var modeHint = document.getElementById('redactModeHint');
    if (!upload || !canvas || !overlay || !textLayer || !cellsLayer) return;

    var st = { pdf:null, numPages:0, pageIndex:0, rects:{}, mode:'text', prefMode:'text', pageHasText:false,
               renderTask:null, textTask:null,
               renderGen:0, rendering:false,   // 頁描画の世代番号(連打レース対策)と描画中フラグ(描画中は黒塗り入力を受けない)
               pageWidthPt:0,                  // 表示中ページの実幅(pt)。dedupe の横ギャップ許容の実寸クランプに使う
               textFetchFailed:false,          // getTextContent が例外だった頁(「文字なし」と区別して文言を変える)
               exporting:false };              // 出力(黒塗り焼き込み)実行中フラグ。trueの間は編集系UIを全て遮断
    var MIN_PX = 2;   // 退化矩形(空白/潰れ)の足切り閾値(canvas px)。ページ比率基準にしない=大判図面の小さい文字を捨てない

    // ---- モード切替 (文字を選ぶ / 自由に四角) ----
    function setMode(m){
      st.prefMode = m;   // ユーザーの希望(text/rect)を保持。実効modeは下で算出
      // 文字レイヤーが無いページで text を選んだら rect に矯正
      if (m === 'text' && !st.pageHasText){
        m = 'rect';
        // 読取失敗(getTextContent例外)のページでは「無い」と断定しない文言にする
        if (modeHint) modeHint.textContent = st.textFetchFailed
          ? 'このページは文字データを読み取れないので「自由に四角」で囲ってください。'
          : 'このページは文字データが無いので「自由に四角」で囲ってください(スキャン画像/CAD出力など)。';
      } else if (modeHint) {
        modeHint.textContent = (m === 'text')
          ? '文字をクリック、またはなぞって選ぶと、その文字の上に黒塗りが付きます(タブレットはタップか長押し。重なりは自動でまとめます)。'
          : 'ページ上をドラッグして、黒塗りする範囲を四角で描きます。';
      }
      st.mode = m;
      wrap.classList.toggle('mode-text', m === 'text');
      wrap.classList.toggle('mode-rect', m === 'rect');
      if (modeTextBtn) modeTextBtn.classList.toggle('active', m === 'text');
      if (modeRectBtn) modeRectBtn.classList.toggle('active', m === 'rect');
    }

    // ---- PDF 読込 ----
    async function loadPdf(file){
      if (!file || file.type !== 'application/pdf') { alert('PDFファイルを選んでください'); return; }
      try {
        var buf = await file.arrayBuffer();
        st.bytes = buf.slice(0);                               // pdf-lib(出力)用に原本バイト保持
        st.pdf = await L.getDocument({ data: buf }).promise;
        st.numPages = st.pdf.numPages;
        st.pageIndex = 0; st.rects = {};
        upload.style.display = 'none';
        editor.classList.add('active');
        await renderPage(0);
      } catch(e){
        console.error('redact load failed', e);
        alert('PDFの読み込みに失敗しました: ' + (e && e.message ? e.message : e));
      }
    }

    // ---- ページ描画 (canvas + テキストレイヤー + 黒塗りセル) ----
    async function renderPage(idx){
      if (!st.pdf) return;
      idx = Math.max(0, Math.min(st.numPages-1, idx));
      var gen = ++st.renderGen;   // 世代トークン: 連打されても「最後の呼び出し」だけが画面と状態を確定させる(後勝ち)
      st.rendering = true;        // 描画完了まで黒塗り入力をロック(旧頁の見た目で取った座標が新頁に保存される事故防止)
      st.pageIndex = idx;
      if (st.renderTask){ try{ st.renderTask.cancel(); }catch(_){ } st.renderTask=null; }
      if (st.textTask){ try{ st.textTask.cancel(); }catch(_){ } st.textTask=null; }
      var page = await st.pdf.getPage(idx+1);
      if (gen !== st.renderGen) return;   // 待っている間に新しい頁送りが始まった→この呼び出しは捨てる(canvasを触らない)
      var vp1 = page.getViewport({ scale: 1 });
      st.pageWidthPt = vp1.width;   // 表示中ページの実幅(pt・回転込み)。dedupe の横ギャップ許容の実寸クランプに使う
      // 表示はステージ幅にフィット(A3横/A1横でも横スクロール不要)、レンダは高DPIで鮮明に。
      // 旧 920/vp1.width 方式は A3横(幅1190pt)で scale=1 止まり → 画面外 + 72DPI相当で荒かった。
      var stageEl = wrap.closest('.redact-stage');
      var availW = stageEl ? stageEl.clientWidth : 0;
      if (availW < 50) availW = 900;   // 非表示等で測れない時は標準幅(表示時に resize で再描画され正される)
      availW -= 16;                     // 枠+スクロールバー分の安全マージン(確実に収める)
      var displayScale = Math.min(2, availW / vp1.width);            // 大判は縮小、小さい紙は最大2倍まで
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var renderScale = Math.max(displayScale * dpr * 1.5, 1.5);     // 縮小表示でもCAD線/小文字をくっきり(最低1.5倍レンダ)
      var MAXDIM = 4000;               // 巨大図面(A0等)で canvas がメモリ爆発しない上限
      var maxRender = Math.max(vp1.width, vp1.height) * renderScale;
      if (maxRender > MAXDIM) renderScale = renderScale * MAXDIM / maxRender;
      var rvp = page.getViewport({ scale: renderScale });            // 高解像度レンダ用
      var dvp = page.getViewport({ scale: displayScale });           // 表示・テキスト層用(canvasのCSSサイズと一致)
      var RW = Math.ceil(rvp.width), RH = Math.ceil(rvp.height);
      var DW = Math.floor(dvp.width), DH = Math.floor(dvp.height);   // 表示は切り捨て=ステージ幅を1pxも超えない
      // canvas のバッキングは高解像度(RW×RH)、CSS表示はフィットサイズ(DW×DH)=ブラウザが縮小して鮮明に
      canvas.width = RW; canvas.height = RH;
      canvas.style.width = DW + 'px'; canvas.style.height = DH + 'px';
      wrap.style.width = DW + 'px'; wrap.style.height = DH + 'px';
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,RW,RH);
      st.renderTask = page.render({ canvasContext: ctx, viewport: rvp });
      try { await st.renderTask.promise; } catch(e){ if (e && e.name === 'RenderingCancelledException') return; }
      st.renderTask = null;
      // テキストレイヤー構築(表示ビューポートで配置=CSS表示サイズの canvas と完全一致。世代を渡し旧呼び出しの span 書き込みを止める)
      await buildTextLayer(page, dvp, displayScale, gen);
      if (gen !== st.renderGen) return;   // 追い越されていたら頁番号・ボタン・セルを触らない(旧頁による上書き=表示の嘘を防ぐ)
      pageInfo.textContent = (idx+1) + ' / ' + st.numPages;
      prevBtn.disabled = (idx === 0);
      nextBtn.disabled = (idx === st.numPages-1);
      renderCells();
      st.rendering = false;   // 最新世代が最後まで描けた時だけ入力ロック解除(破棄された旧呼び出しは解除しない)
    }

    // ---- テキストレイヤー(選択可能なspan群)を canvas に重ねる ----
    async function buildTextLayer(page, vp, scale, gen){
      textLayer.innerHTML = '';
      textLayer.style.setProperty('--scale-factor', String(scale));  // pdf.js 3.x の文字サイズ基準
      var tc;
      // 取得失敗(例外)は「文字なし」と別物として覚える→「ありません」と断定する嘘バナーを防ぐ(頁送りごとに再評価)
      st.textFetchFailed = false;
      try { tc = await page.getTextContent(); } catch(_) { tc = { items: [] }; st.textFetchFailed = true; }
      if (gen !== st.renderGen) return;   // 追い越された旧呼び出しは span を書き込まない(新旧頁のゴースト混在防止)
      var divs = [];
      try {
        st.textTask = L.renderTextLayer({ textContentSource: tc, container: textLayer, viewport: vp, textDivs: divs });
        await st.textTask.promise;
      } catch(e){ /* テキスト無し等は無視 */ }
      st.textTask = null;
      if (gen !== st.renderGen) return;   // キャンセルされた旧呼び出しは pageHasText/バナー/モードを触らない
      // 空白だけの span は「文字あり」に数えない(クリック側 rectFromSpan が弾く残骸spanしか無いページで、バナーも rect 矯正も出ず全クリック無反応のまま詰むのを防ぐ)
      var spans = textLayer.querySelectorAll('span');
      st.pageHasText = false;
      for (var si = 0; si < spans.length; si++){
        if (spans[si].textContent.trim() !== ''){ st.pageHasText = true; break; }
      }
      // 文字データ無しページは見た目で誘導(ホバー無効化 + バナー表示)。頁送りごとに再評価されるので混在PDFでも頁単位で正しく出る。
      wrap.classList.toggle('no-text', !st.pageHasText);
      var _bn = document.getElementById('redactNoTextBanner');
      if (_bn){
        // 読取失敗時は「ありません」と断定しない文言へ(毎頁で再設定するので前頁の文言を引きずらない)
        _bn.textContent = st.textFetchFailed
          ? '⬚ このページの文字データを読み取れませんでした。「自由に四角」で隠したい所を囲ってください。'
          : '⬚ このページは文字データがありません(スキャン画像/CAD出力など)。「自由に四角」で隠したい所を囲ってください。';
        _bn.classList.toggle('show', !st.pageHasText);
      }
      // 希望モードを再適用(文字有りページなら text に復帰、無ければ rect 矯正)
      setMode(st.prefMode);
    }

    // ---- クリックで一発黒塗り (text モード) + 移動量ガード ----
    // ドラッグ(範囲選択)は commitTextSelection に任せ、純クリックだけここで span 全体を黒塗り。
    // 二重発火は『直近 mousedown→click のポインタ移動量 < CLICK_MOVE_PX なら純クリック』で判定(setTimeout 順序や isCollapsed に依存しない)。
    st.suppressNextCommit = false;
    var CLICK_MOVE_PX = 6;
    var _downXY = null;
    textLayer.addEventListener('mousedown', function(e){ _downXY = { x:e.clientX, y:e.clientY }; st.suppressNextCommit = false; });  // 実ジェスチャ開始で残留フラグを掃除: mousedown無しの合成click(支援技術/自動化)が立てた保険は対のmouseupが来ず消費されないまま残り、次の正当なドラッグ選択commitを1回握り潰すため、新しい操作の起点で必ず白紙に戻す
    function rectFromSpan(span){
      var cw = wrap.getBoundingClientRect();
      if (cw.width === 0 || cw.height === 0) return null;
      var rc = span.getBoundingClientRect();
      if (rc.width < 2 || rc.height < 2) return null;       // 空白/潰れ span は無視
      var padY = rc.height * 0.12;                          // ドラッグ側と同じ12%余白でグリフ完全被覆
      return { x:(rc.left-cw.left)/cw.width, y:(rc.top-cw.top-padY)/cw.height, w:rc.width/cw.width, h:(rc.height+padY*2)/cw.height };
    }
    textLayer.addEventListener('click', function(e){
      if (st.mode !== 'text' || !st.pageHasText) return;    // rectモードは pointer-events:none、文字無しは触らせない
      // ドラッグだったら降りる(移動量で判定)。これがドラッグ後 click の二重発火を止める要。
      if (_downXY){
        var dx = e.clientX - _downXY.x, dy = e.clientY - _downXY.y;
        if ((dx*dx + dy*dy) > (CLICK_MOVE_PX*CLICK_MOVE_PX)){ _downXY = null; return; }
      }
      _downXY = null;
      var span = e.target.closest('span');                  // ★closest('span'): 入れ子ノードに強い。container ではなく span を掴む
      if (!span || !textLayer.contains(span)) return;
      var r = rectFromSpan(span);
      if (!r) return;
      pushRect(r.x, r.y, r.w, r.h);                         // pushRect 内で退化矩形の足切り/clamp 済み
      dedupeRects(st.pageIndex);                            // 既存セルと重なれば即 union(二重黒塗り防止)
      var sel = window.getSelection(); if (sel) sel.removeAllRanges();
      st.suppressNextCommit = true;                         // 保険: 直後の mouseup commit を1回スキップ
      renderCells();
      e.preventDefault(); e.stopPropagation();
    });

    // ---- 黒塗りセル(確定分)を描画。× は常にクリック可 ----
    function renderCells(){
      cellsLayer.innerHTML = '';
      var list = st.rects[st.pageIndex] || [];
      list.forEach(function(r, ri){
        var cell = document.createElement('div');
        cell.className = 'redact-cell';
        cell.style.left=(r.x*100)+'%'; cell.style.top=(r.y*100)+'%';
        cell.style.width=(r.w*100)+'%'; cell.style.height=(r.h*100)+'%';
        var del = document.createElement('button');
        del.className='redact-cell-delete'; del.type='button'; del.textContent='×';
        del.setAttribute('aria-label','この黒塗りを削除');
        del.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
        // ×はセル右上の外側へ10pxはみ出すため、text モードで隣の語や直上の行を
        // 塗ろうとしたクリックを横取りすることがある。確認なしで splice すると
        // 既存の黒塗りが黙って消え、気付かず出力すると秘密が露出する(漏れ方向)。
        // confirm を1枚挟んで誤爆を遮断する(キャンセル=何も変更しない)。
        del.addEventListener('click', function(e){
          e.stopPropagation();
          if (st.exporting){ rdStatus('出力中は編集できません。完了までお待ちください。', true); return; }
          if (!confirm('この黒塗りを削除しますか?')) return;
          list.splice(ri,1); renderCells();
        });
        cell.appendChild(del);
        cellsLayer.appendChild(cell);
      });
    }

    function pushRect(x,y,w,h){
      // 出力中の追加は出力ループに届かない(矩形配列の参照を捕捉済み)ため入口で遮断。クリック/なぞり/四角の全追加経路をここ1箇所で塞ぐ
      if (st.exporting){ rdStatus('出力中は編集できません。完了までお待ちください。', true); return; }
      if (st.rendering) return;   // 頁描画中も確定禁止: 旧頁の見た目で取った座標が st.pageIndex(新頁)に保存され「塗ったはずの頁が出力で素通し」になる事故を防ぐ
      // 非有限値(NaN/Infinity)は保存しない(wrap 高さ0等の異常系で 0除算した値を黙って弾く)
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
      // ページ範囲[0,1]との交差で切り取る(移動クランプだとページ外スパン由来の矩形が幅0ゴースト/位置ズレ黒塗りになる)
      var x2=Math.min(1,x+w), y2=Math.min(1,y+h);
      x=Math.max(0,x); y=Math.max(0,y);
      w=x2-x; h=y2-y;
      // 足切りは canvas px 基準の退化矩形(見えないゴミ)のみ、交差後の実寸で判定。
      // 旧 MIN_PCT=0.008 はページ比率固定のため大判ほど実寸の足切りが膨張し(A1横で幅約6.7mm/高約4.8mm未満が全滅)、
      // ホバーは光るのにクリック無反応・なぞった断片が無言で欠けて出力に文字が残る事故になっていた。
      if (w * canvas.width < MIN_PX || h * canvas.height < MIN_PX) return;
      if (!st.rects[st.pageIndex]) st.rects[st.pageIndex]=[];
      st.rects[st.pageIndex].push({x:x,y:y,w:w,h:h});
    }

    // ---- 重複黒塗りの自動マージ(dedup) — EDGE-GAP 方式(唯一の実装) ----
    // rect は {x,y,w,h} すべて 0..1。X方向は微小ギャップ(EPS_X)まで接触扱いで断片(fill+stroke二度描き・複数clientRects)を畳む。
    // Y方向は EPS_Y=0(交差必須)。text モードが行ごとに上下12%余白を足す設計に乗り、別行の誤統合を防ぐ。
    // union は必ずバウンディングボックス=元矩形を完全包含 → 黒塗り漏れ(露出)は起きない。出力 fillRect は冪等なので結果不変。
    var DEDUPE_EPS_X = 0.004;   // 約0.4%幅まで横の隙間を『接触』とみなす(カーニング/サブピクセル境界を繋ぐ)
    var DEDUPE_EPS_MAX_PT = 2.4; // EPS_Xの物理上限(pt)。2.4pt≒0.85mm=A4縦での従来値と同等。比率のままだと大判(A1/A0)で3〜5mmの実ギャップまで『接触』になり別の語/枠を巻き込むため実寸でクランプ
    var DEDUPE_EPS_Y = 0.0;     // 縦は交差必須(別行を守る)
    function rectsOverlap(a, b){
      // 実効EPS_X: ページ実幅が取れていれば物理上限を比率に換算してクランプ(min を取るだけなので従来より緩むことは無い=漏れ方向の変化ゼロ)
      var epsX = DEDUPE_EPS_X;
      if (st.pageWidthPt > 0){
        var cap = DEDUPE_EPS_MAX_PT / st.pageWidthPt;   // A4縦(595pt)では 0.00403>0.004 でクランプ不発=従来どおり
        if (cap < epsX) epsX = cap;
      }
      var oxRaw = Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x); // 正=交差,0=接点,負=隙間
      var oyRaw = Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
      return (oxRaw >= -epsX) && (oyRaw >= -DEDUPE_EPS_Y);
    }
    function unionRect(a, b){
      var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
      var x2 = Math.max(a.x+a.w, b.x+b.w), y2 = Math.max(a.y+a.h, b.y+b.h);
      return { x:x1, y:y1, w:x2-x1, h:y2-y1 };
    }
    // ページ pi の矩形配列を、重なる/接触するものどうし union で統合。union が第三の矩形を呼び込む連鎖も収束まで反復。
    function dedupeRects(pi){
      var src = st.rects[pi];
      if (!src || src.length < 2) return;            // 0/1個は不要(早期return)
      var rects = src.slice();
      var safety = rects.length + 4;                 // 無限ループ保険
      for (var pass = 0; pass < safety; pass++){
        var merged = false, out = [], used = new Array(rects.length);
        for (var i = 0; i < rects.length; i++){
          if (used[i]) continue;
          var cur = rects[i];
          for (var j = i + 1; j < rects.length; j++){
            if (used[j]) continue;
            if (rectsOverlap(cur, rects[j])){ cur = unionRect(cur, rects[j]); used[j] = true; merged = true; }
          }
          out.push(cur);
        }
        rects = out;
        if (!merged) break;                          // 統合ゼロ=収束
      }
      st.rects[pi] = rects;
    }

    // ---- 文字選択 → 黒塗り (text モード) ----
    function commitTextSelection(){
      if (st.mode !== 'text') return;
      if (st.suppressNextCommit){ st.suppressNextCommit = false; return; } // 保険: クリック黒塗り直後の1回を握りつぶす(主役は move-guard 側)
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      // 選択がテキストレイヤー内か確認
      if (!textLayer.contains(range.startContainer) && !textLayer.contains(range.commonAncestorContainer)) return;
      var cw = wrap.getBoundingClientRect();
      if (cw.width === 0) return;
      var rects = range.getClientRects();
      var added = 0;
      for (var i=0;i<rects.length;i++){
        var rc = rects[i];
        if (rc.width < 2 || rc.height < 2) continue;
        var padY = rc.height * 0.12;   // 行の上下に少し余白(グリフ完全被覆)
        var x = (rc.left - cw.left) / cw.width;
        var y = (rc.top - cw.top - padY) / cw.height;
        var w = rc.width / cw.width;
        var h = (rc.height + padY*2) / cw.height;
        pushRect(x,y,w,h); added++;
      }
      sel.removeAllRanges();
      if (added){ dedupeRects(st.pageIndex); renderCells(); }  // ★renderCells の前に重複マージ
    }
    document.addEventListener('mouseup', function(){ if (st.pdf && st.mode==='text') setTimeout(commitTextSelection, 0); });
    // ---- タッチ端末の選択確定 (selectionchange 監視) ----
    // タブレットの長押し選択はブラウザがジェスチャを乗っ取るため互換 mouseup が発火せず、
    // 上の mouseup 経路だけだと選択が永遠に未確定(青いまま=黒塗りされない)で残る。
    // そこで selectionchange を監視し、選択の変化が止まって 800ms 経ったら自動確定する。
    // ・マウス操作: ボタン押下中(_mouseHeld)は確定しない=ドラッグ途中の静止で選択が勝手に確定するのを防ぐ。
    //   離した時は上の mouseup 確定→removeAllRanges→collapsed 通知でタイマー解除されるので二重確定しない
    // ・レイヤー外の選択: commitTextSelection 冒頭の contains 判定が弾く(他タブの選択は消さない)
    var selChangeTimer = null;
    var _mouseHeld = false;
    document.addEventListener('mousedown', function(){ _mouseHeld = true; });
    document.addEventListener('mouseup', function(){ _mouseHeld = false; });
    document.addEventListener('touchstart', function(){ _mouseHeld = false; }, { passive: true });  // 長押し選択は互換mouseupが来ずフラグが残るため、実タッチ開始で必ず白紙に
    document.addEventListener('selectionchange', function(){
      if (selChangeTimer){ clearTimeout(selChangeTimer); selChangeTimer = null; }
      if (_mouseHeld || !st.pdf || st.mode !== 'text') return;
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      selChangeTimer = setTimeout(function(){ selChangeTimer = null; commitTextSelection(); }, 800);
    });

    // ---- 自由に四角 (rect モード, overlay 上でドラッグ) ----
    var draw = null;
    overlay.addEventListener('pointerdown', function(e){
      if (st.mode !== 'rect') return;
      var r = overlay.getBoundingClientRect();
      draw = { x0:(e.clientX-r.left)/r.width, y0:(e.clientY-r.top)/r.height, el:null, rect:r };
      try{ overlay.setPointerCapture(e.pointerId); }catch(_){ }
      e.preventDefault();
    });
    overlay.addEventListener('pointermove', function(e){
      if (!draw) return;
      var x=Math.max(0,Math.min(1,(e.clientX-draw.rect.left)/draw.rect.width));
      var y=Math.max(0,Math.min(1,(e.clientY-draw.rect.top)/draw.rect.height));
      var lx=Math.min(draw.x0,x), ly=Math.min(draw.y0,y), w=Math.abs(x-draw.x0), h=Math.abs(y-draw.y0);
      if (!draw.el){ draw.el=document.createElement('div'); draw.el.className='redact-cell'; draw.el.style.pointerEvents='none'; overlay.appendChild(draw.el); }
      draw.el.style.left=(lx*100)+'%'; draw.el.style.top=(ly*100)+'%'; draw.el.style.width=(w*100)+'%'; draw.el.style.height=(h*100)+'%';
    });
    function endDraw(e){
      if (!draw) return;
      try{ overlay.releasePointerCapture(e.pointerId); }catch(_){ }
      var x=Math.max(0,Math.min(1,(e.clientX-draw.rect.left)/draw.rect.width));
      var y=Math.max(0,Math.min(1,(e.clientY-draw.rect.top)/draw.rect.height));
      var lx=Math.min(draw.x0,x), ly=Math.min(draw.y0,y), w=Math.abs(x-draw.x0), h=Math.abs(y-draw.y0);
      if (draw.el) draw.el.remove();
      draw = null;
      pushRect(lx,ly,w,h); dedupeRects(st.pageIndex); renderCells();
    }
    overlay.addEventListener('pointerup', endDraw);
    overlay.addEventListener('pointercancel', endDraw);

    // ウィンドウ幅が変わったら表示倍率を取り直して再フィット(黒塗り矩形は比率保持なので残る)
    var _redactResizeTimer = null;
    window.addEventListener('resize', function(){
      if (!st.pdf || st.exporting) return;
      if (!wrap.offsetParent) return;   // 黒塗りタブ非表示中は再描画しない(隠れたパネルは幅0で誤フィットするため)
      if (_redactResizeTimer) clearTimeout(_redactResizeTimer);
      _redactResizeTimer = setTimeout(function(){ renderPage(st.pageIndex); }, 200);
    });

    // ---- ボタン配線 ----
    if (modeTextBtn) modeTextBtn.addEventListener('click', function(){ setMode('text'); });
    if (modeRectBtn) modeRectBtn.addEventListener('click', function(){ setMode('rect'); });
    prevBtn.addEventListener('click', function(){ renderPage(st.pageIndex-1); });
    nextBtn.addEventListener('click', function(){ renderPage(st.pageIndex+1); });
    clearBtn.addEventListener('click', function(){
      if (st.exporting){ rdStatus('出力中は編集できません。完了までお待ちください。', true); return; }
      if (st.rendering) return;   // 描画中は st.pageIndex が移動先を指すため、見えていない頁の黒塗りを誤って消すのを防ぐ
      if (st.rects[st.pageIndex] && st.rects[st.pageIndex].length){ st.rects[st.pageIndex]=[]; renderCells(); }
    });
    resetBtn.addEventListener('click', function(){
      // 出力中にリセットすると st.numPages=0 で出力ループが即脱出し、先頭数ページだけの
      // 切り詰めPDFが「✓ 出力しました」付きで保存されてしまうため遮断
      if (st.exporting){ rdStatus('出力中は別のPDFを開けません。完了までお待ちください。', true); return; }
      // 進行中の描画/文字レイヤータスクを止め、飛行中の renderPage も世代更新で無効化(旧PDFの描き残し防止)
      if (st.renderTask){ try{ st.renderTask.cancel(); }catch(_){ } st.renderTask=null; }
      if (st.textTask){ try{ st.textTask.cancel(); }catch(_){ } st.textTask=null; }
      st.renderGen++; st.rendering = false;
      st.pdf=null; st.bytes=null; st.rects={}; st.pageIndex=0; st.numPages=0;
      textLayer.innerHTML=''; cellsLayer.innerHTML='';
      // 前のPDFの残像と「文字なし」表示を後始末(次のPDF読込中に旧ページ画像や嘘バナーが見えるのを防ぐ)
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      st.pageHasText = true;   // 仮置き。次の buildTextLayer が頁ごとに必ず再評価する(falseのままだと下の setMode が rect 矯正+文字無しヒントを再注入してしまう)
      wrap.classList.remove('no-text');
      var _bn = document.getElementById('redactNoTextBanner');
      if (_bn) _bn.classList.remove('show');
      setMode(st.prefMode);    // ヒント文言とモード表示を希望モードへ戻す(文字無し頁での rect 矯正を解除)
      editor.classList.remove('active'); upload.style.display=''; fileInput.value='';
    });

    upload.addEventListener('click', function(){ fileInput.click(); });
    fileInput.addEventListener('change', function(e){ if (e.target.files[0]) loadPdf(e.target.files[0]); });
    upload.addEventListener('dragover', function(e){ e.preventDefault(); upload.classList.add('dragover'); });
    upload.addEventListener('dragleave', function(){ upload.classList.remove('dragover'); });
    upload.addEventListener('drop', function(e){ e.preventDefault(); upload.classList.remove('dragover'); if (e.dataTransfer.files && e.dataTransfer.files[0]) loadPdf(e.dataTransfer.files[0]); });

    // ===== 出力エンジン (本物の不可逆消去) — v3.8.0 Phase2 =====
    function rdStatus(msg, isErr){
      var note = document.getElementById('redactExportNote');
      if (note){ note.textContent = msg || ''; note.style.color = isErr ? 'var(--warn, #cc5520)' : ''; }
    }
    // 00-core の共有 triggerDownload に委譲(実装を一本化。rd-名は呼び出し側の都合で残す)
    function rdTriggerDownload(blob, name){ triggerDownload(blob, name); }
    function rdTotalRects(){ var n=0; for (var k in st.rects){ if (st.rects[k]) n += st.rects[k].length; } return n; }
    function rdAffectedPages(){ return Object.keys(st.rects).filter(function(k){ return st.rects[k] && st.rects[k].length; }); }

    // 矩形の周囲(8px幅のリング)のピクセルから紙の色を推察する(v4.1.0「背景色で消す」用)。
    // 文字や罫線の混入に強いよう各チャンネルの中央値を採用。他の黒塗り矩形の内側
    // (=これから消す秘密の文字)はサンプルに入れない。標本が足りなければ白に倒す。
    function samplePaperColor(ctx, rp, allRects, cw, ch){
      var M = 8, STEP = 3;
      var rs = [], gs = [], bs = [];
      function insideAny(px, py){
        for (var q = 0; q < allRects.length; q++){
          var a = allRects[q];
          if (px >= a.x && px < a.x + a.w && py >= a.y && py < a.y + a.h) return true;
        }
        return false;
      }
      function grab(sx, sy, sw, sh){
        var cx = Math.max(0, sx), cy = Math.max(0, sy);
        sw -= (cx - sx); sh -= (cy - sy);
        sw = Math.min(cw - cx, sw); sh = Math.min(ch - cy, sh);
        if (sw <= 0 || sh <= 0) return;
        var d = ctx.getImageData(cx, cy, sw, sh).data;
        for (var yy = 0; yy < sh; yy += STEP){
          for (var xx = 0; xx < sw; xx += STEP){
            if (insideAny(cx + xx, cy + yy)) continue;
            var o = (yy * sw + xx) * 4;
            rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]);
          }
        }
      }
      grab(rp.x - M, rp.y - M, rp.w + M * 2, M);      // 上辺の外側
      grab(rp.x - M, rp.y + rp.h, rp.w + M * 2, M);   // 下辺の外側
      grab(rp.x - M, rp.y, M, rp.h);                  // 左辺の外側
      grab(rp.x + rp.w, rp.y, M, rp.h);               // 右辺の外側
      if (rs.length < 12) return '#fff';
      function med(arr){ arr.sort(function(a, b){ return a - b; }); return arr[arr.length >> 1]; }
      return 'rgb(' + med(rs) + ',' + med(gs) + ',' + med(bs) + ')';
    }

    // 影響ページを高DPIラスタ化(canvasで焼き込み=テキスト物理消滅)、非影響はベクター温存
    async function generateRedactedPdf(){
      var PDFLib = window.PDFLib;
      var srcDoc = await PDFLib.PDFDocument.load(st.bytes);   // 暗号化PDFはここでthrow→runExportでハンドル
      var outDoc = await PDFLib.PDFDocument.create();
      var affected = [];
      var RDPI = 200;
      var paperMode = st.fillMode === 'paper';   // 出力開始時点で固定(途中でトグルされてもページ間で混ざらない)
      for (var i = 0; i < st.numPages; i++){
        var rects = st.rects[i] || [];
        if (rects.length){
          affected.push(i);
          rdStatus('黒塗りページを画像化中… (ページ ' + (i+1) + ')');
          await new Promise(function(r){ setTimeout(r, 0); });   // 進捗をUIへ反映
          var page = await st.pdf.getPage(i+1);
          var vp = page.getViewport({ scale: RDPI / 72 });
          var cv = document.createElement('canvas');
          cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          // ★塗りは必ず canvas の fillRect でのみ焼く。pdf-lib drawRectangle で被せる
          //   「偽リダクション(下の文字が残る)」は構造的に作らない。
          //   色は黒(従来) or 背景色(周囲の紙の色を推察)。どちらも消去の実体は
          //   同一(画像化+上書き)で、安全性・検証は色に依存しない。
          var rectsPx = rects.map(function(rr){
            return { x: Math.round(rr.x*cv.width), y: Math.round(rr.y*cv.height),
                     w: Math.round(rr.w*cv.width), h: Math.round(rr.h*cv.height) };
          });
          // 塗る前に全矩形の色を確定する(先に塗ると隣接矩形のサンプリングが
          // 塗り済みピクセルで汚れ、推察色が連鎖的にズレるため)
          var fills = rectsPx.map(function(rp){
            return paperMode ? samplePaperColor(ctx, rp, rectsPx, cv.width, cv.height) : '#000';
          });
          for (var j = 0; j < rectsPx.length; j++){
            ctx.fillStyle = fills[j];
            ctx.fillRect(rectsPx[j].x, rectsPx[j].y, rectsPx[j].w, rectsPx[j].h);
          }
          var jpg = cv.toDataURL('image/jpeg', 0.85);
          var bytes = Uint8Array.from(atob(jpg.split(',')[1]), function(c){ return c.charCodeAt(0); });
          var img = await outDoc.embedJpg(bytes);
          var vp1 = page.getViewport({ scale: 1 });   // 出力ページは元のpt寸法(回転適用後)
          var op = outDoc.addPage([vp1.width, vp1.height]);
          op.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
          cv.width = 0; cv.height = 0;   // 大きいcanvasを解放
        } else {
          var copied = await outDoc.copyPages(srcDoc, [i]);   // ベクター温存コピー
          outDoc.addPage(copied[0]);
        }
      }
      // create() ベースなので元の作成者/タイトル等は乗らない。updateMetadata:false で
      // pdf-lib の Producer/ModDate 再注入も防ぐ。
      var outBytes = await outDoc.save({ updateMetadata: false });
      return { outBytes: outBytes, affected: affected };
    }

    // ★出力前の本物消去検証(fail-safe): 影響ページのテキストがゼロである事を機械確認。
    //   1文字でも残っていたらDLさせない。
    async function verifyRedaction(outBytes, affected){
      if (!affected.length) return { ok: true };
      var doc = await L.getDocument({ data: outBytes.slice(0) }).promise;
      for (var k = 0; k < affected.length; k++){
        var page = await doc.getPage(affected[k] + 1);
        var tc = await page.getTextContent();
        var len = 0; for (var m = 0; m < tc.items.length; m++){ len += (tc.items[m].str || '').length; }
        if (len > 0) return { ok: false, page: affected[k] + 1, residual: len };
      }
      return { ok: true };
    }

    async function runExport(){
      if (!st.pdf) return;
      if (rdTotalRects() === 0){ alert('黒塗りが1つもありません。隠したい所をなぞる、または四角で囲ってください。'); return; }
      var affN = rdAffectedPages().length;
      var ok = confirm(
        affN + ' ページが画像に変換されます。\n\n' +
        '・そのページは文字のコピー/検索ができなくなり、解像度はやや下がります(情報を物理的に消すための仕様です)\n' +
        '・黒塗りの無いページは高画質のまま残ります\n\n' +
        '出力しますか?'
      );
      if (!ok) return;
      var btn = document.getElementById('redactExportBtn');
      if (btn) btn.disabled = true;
      try {
        rdStatus('処理を開始しています…');
        var gen = await generateRedactedPdf();
        rdStatus('本当に消えたか検証中…');
        var v = await verifyRedaction(gen.outBytes, gen.affected);
        if (!v.ok){
          rdStatus('❌ ページ' + v.page + ' に文字が残っていました。安全のため出力を中止しました(不具合報告をお願いします)。', true);
          if (btn) btn.disabled = false;
          return;
        }
        var blob = new Blob([gen.outBytes], { type: 'application/pdf' });
        if (window.PdfSanitize){ try { blob = await window.PdfSanitize.process(blob); } catch(_){ } }  // 設定のメタ除去/透かしも適用
        var now = new Date();
        var ymd = '' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
        rdTriggerDownload(blob, '墨消し_' + ymd + '.pdf');
        rdStatus('✓ 出力しました(' + gen.affected.length + 'ページを画像化して文字を物理消去)。配布前に必ず中身をご確認ください。');
      } catch(e){
        console.error('redact export failed', e);
        var enc = e && /encrypt/i.test(String(e.message || e));
        rdStatus('❌ ' + (enc ? '暗号化されたPDFは黒塗りできません(パスワードを解除してから読み込んでください)。'
                              : '出力に失敗しました: ' + (e && e.message ? e.message : e)), true);
        if (btn) btn.disabled = false;
        return;
      }
      if (btn) btn.disabled = false;
    }
    var _rdExportBtn = document.getElementById('redactExportBtn');
    // ★出力中の編集ロック(入口): 出力ループはページ矩形の配列参照を反復冒頭で1回だけ捕捉するため、
    //   出力中に追加/削除/リセットすると「画面は黒いのに成果物に反映されない」黒塗り漏れになる。
    //   runExport 本体は実機実証済みのため非改変とし、呼び出し側で st.exporting を立てて編集系で弾く。
    //   完了・失敗・confirmキャンセルのどの経路でも finally で必ず下ろす。
    if (_rdExportBtn){ _rdExportBtn.disabled = false; _rdExportBtn.addEventListener('click', async function(){
      if (st.exporting) return;                    // 二重起動の保険
      st.exporting = true;
      try { await runExport(); } finally { st.exporting = false; }
    }); }
    // ---- 塗りつぶしの色 (v4.1.0): black=従来の黒塗り / paper=背景色を推察して塗る ----
    var _rdFillBlack = document.getElementById('redactFillBlack');
    var _rdFillPaper = document.getElementById('redactFillPaper');
    function setFillMode(mode){
      st.fillMode = mode;
      var paper = mode === 'paper';
      if (_rdFillBlack) _rdFillBlack.classList.toggle('active', !paper);
      if (_rdFillPaper) _rdFillPaper.classList.toggle('active', paper);
      var wrap = document.getElementById('redactCanvasWrap');
      if (wrap) wrap.classList.toggle('fill-paper', paper);   // 仮表示セルの見た目を追随
      var btn = document.getElementById('redactExportBtn');
      if (btn) btn.textContent = paper ? '⬜ 背景色で消して出力' : '🖤 黒塗りして出力';
    }
    if (_rdFillBlack && _rdFillPaper){
      _rdFillBlack.addEventListener('click', function(){
        if (st.exporting){ rdStatus('出力中は変更できません。完了までお待ちください。', true); return; }
        setFillMode('black');
      });
      _rdFillPaper.addEventListener('click', function(){
        if (st.exporting){ rdStatus('出力中は変更できません。完了までお待ちください。', true); return; }
        setFillMode('paper');
      });
    }
    setFillMode('black');            // 初期は黒(正式な墨消しの既定)
    setMode('text');                 // 初期は文字選択モード
    window.__redactState = st;
  })();

