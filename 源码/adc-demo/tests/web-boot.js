/* 回归测试：web/index.html 内联脚本启动流程
 *
 * 覆盖用户反馈过的「打开后没有登录按钮」：
 * 演示模式下浏览器可能残留上次的登录 token，若不复位会直接跳进工作台，
 * 登录页被隐藏。这里预置残留登录态，验证 boot() 后一定回到登录页。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8')
const match = html.match(/<script id="app-js">([\s\S]*?)<\/script>/)
if (!match) throw new Error('index.html 中未找到内联脚本 <script id="app-js">')
const code = match[1]

let pass = 0
const check = (name, ok) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name)
  if (ok) pass++
  else process.exitCode = 1
}

function makeEl(id) {
  const classes = new Set()
  return {
    id,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c)
        else force ? classes.add(c) : classes.delete(c)
      },
      _set: (c) => classes.add(c),
      _has: (c) => classes.has(c)
    },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)) },
    get className() { return [...classes].join(' ') },
    innerHTML: '', textContent: '', value: '', disabled: false,
    dataset: {}, addEventListener() {}, querySelectorAll() { return [] },
    closest() { return null }, appendChild() {}, scrollTo() {}
  }
}

const els = {}
const getEl = (id) => els[id] || (els[id] = makeEl(id))
// 静态 HTML 的初始状态
getEl('app').classList._set('hidden')
getEl('loading').classList._set('hidden')
getEl('toast').classList._set('hidden')
getEl('banner').classList._set('hidden')

const store = {
  adc_staff_token: 'stale-token',
  adc_demo_staff: JSON.stringify({ name: '残留账号', role: 'MANAGER', role_name: '总部经理', clinic_name: '总部' })
}
const localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null },
  setItem(k, v) { store[k] = String(v) },
  removeItem(k) { delete store[k] }
}

const ctx = {
  console, setTimeout, clearTimeout, Promise,
  document: {
    getElementById: getEl,
    addEventListener() {},
    querySelectorAll() { return [] }
  },
  localStorage,
  window: { scrollTo() {} }
  // 故意不提供 cloudbase：模拟 SDK 未加载 / 匿名登录未配置 → 演示模式
}
vm.createContext(ctx)
vm.runInContext(code, ctx, { filename: 'inline-app.js' })

setTimeout(() => {
  const login = getEl('login')
  const app = getEl('app')
  check('启动后登录页可见', !login.classList._has('hidden'))
  check('启动后工作台隐藏', app.classList._has('hidden'))
  check('残留 token 已清除', localStorage.getItem('adc_staff_token') === null)
  check('旧演示身份缓存已清除', localStorage.getItem('adc_demo_staff') === null)
  const list = getEl('id-list').innerHTML
  check('身份入口渲染 8 个', (list.match(/data-user=/g) || []).length === 8)
  check('三位牙医都在入口里', (list.match(/data-user="dentist/g) || []).length === 3)
  check('身份入口带员工姓名与角色', list.includes('黄立群') && list.includes('总部经理'))
  check('登录页说明当前连不上云端', /云端未连通/.test(getEl('login-mode').textContent), getEl('login-mode').textContent)
  console.log('\n' + pass + ' PASS / ' + (8 - pass) + ' FAIL')
}, 1600)
