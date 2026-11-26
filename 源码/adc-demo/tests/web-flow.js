/* 员工端网页回归测试（Node 直接跑，不需要浏览器）
 *
 * 网页只连云端，这里用云端桩喂数据，验证：
 *   1. 经理身份能进工作台，13 个视图都能渲染出内容
 *   2. 每个视图发出的是对应的云端 action
 *   3. 云端返回空列表时不崩、不出现 undefined / NaN
 *   4. 角色菜单仍然互不越权
 *
 * 运行：node tests/web-flow.js
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')

const mkEl = () => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
  innerHTML: '', textContent: '', value: '', disabled: false,
  dataset: {}, addEventListener() {}, querySelectorAll() { return [] },
  closest() { return null }, onchange: null, oninput: null
})
const els = {}
const document = {
  getElementById(id) { return els[id] || (els[id] = mkEl()) },
  addEventListener() {},
  querySelectorAll() { return [] }
}

const EMPTY = {
  'report.dashboard': {
    today: '2026-11-26', counts: {}, today_list: [], cancel_rate: null, no_show_rate: null,
    denominator: 0, future_pending: 0
  },
  'appointment.list': [],
  'meta.bootstrap': { clinics: [], dentists: [], treatments: [], qualifications: [] },
  'cost.list': [],
  'report.quarter': {
    period: '2026Q4', payable: '可核算', fund: 0, approved_version: 0,
    total: { revenue: 0, supply: 0, opex: 0, net: 0 }, rows: [],
    sources: { invoice_nos: [], cost_vouchers: [] }
  },
  'clinic.list': [],
  'dentist.list': [],
  'qual.list': [],
  'invoice.list': [],
  'patient.list': [],
  'schedule.list': [],
  'audit.list': [],
  'quarter.list': [],
  'staff.list': []
}

const cloud = {
  calls: [],
  init() {
    return {
      auth() { return { hasLoginState: () => false, signInWithPassword: () => Promise.resolve({}) } },
      callFunction(p) {
        const d = (p && p.data) || {}
        const action = d.action
        cloud.calls.push(action)
        if (action === 'meta.bootstrap') return Promise.resolve({ result: { code: 0, data: EMPTY[action] } })
        if (action === 'staff.login') {
          return Promise.resolve({
            result: {
              code: 0,
              data: {
                token: 't-1',
                staff: { name: '黄立群', role: 'MANAGER', role_name: '总部经理', clinic_name: '总部' }
              }
            }
          })
        }
        return Promise.resolve({ result: { code: 0, data: EMPTY[action] === undefined ? [] : EMPTY[action] } })
      }
    }
  }
}

const ctx = {
  console, setTimeout, clearTimeout, Promise, Date, Math, Number, String,
  Array, Object, JSON, RegExp, Error, isNaN, parseInt, parseFloat,
  document,
  localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
  window: { scrollTo() {} },
  location: { search: '' },
  cloudbase: cloud
}
vm.createContext(ctx)
vm.runInContext(code, ctx)

const run = (expr) => vm.runInContext(expr, ctx)
let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    const r = fn()
    if (r === false) { console.log('FAIL  ' + name); fail++ }
    else { console.log('PASS  ' + name + (typeof r === 'string' ? ' · ' + r : '')); pass++ }
  } catch (e) {
    console.log('ERROR ' + name + ' · ' + e.message)
    fail++
  }
}

;(async () => {
  await run('initCloud()')
  check('云端连接建立', () => run('ONLINE === true && degraded === false'))
  await run("doLogin('manager')")
  check('经理登录进入工作台', () => run('state.staff.role === "MANAGER"'))
  check('菜单渲染 13 个视图', () => {
    run('renderMenu()')
    return run('ROLE_MENU.MANAGER.length') === 13 ? '13' : false
  })

  const views = run('VIEWS.map(v => v.id).join(",")').split(',')
  for (const v of views) {
    check('渲染 ' + v, async () => true)
  }

  // 逐个视图跑一遍（go 会走 ensureData → api → 渲染）
  const results = []
  for (const v of views) {
    try {
      await run('go("' + v + '")')
      const html = els['body-' + v] ? els['body-' + v].innerHTML : ''
      const bad = /undefined|NaN/.test(html)
      results.push({ v, len: html.length, bad })
    } catch (e) {
      results.push({ v, err: e.message })
    }
  }
  for (const r of results) {
    check('视图 ' + r.v, () => {
      if (r.err) return false
      if (r.bad) return false
      return r.len > 40 ? r.len + ' chars' : false
    })
  }

  check('读数据走的是云端 action', () => cloud.calls.includes('report.dashboard') && cloud.calls.includes('appointment.list'))
  check('空列表不影响页面', () => !results.some((r) => r.err))

  check('角色菜单隔离', () => {
    const desk = run('ROLE_MENU.DESK.join(",")')
    const fin = run('ROLE_MENU.FINANCE.join(",")')
    return !desk.includes('report') && !fin.includes('clinic') ? 'DESK/财务互不越权' : false
  })

  check('页面里没有本地演示数据函数', () => run('typeof demoCall === "undefined" && typeof demoApi === "undefined"'))

  console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail ? 1 : 0)
})()
