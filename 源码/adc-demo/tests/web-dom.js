/* 静态结构一致性检查（不需要浏览器，也不需要联网）
 *
 * 起因：菜单里的「员工账号」长期没有对应的 <section id="view-staff">，
 * 经理点进去时 page 直接抛错、整页白屏；而 jsdom / DOM 桩会自动造元素，
 * 功能测试反而全绿。所以这里不渲染页面，只比对静态结构。
 *
 * 检查项：
 *   1. VIEWS 里的每个视图，index.html 都有 view-<id> 容器和 body-<id> 挂载点
 *   2. ROLE_MENU 里出现的视图 id 都在 VIEWS 里
 *   3. index.html 内联的 JS / CSS 与 app.js / style.css 一致（build 没有过期）
 *   4. 每个 data-act 都有对应的 case 分支，不存在点了没反应的按钮
 *
 * 运行：node tests/web-dom.js
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'web', 'style.css'), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok && detail ? ' · ' + detail : ''))
  ok ? pass++ : fail++
}

// ---- 1. 视图容器 ----
const viewsBlock = (js.match(/const VIEWS = \[([\s\S]*?)\n\]/) || [])[1] || ''
const views = [...viewsBlock.matchAll(/\{ id: '([a-z]+)', name: '([^']+)' \}/g)]
  .map((m) => ({ id: m[1], name: m[2] }))
check('VIEWS 解析出视图清单', views.length >= 12, views.length + ' 个')

for (const v of views) {
  check('容器 view-' + v.id, html.includes('id="view-' + v.id + '"'), v.name)
  check('挂载点 body-' + v.id, html.includes('id="body-' + v.id + '"'))
}

// 反向：HTML 里不该有已经废弃的容器
const htmlViews = [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1])
const orphan = htmlViews.filter((id) => !views.some((v) => v.id === id))
check('没有多余的视图容器', orphan.length === 0, orphan.join(',') || '无')

// ---- 2. 角色菜单 ----
const menuBlock = (js.match(/const ROLE_MENU = \{([\s\S]*?)\n\}/) || [])[1] || ''
const menuIds = [...menuBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
const unknown = [...new Set(menuIds)].filter((id) => !views.some((v) => v.id === id))
check('角色菜单里的视图都存在', unknown.length === 0, unknown.join(',') || '无')

// ---- 3. 单文件构建是否最新 ----
const inlineJs = (html.match(/\/\* INLINE_JS_START \*\/([\s\S]*?)\/\* INLINE_JS_END \*\//) || [])[1]
const inlineCss = (html.match(/\/\* INLINE_CSS_START \*\/([\s\S]*?)\/\* INLINE_CSS_END \*\//) || [])[1]
check('index.html 内联脚本与 app.js 一致', inlineJs !== undefined && inlineJs.trim() === js.trim(),
  inlineJs === undefined ? '未找到内联标记' : '不一致时先跑 node web/build.js')
check('index.html 内联样式与 style.css 一致', inlineCss !== undefined && inlineCss.trim() === css.trim())

// ---- 4. 按钮动作都有处理分支 ----
const acts = [...new Set([...(js + html).matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]))]
const cases = new Set([...js.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))
const dead = acts.filter((a) => !cases.has(a))
check('data-act 都有对应分支', dead.length === 0, dead.join(',') || acts.length + ' 个动作全有处理')

// ---- 5. 启动必需的元素 id ----
const required = ['login', 'app', 'id-list', 'login-mode', 'env-badge', 'banner', 'toast', 'loading', 'nav', 'side-user']
const missing = required.filter((id) => !html.includes('id="' + id + '"'))
check('启动必需的元素齐全', missing.length === 0, missing.join(',') || required.length + ' 个都在')

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail ? 1 : 0)
