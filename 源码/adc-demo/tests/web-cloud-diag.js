/* 无需真实浏览器，复现「浏览器打开 ?diag=1 会看到什么」。
 *
 * 做法：在 Node 里补齐浏览器全局 → 加载页面内联的同一份 CloudBase SDK →
 * 在 vm 沙箱里执行页面内联的 app.js（DOM 用桩）→ 读取自检面板的真实输出。
 * 本环境无头浏览器被禁用，这是唯一能自动确认浏览器侧状态的路径。
 *
 * 需要联网 + 云环境可用；不作为常规离线回归。
 * 运行：node tests/web-cloud-diag.js
 */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const root = path.join(__dirname, '..', 'web')
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8')

// SDK 是 UMD，require 时闭包捕获主上下文全局；先补齐浏览器全局，
// 让它以为自己运行在真实页面里（否则会报 window is not defined）。
global.window = global
global.self = global
global.document = {
  cookie: '', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  addEventListener() {}, removeEventListener() {},
  head: { appendChild() {} }, body: { appendChild() {} },
  getElementsByTagName: () => [], querySelector: () => null
}
global.location = {
  href: 'https://patient-damselfly-d3di6275acf229-1540280749.tcloudbaseapp.com/?diag=1',
  origin: 'https://patient-damselfly-d3di6275acf229-1540280749.tcloudbaseapp.com',
  protocol: 'https:', hostname: 'patient-damselfly-d3di6275acf229-1540280749.tcloudbaseapp.com'
}
global.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
const _store = {}
global.localStorage = { getItem: k => (k in _store ? _store[k] : null), setItem: (k, v) => (_store[k] = String(v)), removeItem: k => delete _store[k] }

const tcb = require(path.join(root, 'vendor/cloudbase.full.js'))
const cloudbase = (tcb && tcb.default) || tcb

// ---- DOM 桩 ----
const els = {}
function mk(id) {
  const s = new Set()
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, dataset: {},
    classList: {
      add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle: (c, f) => { if (f === undefined) { s.has(c) ? s.delete(c) : s.add(c) } else { f ? s.add(c) : s.delete(c) } }
    },
    set className(v) { s.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => s.add(x)) },
    get className() { return [...s].join(' ') },
    addEventListener() {}, querySelectorAll() { return [] }, querySelector() { return null },
    appendChild() {}, remove() { el._removed = true }, closest() { return null }
  }
  return el
}
const doc = {
  getElementById(id) {
    if (id === 'diag-panel' && !els[id]) return null   // 让 runDiag 走 createElement 分支
    return els[id] || (els[id] = mk(id))
  },
  createElement() { return mk('') },
  addEventListener() {}, querySelectorAll() { return [] },
  body: { appendChild(el) { els[el.id] = el } }
}
const store = {}
const ctx = {
  console, setTimeout, clearTimeout, Promise, Date, Math, Number, String, Array, Object,
  JSON, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  document: doc, cloudbase,
  location: {
    search: '?diag=1',
    href: 'https://patient-damselfly-d3di6275acf229-1540280749.tcloudbaseapp.com/?diag=1'
  },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: k => delete store[k] },
  window: { scrollTo() {} }
}
vm.createContext(ctx)
vm.runInContext(appJs, ctx, { filename: 'inline-app.js' })

;(async () => {
  const deadline = Date.now() + 60000
  let html = ''
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400))
    html = (els['diag-panel'] && els['diag-panel'].innerHTML) || ''
    if (/✅ 云端已连接|❌ 未连通|SDK 未加载|初始化失败|通道登录失败|云函数不通|员工登录失败/.test(html)) break
  }
  const clean = html.replace(/<[^>]+>/g, '|').replace(/\|+/g, ' | ').trim()
  console.log('===== 自检面板输出（模拟浏览器） =====')
  console.log(clean.slice(0, 1400))
  console.log('\n===== 状态 =====')
  const online = vm.runInContext('ONLINE', ctx)
  const degraded = vm.runInContext('degraded', ctx)
  const cloudErr = vm.runInContext('cloudErr', ctx)
  const steps = (html.match(/diag-ok/g) || []).length
  console.log('ONLINE =', online, '| degraded =', degraded, '| cloudErr =', JSON.stringify(cloudErr))
  console.log('通过步骤 =', steps, '/ 6')
  console.log('顶栏徽标文案 =', online && !degraded ? '云端已连接' : '云端断开 · 重连')

  const pass = online === true && degraded === false && /✅ 云端已连接/.test(html) && steps >= 6
  console.log('\n' + (pass ? 'PASS —— 浏览器内会显示「云端已连接」' : 'FAIL —— 详见上方输出'))
  process.exit(pass ? 0 : 1)
})()
