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
  await openApp(page);
  await gotoTab(page, 'hikari');
  // 動的 script 注入が始まっていること(ロード完了までは待たない: ネットワーク非依存で判定)
  const injected = await page.evaluate(() =>
    !!document.querySelector('script[src*="firebase-app-compat"]')
  );
  expect(injected).toBe(true);
});
