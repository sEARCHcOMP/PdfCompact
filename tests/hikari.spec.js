// Hikari(スマホ転送)タブ: パネル切替とSDK遅延ロード規律の回帰テスト
const { test, expect } = require('@playwright/test');
const { openApp, gotoTab } = require('./helpers');

test('Hikariタブに切り替えるとパネルが表示される', async ({ page }) => {
  await openApp(page);
  await gotoTab(page, 'hikari');
  const state = await page.evaluate(() => ({
    activeId: document.querySelector('.mode-panel.active')?.id,
    tabActive: document.querySelector('.mode-tab[data-mode="hikari"]')?.classList.contains('active'),
  }));
  expect(state.activeId).toBe('modeHikari');
  expect(state.tabActive).toBe(true);
});

test('Hikariタブを開くまで Firebase SDK を読み込まない(他タブのオフライン性の番犬)', async ({ page }) => {
  await openApp(page);
  // 別タブをいくつか操作しても SDK スクリプトが注入されないこと
  await gotoTab(page, 'redact');
  await gotoTab(page, 'convert');
  const loaded = await page.evaluate(() => ({
    hasFirebaseScript: !!document.querySelector('script[src*="firebasejs"]'),
    hasFirebaseGlobal: typeof window.firebase !== 'undefined',
    hasQrScript: !!document.querySelector('script[src*="qrcode-generator"]'),
  }));
  expect(loaded.hasFirebaseScript).toBe(false);
  expect(loaded.hasFirebaseGlobal).toBe(false);
  expect(loaded.hasQrScript).toBe(false);
});

test('Hikariタブ選択で SDK の遅延ロードが始まる', async ({ page }) => {
  // openApp(CDNライブラリ読込待ち)は使わない: このテストはタブクリック→script注入
  // だけを見るので、アプリJSが動けば十分(CDN待ちが flaky の原因だった)
  await page.goto('/index.html');
  await page.waitForSelector('.mode-tab[data-mode="hikari"]');
  await page.click('.mode-tab[data-mode="hikari"]');
  // 動的 script 注入が始まっていること(ロード完了までは待たない: ネットワーク非依存で判定)
  const injected = await page.evaluate(() =>
    !!document.querySelector('script[src*="firebase-app-compat"]')
  );
  expect(injected).toBe(true);
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
