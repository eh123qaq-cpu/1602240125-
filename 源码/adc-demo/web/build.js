/* 把 style.css、app.js 与 CloudBase Web SDK 同步进 index.html，生成完全自包含的单文件页面。
 *
 * 为什么内联：
 *  1) Windows 下部分静态服务把 .css / .js 返回成 application/x-css / application/x-js，
 *     Chrome/Edge 按严格 MIME 检查会拒收，页面退化成无样式黑白文字。
 *  2) 外部 CDN 脚本可能受校园网 / 现场网络策略拦截，导致云端模式静默降级；
 *     把 SDK 内联后页面零外部依赖，双击 index.html（file://）也能完整运行。
 *
 * 标记用 /* *\/ 而不是 <!-- -->：HTML 解析器在 <script> 内遇到 <!-- 会进入
 * escaped 状态，属于无谓风险；CSS / JS 注释最安全。
 *
 * 源文件：web/style.css、web/app.js、web/vendor/cloudbase.full.js
 * 改完运行：node web/build.js
 */
const fs = require('fs')
const path = require('path')

const dir = __dirname
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')
let html = read('index.html')
const css = read('style.css').trim()
const js = read('app.js').trim()
const sdk = read('vendor/cloudbase.full.js').trim()

const CSS_START = '/* INLINE_CSS_START */'
const CSS_END = '/* INLINE_CSS_END */'
const JS_START = '/* INLINE_JS_START */'
const JS_END = '/* INLINE_JS_END */'
const SDK_START = '/* INLINE_SDK_START */'
const SDK_END = '/* INLINE_SDK_END */'

// 兼容早期版本写在 index.html 里的 HTML 注释标记
const legacy = [
  ['<!-- INLINE_CSS_START -->', CSS_START],
  ['<!-- INLINE_CSS_END -->', CSS_END],
  ['<!-- INLINE_JS_START -->', JS_START],
  ['<!-- INLINE_JS_END -->', JS_END]
]
for (const [from, to] of legacy) html = html.split(from).join(to)

// 兼容早期版本的外链 SDK 标签
html = html.replace(
  /<script src="https:\/\/static\.cloudbase\.net\/cloudbase-js-sdk\/[^"]+"><\/script>/,
  '<script id="cb-sdk">\n' + SDK_START + '\n' + SDK_END + '\n</script>'
)

if (css.includes('</style')) {
  console.error('style.css 含 </style，内联会破坏 HTML')
  process.exit(1)
}
for (const [name, text] of [['app.js', js], ['cloudbase.full.js', sdk]]) {
  if (/<\/script/i.test(text)) {
    console.error(name + ' 含 </script，内联会破坏 HTML')
    process.exit(1)
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function inject(source, start, end, content, label) {
  const re = new RegExp(esc(start) + '[\\s\\S]*?' + esc(end))
  if (!re.test(source)) {
    console.error('未找到 ' + label + ' 内联标记，请检查 index.html')
    process.exit(1)
  }
  // 用函数形式替换，避免内容里的 $& / $' 被当成替换模式
  return source.replace(re, () => start + '\n' + content + '\n' + end)
}

html = inject(html, CSS_START, CSS_END, css, 'CSS')
html = inject(html, SDK_START, SDK_END, sdk, 'SDK')
html = inject(html, JS_START, JS_END, js, 'JS')
fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8')
console.log('已同步 index.html：CSS ' + css.length + ' 字节，SDK ' + sdk.length +
  ' 字节，JS ' + js.length + ' 字节，合计 ' + Buffer.byteLength(html) + ' 字节')
