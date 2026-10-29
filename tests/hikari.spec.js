// Hikari(スマホ転送)タブ: パネル切替とSDK遅延ロード規律の回帰テスト
const { test, expect } = require('@playwright/test');
const { openApp, gotoTab } = require('./helpers');

test('起動時の既定タブがスマホ転送(v4.3.0)+タブ並びの一番左+他タブへ切替できる', async ({ page }) => {
  await openApp(page);
  const initial = await page.evaluate(() => ({
    activeId: document.querySelector('.mode-panel.active')?.id,
    tabActive: document.querySelector('.mode-tab[data-mode="hikari"]')?.classList.contains('active'),
    firstTab: document.querySelector('.mode-tab')?.dataset.mode,
  }));
  expect(initial.activeId).toBe('modeHikari');   // 開いた瞬間スマホ転送
  expect(initial.tabActive).toBe(true);
  expect(initial.firstTab).toBe('hikari');       // 一番左
  // 他タブへ移って戻れる
  await gotoTab(page, 'compress');
  expect(await page.evaluate(() => document.querySelector('.mode-panel.active')?.id)).toBe('modeCompress');
  await gotoTab(page, 'hikari');
  expect(await page.evaluate(() => document.querySelector('.mode-panel.active')?.id)).toBe('modeHikari');
});

test('既定タブ化に伴い SDK は起動時に読み込み開始+他タブの動作を阻害しない', async ({ page }) => {
  // v4.3.0 で番犬の意味が反転: 旧「クリックまで読み込まない」→ 新「起動時に自動で始まり、
  // 読込中/失敗でも他タブは普通に使える」(オフライン時は hikari 内の案内表示に落ちるだけ)
  await page.goto('/index.html');
  await page.waitForSelector('.mode-tab[data-mode="hikari"]');
  // クリック無しで SDK 注入が始まる(ロード完了は待たない: ネットワーク非依存で判定)
  await page.waitForFunction(() =>
    !!document.querySelector('script[src*="firebase-app-compat"]'), null, { timeout: 15_000 });
  // SDK 読込と並行して他タブへ普通に切替できる
  await page.click('.mode-tab[data-mode="redact"]');
  expect(await page.evaluate(() => document.querySelector('.mode-panel.active')?.id)).toBe('modeRedact');
});

test('送信UI: 接続前はボタン無効+案内、要素が揃っている(v3.12.0 PC→スマホ)', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForSelector('.mode-tab[data-mode="hikari"]');
  await page.click('.mode-tab[data-mode="hikari"]');
  const ui = await page.evaluate(() => ({
    card: !!document.getElementById('hikariSendCard'),
    input: !!document.getElementById('hikariSendInput'),
    drop: !!document.getElementById('hikariSendDrop'),
    btnDisabled: document.getElementById('hikariSendBtn')?.disabled,
    hint: document.getElementById('hikariSendHint')?.textContent || '',
  }));
  expect(ui.card).toBe(true);
  expect(ui.input).toBe(true);
  expect(ui.drop).toBe(true);
  expect(ui.btnDisabled).toBe(true);                 // スマホ未接続なら送信不可
  expect(ui.hint).toContain('接続すると送信できます');
});

// ------------------------------------------------------------------
// 受信の筋(スマホ→PC)。Firebase SDK と QR を差し替えて、通知を人の手で起こす。
// v4.8.0 で行の絵文字をアイコンへ差し替えた際、定数の宣言が init() の内側に
// 紛れ込み、addPendingRow / addDoneRow が ReferenceError で落ちて
// 「iPhone から送っても PC に出てこない」事故になった。その再発を止める番犬。
// ------------------------------------------------------------------
const FAKE_FIREBASE = `(function(){
  var handlers = {};
  function ref(path){
    return {
      set: function(){ return Promise.resolve(); },
      remove: function(){ return Promise.resolve(); },
      onDisconnect: function(){ return { remove: function(){ return Promise.resolve(); } }; },
      on: function(evt, cb){ handlers[path + '|' + evt] = cb; }
    };
  }
  function database(){ return { ref: ref }; }
  database.ServerValue = { TIMESTAMP: 0 };
  window.firebase = {
    apps: [],
    initializeApp: function(){ window.firebase.apps.push({}); },
    database: database
  };
  function pick(suffix){
    var k = Object.keys(handlers).filter(function(x){ return x.indexOf(suffix) >= 0; })[0];
    if (!k) throw new Error('監視が登録されていない: ' + suffix);
    return handlers[k];
  }
  window.__hikariFake = {
    presence: function(n){ pick('/phonePresence|value')({ numChildren: function(){ return n; } }); },
    transfer: function(key, meta){ pick('/transfers|child_added')({ key: key, val: function(){ return meta; } }); }
  };
})();`;

const FAKE_QR = `window.qrcode = function(){
  return { addData: function(){}, make: function(){},
    createImgTag: function(){ return '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">'; } };
};`;

test('受信: スマホの通知で受信待ちの行が出て、受信するとダウンロード済みへ移る', async ({ page }) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.route(/firebase-app-compat\.js/, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
  await page.route(/firebase-database-compat\.js/, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: '/* 差し替え済み */' }));
  await page.route(/qrcode/, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: FAKE_QR }));
  await page.route(/\/download\?key=/, (r) =>
    r.fulfill({ contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }));
  await page.route(/\/delete\?key=/, (r) => r.fulfill({ status: 200, body: '' }));

  await page.goto('/index.html');
  await page.waitForFunction(() => !!window.__hikariFake, null, { timeout: 30_000 });
  await page.waitForSelector('#hikariMain:not([hidden])', { timeout: 30_000 });
  await page.evaluate(() => { HTMLAnchorElement.prototype.click = function(){}; });

  // スマートフォンが写真1枚を知らせてきた
  await page.evaluate(() => window.__hikariFake.transfer('f1', {
    from: 'phone', name: 'IMG_0001.JPG', size: 2400000, mime: 'image/jpeg', key: 'rooms/x/f1',
  }));
  const pending = await page.evaluate(() => {
    const row = document.querySelector('#hikariPendingList .hikari-row');
    return {
      cardShown: !document.getElementById('hikariPendingCard').hidden,
      rows: document.querySelectorAll('#hikariPendingList .hikari-row').length,
      name: row ? row.querySelector('.hikari-row-name').textContent : null,
      size: row ? row.querySelector('.hikari-row-size').textContent : null,
      thumbSvg: !!(row && row.querySelector('.hikari-row-thumb svg')),
      accept: !!(row && row.querySelector('.hikari-row-accept')),
    };
  });
  expect(pending.cardShown).toBe(true);
  expect(pending.rows).toBe(1);            // 枠だけ出て中身が空 = v4.8.0 の事故
  expect(pending.name).toBe('IMG_0001.JPG');
  expect(pending.size).toContain('MB');
  expect(pending.thumbSvg).toBe(true);     // 絵文字でなくアイコンが入っている
  expect(pending.accept).toBe(true);

  // 「受信」を押すと実体を取ってダウンロード済みへ移る
  await page.click('#hikariPendingList .hikari-row-accept');
  await page.waitForFunction(
    () => document.querySelectorAll('#hikariDoneList .hikari-row').length === 1,
    null, { timeout: 15_000 });
  const done = await page.evaluate(() => {
    const row = document.querySelector('#hikariDoneList .hikari-row');
    return {
      pendingLeft: document.querySelectorAll('#hikariPendingList .hikari-row').length,
      name: row.querySelector('.hikari-row-name').textContent,
      thumbSvg: !!row.querySelector('.hikari-row-thumb svg'),
      mark: row.querySelector('.hikari-row-done-mark').textContent,
    };
  });
  expect(done.pendingLeft).toBe(0);
  expect(done.name).toBe('IMG_0001.JPG');
  expect(done.thumbSvg).toBe(true);
  expect(done.mark).toContain('ダウンロード済み');
  expect(errs).toEqual([]);                // 受信の筋で例外ゼロ
});

test('接続表示: スマートフォンが入ると送信ボタンが使えるようになる', async ({ page }) => {
  await page.route(/firebase-app-compat\.js/, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: FAKE_FIREBASE }));
  await page.route(/firebase-database-compat\.js/, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: '/* 差し替え済み */' }));
  await page.route(/qrcode/, (r) =>
    r.fulfill({ contentType: 'application/javascript', body: FAKE_QR }));

  await page.goto('/index.html');
  await page.waitForFunction(() => !!window.__hikariFake, null, { timeout: 30_000 });
  await page.waitForSelector('#hikariMain:not([hidden])', { timeout: 30_000 });

  await page.evaluate(() => window.__hikariFake.presence(1));
  const on = await page.evaluate(() => ({
    status: document.getElementById('hikariStatus').textContent,
    ring: document.getElementById('hikariQrStage').classList.contains('connected'),
    btnDisabled: document.getElementById('hikariSendBtn').disabled,
  }));
  expect(on.status).toContain('接続中');
  expect(on.ring).toBe(true);
  expect(on.btnDisabled).toBe(false);

  await page.evaluate(() => window.__hikariFake.presence(0));
  const off = await page.evaluate(() => ({
    status: document.getElementById('hikariStatus').textContent,
    btnDisabled: document.getElementById('hikariSendBtn').disabled,
  }));
  expect(off.status).toContain('待っています');
  expect(off.btnDisabled).toBe(true);
});
