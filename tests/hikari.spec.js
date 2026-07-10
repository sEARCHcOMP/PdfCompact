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
