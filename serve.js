// 簡易HTTPサーバー: iPad/iPhone Safari で http://<PC-IP>:8080/ でアクセス
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +(process.env.PORT || 8080);  // テスト時は PORT 環境変数で差し替え可
const ROOT = path.resolve(__dirname);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf':  'application/pdf',
  '.svg':  'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  // ディレクトリトラバーサル防止
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403; res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    // キャッシュ無効化（テスト中）
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server: http://localhost:' + PORT + '/');
  console.log('From iPad: http://192.168.0.119:' + PORT + '/');
});
