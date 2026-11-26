/* ADC 员工端本地预览服务（零依赖）
 * 用法：node web/serve.js [端口]   默认 8765
 *
 * 为什么不用 python -m http.server：Windows 上它把 .css 返回成
 * application/x-css、.js 返回成 application/x-js，Chrome/Edge 会因
 * "strict MIME checking" 拒收，页面变成无样式黑白文字。
 * 这里显式声明标准 MIME，并禁用缓存，避免旧页面被缓存。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const PORT = Number(process.argv[2] || 8765)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0])
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html'
  const rel = path.normalize(urlPath).replace(/^[/\\]+/, '')
  const file = path.join(ROOT, rel)
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Forbidden')
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Not Found: ' + urlPath)
    }
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    })
    res.end(buf)
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log('ADC 员工端工作台预览: http://127.0.0.1:' + PORT)
})
