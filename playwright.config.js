// PDF Compact スモークテスト設定。serve.js をテスト専用ポートで自動起動する
// 実行: npm test (全部) / npx playwright test tests/redact.spec.js (個別)
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 120_000,            // pdf.js CDN読込+重いレンダがあるので長め
  expect: { timeout: 15_000 },
  fullyParallel: false,        // 重い pdf.js ページは直列で(劣化防止: handoff §3)
  workers: 1,
  retries: 1,                  // CDN の揺らぎ対策で1回だけ再試行
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8123',
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'node serve.js',
    port: 8123,
    env: { PORT: '8123' },
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
