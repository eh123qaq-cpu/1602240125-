/* 回归测试：员工端登录链路
 *
 * 网页已改成「只连云端、点身份直接登录」，这里验证三件事：
 *   1. 云端正常时，点身份用的是云端员工账号，能进工作台
 *   2. 云端连不上时，登录页给出原因，登录报错，不伪造数据
 *   3. 云端明确拒绝（业务 401）时，错误原样透出，不被当成网络故障
 *
 * 运行：node tests/web-login.js
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
let total = 0
const check = (name, ok) => {
  total++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name)
  if (ok) pass++
  else process.exitCode = 1
}

function makeEl(id) {
  const classes = new Set()
  return {
    id,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, f) => { if (f === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c) } else { f ? classes.add(c) : classes.delete(c) } }
    },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)) },
    get className() { return [...classes].join(' ') },
    innerHTML: '', textContent: '', value: '', disabled: false,
    dataset: {}, addEventListener() {}, querySelectorAll() { return [] },
    closest() { return null }, appendChild() {}
  }
}

function makeEnv(opts = {}) {
  const els = {}
  const get = (id) => els[id] || (els[id] = makeEl(id))
  get('app').classList.add('hidden')
  ;['loading', 'toast', 'banner', 'login-error'].forEach((x) => get(x).classList.add('hidden'))
  const store = {}
  const ctx = {
    console, setTimeout, clearTimeout, Promise,
    document: { getElementById: get, addEventListener() {}, querySelectorAll() { return [] } },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] }
    },
    window: { scrollTo() {} },
    location: { search: opts.search || '' }
  }
  if (opts.cloudbase) ctx.cloudbase = opts.cloudbase
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { filename: 'inline-app.js' })
  return { ctx, els, get, store }
}

// 一个够用的云端桩：记录登录参数，按 action 返回约定结果
function makeCloud(opt = {}) {
  const seen = { login: null, calls: [] }
  return {
    seen,
    init() {
      return {
        auth() {
          return {
            hasLoginState: () => false,
            signInWithPassword: () => opt.blockChannel
              ? Promise.reject(new Error('EXCEED_AUTHORITY'))
              : Promise.resolve({})
          }
        },
        callFunction(p) {
          const d = (p && p.data) || {}
          const action = d.action
          const payload = d.payload || {}
          seen.calls.push(action)
          if (action === 'meta.bootstrap') return Promise.resolve({ result: { code: 0, data: { clinics: [] } } })
          if (action === 'staff.login') {
            seen.login = payload
            if (opt.badPassword) return Promise.resolve({ result: { code: 401, msg: '账号或密码不正确' } })
            return Promise.resolve({
              result: {
                code: 0,
                data: {
                  token: 't-1',
                  staff: { name: '周晓雯', role: 'DESK', role_name: '前台', clinic_name: 'ADC 安德天河店' }
                }
              }
            })
          }
          if (action === 'staff.session') return Promise.resolve({ result: { code: 401, msg: '登录已过期' } })
          if (action === 'report.dashboard') {
            return Promise.resolve({
              result: {
                code: 0,
                data: { today: '2026-11-26', counts: { PENDING: 2, ARRIVED: 1, DONE: 0 }, today_list: [], denominator: 3 }
              }
            })
          }
          return Promise.resolve({ result: { code: 0, data: {} } })
        }
      }
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 1600))

async function run() {
  // A 云端正常：点身份 → 用云端员工账号登录 → 进入工作台
  {
    const cloud = makeCloud()
    const { ctx, get } = makeEnv({ cloudbase: cloud })
    await tick()
    check('A 启动即连云端', vm.runInContext('ONLINE === true && degraded === false', ctx))
    await vm.runInContext("doLogin('desk')", ctx)
    check('A 登录后进入工作台', get('login').classList.contains('hidden') && !get('app').classList.contains('hidden'))
    check('A 顶栏显示前台身份', get('who-name').textContent === '周晓雯' && get('role-badge').textContent === '前台')
    check('A 用的是云端员工账号', cloud.seen.login && cloud.seen.login.username === 'desk')
    check('A 密码与云端一致', cloud.seen.login && cloud.seen.login.password === vm.runInContext('STAFF_PASSWORD', ctx))
  }

  // B 云端连不上：登录页给原因，点身份报错，不伪造数据
  {
    const { ctx, get } = makeEnv({ cloudbase: { init() { return { auth() { return { hasLoginState: () => false, signInWithPassword: () => Promise.reject(new Error('network down')) } }, callFunction() { return Promise.reject(new Error('network down')) } } } } })
    await tick()
    check('B 未连上云端', vm.runInContext('ONLINE === false', ctx))
    check('B 徽标提示云端断开', /云端断开/.test(get('env-badge').textContent), get('env-badge').textContent)
    check('B 失败原因可见', get('env-badge').title.includes('云端不可用'))
    let code = 0
    try { await vm.runInContext("doLogin('desk')", ctx) } catch (e) { code = e.code }
    check('B 登录失败明确报错', code === 503, 'code=' + code)
    check('B 仍停在登录页', !get('login').classList.contains('hidden') && get('app').classList.contains('hidden'))
  }

  // C 云端拒绝密码：业务 401 原样抛，不当成断网
  {
    const cloud = makeCloud({ badPassword: true })
    const { ctx } = makeEnv({ cloudbase: cloud })
    await tick()
    let msg = ''
    let code = 0
    try { await vm.runInContext("doLogin('desk')", ctx) } catch (e) { msg = e.message; code = e.code }
    check('C 业务 401 原样透出', code === 401 && msg === '账号或密码不正确', code + ' ' + msg)
    check('C 未被判成断网', vm.runInContext('degraded === false && ONLINE === true', ctx))
  }

  // D 通道账号被拒：不宣布连上云端
  {
    const cloud = makeCloud({ blockChannel: true })
    const { ctx, get } = makeEnv({ cloudbase: cloud })
    await tick()
    check('D 通道登录失败则不宣布在线', vm.runInContext('ONLINE === false', ctx))
    check('D 原因写进徽标', get('env-badge').title.includes('云端不可用'))
    check('D 没有发起业务调用', cloud.seen.calls.length === 0, 'calls=' + cloud.seen.calls.join(','))
  }

  // E 没有 SDK：页面照样能显示身份入口
  {
    const { ctx, get } = makeEnv()
    await tick()
    check('E 未加载 SDK 时身份入口仍在', /data-user=/.test(get('id-list').innerHTML))
    check('E 说明是脚本没加载', /未加载/.test(get('login-mode').textContent), get('login-mode').textContent)
    check('E 不会退回本地假数据', vm.runInContext('typeof demoCall === "undefined"', ctx))
  }

  console.log('\n' + pass + ' PASS / ' + (total - pass) + ' FAIL')
}

run().catch((e) => { console.error('测试异常：', e); process.exitCode = 1 })
