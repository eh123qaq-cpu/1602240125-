/* 单文件页面完整性回归：确认 index.html 真的把 CSS / SDK / app.js 都内联了，
 * 且与源文件一致、语法可执行、没有残留外链。
 *
 * 运行：node tests/web-selftest.js
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..', 'web')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' → ' + extra : '')) }
}

const html = read('index.html')
const css = read('style.css').trim()
const js = read('app.js').trim()
const sdk = read('vendor/cloudbase.full.js').trim()

// 内联块 = <script>/<style> 内容里，START 与 END 标记之间的部分
const block = (re, start, end) => {
  const m = html.match(re)
  if (!m) return null
  const s = m[1]
  const a = s.indexOf(start)
  const b = s.lastIndexOf(end)
  if (a < 0 || b < 0 || b <= a) return null
  return s.slice(a + start.length, b).trim()
}
const cssBlock = block(/<style id="app-css">([\s\S]*?)<\/style>/,
  '/* INLINE_CSS_START */', '/* INLINE_CSS_END */')
const sdkBlock = block(/<script id="cb-sdk">([\s\S]*?)<\/script>/,
  '/* INLINE_SDK_START */', '/* INLINE_SDK_END */')
const jsBlock = block(/<script id="app-js">([\s\S]*?)<\/script>/,
  '/* INLINE_JS_START */', '/* INLINE_JS_END */')

check('app-css 内联块存在', !!cssBlock)
check('cb-sdk 内联块存在', !!sdkBlock)
check('app-js 内联块存在', !!jsBlock)
check('CSS 与 style.css 一致', cssBlock === css,
  cssBlock ? cssBlock.length + ' vs ' + css.length : 'missing')
check('SDK 与 vendor/cloudbase.full.js 一致', sdkBlock === sdk,
  sdkBlock ? sdkBlock.length + ' vs ' + sdk.length : 'missing')
check('app.js 与源文件一致', jsBlock === js,
  jsBlock ? jsBlock.length + ' vs ' + js.length : 'missing')
check('无残留外链 CloudBase CDN 脚本',
  !/<script[^>]+src="https:\/\/static\.cloudbase\.net/.test(html))
check('无残留外链 style.css / app.js',
  !/<link[^>]+stylesheet/.test(html) && !/<script[^>]+src="app\.js"/.test(html))
check('页面完全自包含（HTML > 900KB）', Buffer.byteLength(html) > 900000,
  Buffer.byteLength(html) + 'B')

// 内联进页面的脚本必须能被 JS 引擎解析（不是只看字符串存在）
for (const [name, code] of [['SDK', sdkBlock], ['app.js', jsBlock]]) {
  if (!code) { check(name + ' 语法可执行', false, '内联块缺失'); continue }
  let ok = true, err = ''
  try { new vm.Script(code, { filename: name }) } catch (e) { ok = false; err = e.message }
  check(name + ' 语法可执行', ok, err)
}

check('SDK 是 3.5.0 完整版（含 signInWithPassword）', sdk.includes('signInWithPassword'))
check('页面只连云端（无演示开关）', !js.includes('cloudByDefault') && js.includes('IDENTITIES'))
check('通道账号登录方式存在', js.includes('signInWithPassword'))
check('云端探活存在', js.includes('探活返回'))
check('自检面板 runDiag 存在', js.includes('function runDiag'))
check('自检 6 个步骤齐全', (js.match(/const s[1-6] = await step/g) || []).length === 6)
check('失败原因在登录页可见', js.includes('云端未连通'))
check('diag 样式已内联', css.includes('.diag-summary.ok'))

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail ? 1 : 0)
