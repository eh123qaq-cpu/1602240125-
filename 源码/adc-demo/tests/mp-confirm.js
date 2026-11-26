/**
 * 二次确认回归测试（Node 直接跑，不需要微信开发者工具 / 浏览器）
 *
 * 覆盖用户反馈的「预约没有确认的地方」以及同类缺口：
 *   1. 预约：点「核对并确认预约」只弹核对层，绝不调用 appointment.create
 *   2. 预约：「返回修改」关闭核对层且不提交；「确认提交」才写入
 *   3. 核对层展示门店 / 日期 / 时段 / 牙医 / 备注 / 预约人
 *   4. 改约：提交前弹「确认改约」，取消确认不写入
 *   5. 网页端：不可逆写操作在确认被拒时不执行
 *
 * 运行：node tests/mp-confirm.js
 */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS  ' + name + (extra ? ' · ' + extra : '')); pass++ }
  else { console.log('FAIL  ' + name); fail++ }
}

const F = {
  ymd: () => '2026-11-25',
  dateStrip: () => [],
  dayLabel: () => '今天',
  monthDay: () => '11月25日',
  weekday: () => '周三',
  maskPhone: () => '138****0000'
}

/* ---------------------- 加载小程序页面（带 wx / require 桩） ---------------------- */

function loadPage(relPath) {
  const calls = []
  const modals = []
  const pending = []
  const page = {}

  const sandbox = {
    Page(o) { Object.assign(page, o) },
    require(p) {
      if (p.includes('utils/api')) {
        return {
          call: async (action, payload) => { calls.push({ action, payload }); return {} },
          toast: () => {}
        }
      }
      if (p.includes('utils/auth')) {
        return { guard: async () => true, getSession: async () => ({ patient: { name: '林小雅', phone: '13800000000' } }) }
      }
      if (p.includes('utils/tab')) return () => {}
      if (p.includes('utils/format')) return F
      if (p.includes('config')) return { bookingDays: 14, subscribeReminderTmpl: '', version: '1.2.0' }
      throw new Error('unexpected require: ' + p)
    },
    wx: {
      showModal(o) { modals.push(o); if (o.success) pending.push(o.success) },
      showToast() {},
      switchTab() {},
      navigateBack() {},
      getStorageSync() { return '' },
      setStorageSync() {},
      removeStorageSync() {},
      requestSubscribeMessage() {},
      stopPullDownRefresh() {}
    },
    console, Promise, Date, Math, Number, String, Array, Object, JSON, Error,
    setTimeout, clearTimeout
  }
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), sandbox)
  page.data = JSON.parse(JSON.stringify(page.data))
  page.setData = function (o) { Object.assign(this.data, o) }
  return {
    page, calls, modals,
    // 真机上 showModal 等用户点击后才回调；测试里显式模拟点击
    resolveLast: (v) => { const fn = pending.shift(); if (fn) fn({ confirm: v, cancel: !v }) }
  }
}

/* ---------------------- 1. 预约页 ---------------------- */

async function bookingTests() {
  const { page, calls, modals } = loadPage('miniprogram/pages/booking/index.js')
  page.setData({
    ready: true,
    patient: { name: '林小雅', phoneMasked: '138****0000' },
    clinics: [{ _id: 'c1', name: '天河演示门店', short_name: '天河店' }],
    clinicIndex: 0,
    activeDate: '2026-11-25',
    dates: [],
    groups: [],
    dentistIndex: 0,
    morning: [], afternoon: [],
    treatments: [], needIndex: -1, needText: '洗牙', special: '怕疼',
    loadingSlots: false, submitting: false, slotTotal: 0,
    confirming: false, confirmInfo: null,
    selected: null
  })

  page.submit()
  ok('未选时段时不弹核对层', page.data.confirming === false)
  ok('未选时段时不提交', calls.length === 0)

  page.setData({
    selected: { start: '10:00', period: '上午', dentistId: 'd1', dentistName: '陈医生', title: '主治医师', qualNames: [] }
  })
  page.submit()
  ok('已选时段时弹出核对层', page.data.confirming === true)
  ok('核对阶段绝不调用 appointment.create', !calls.some((c) => c.action === 'appointment.create'))

  const info = page.data.confirmInfo || {}
  ok('核对层含门店', info.clinicName === '天河店')
  ok('核对层含日期', /11月25日/.test(info.dateText || '') && /周三/.test(info.dateText || ''))
  ok('核对层含时段与牙医', /10:00/.test(info.timeText || '') && /陈医生/.test(info.dentistText || ''))
  ok('核对层含备注与预约人', info.needText === '洗牙' && info.specialText === '怕疼' && /林小雅/.test(info.patientText || ''))

  page.closeConfirm()
  ok('返回修改关闭核对层', page.data.confirming === false)
  ok('返回修改不提交', calls.length === 0)

  await page.confirmSubmit()
  const created = calls.find((c) => c.action === 'appointment.create')
  ok('确认提交才写入 appointment.create', !!created)
  ok('提交参数与核对内容一致', created && created.payload.clinicId === 'c1' && created.payload.dentistId === 'd1' && created.payload.date === '2026-11-25' && created.payload.start === '10:00' && created.payload.need === '洗牙' && created.payload.special_need === '怕疼')
  ok('提交成功后核对层关闭', page.data.confirming === false)
  ok('提交成功后弹出「预约成功」', modals.some((m) => m.title === '预约成功'))
  ok('重复确认不会二次提交', (() => { const n = calls.length; page.confirmSubmit(); return calls.length === n })())
}

/* ---------------------- 2. 改约页 ---------------------- */

async function rescheduleTests() {
  const { page, calls, modals, resolveLast } = loadPage('miniprogram/pages/reschedule/index.js')
  page.setData({
    target: {
      _id: 'a1', date: '2026-11-20', start: '09:00', dateText: '11月20日', weekText: '周五',
      clinic_id: 'c1', clinic_name: '天河店', dentist_id: 'd1', dentist_name: '陈医生'
    },
    activeDate: '2026-11-25',
    selected: { start: '14:00', dentistId: 'd1', dentistName: '陈医生' },
    submitting: false, loading: false, groups: [], slots: []
  })

  const tick = () => new Promise((r) => setTimeout(r, 0))

  page.submit()
  ok('改约先弹「确认改约」', modals.some((m) => m.title === '确认改约'))
  ok('改约核对阶段不写入', !calls.some((c) => c.action === 'appointment.rescheduleSelf'))

  resolveLast(false)
  await tick()
  ok('改约取消确认后不写入', !calls.some((c) => c.action === 'appointment.rescheduleSelf'))

  page.submit()
  resolveLast(true)
  await tick()
  const changed = calls.find((c) => c.action === 'appointment.rescheduleSelf')
  ok('改约确认后才写入', !!changed)
  ok('改约参数正确', changed && changed.payload.appointmentId === 'a1' && changed.payload.start === '14:00' && changed.payload.dentistId === 'd1')
}

/* ---------------------- 3. 网页端确认 ---------------------- */

function loadWeb(confirmFn) {
  const code = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8')
  const mkEl = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    innerHTML: '', textContent: '', value: '', disabled: false,
    dataset: {}, addEventListener() {}, querySelectorAll() { return [] },
    closest() { return null }, onchange: null, oninput: null
  })
  const els = {}
  const document = {
    getElementById(id) { return els[id] || (els[id] = mkEl()) },
    addEventListener() {}, querySelectorAll() { return [] }
  }
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Date, Math, Number, String,
    Array, Object, JSON, RegExp, Error, document,
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    window: { scrollTo() {} },
    confirm: confirmFn
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  return (expr) => vm.runInContext(expr, ctx)
}

async function webTests() {
  // 网页端没有本地数据：取消必须真正发到云端；无权限角色（牙医）在发请求前就被拦住。
  for (const [role, expect] of [['MANAGER', true], ['DENTIST', false]]) {
    const run = loadWeb()
    run(`state.staff = { name: '测试', role: '${role}', role_name: '${role}' }; __calls = []; api = async (a) => { __calls.push(a); return {} }`)
    await run('act({ dataset: { act: "cancel", id: "a1" } })')
    await new Promise((r) => setTimeout(r, 20))
    const n = run('__calls.length')
    ok('网页端' + role + (expect ? '取消调用云端' : '不能取消预约'), expect ? n === 1 : n === 0, 'calls=' + n)
  }
}

/* ---------------------- 4. 布局：底部栏与弹层不能被自定义 tabBar 盖住 ---------------------- */

function layoutTests() {
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/booking/index.wxss'), 'utf8')
  const tabWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/custom-tab-bar/index.wxss'), 'utf8')

  // tabBar 是 bottom:0 + z-index:100 的固定层，任何贴底元素都会被它盖住
  ok('tabBar 是 fixed 定位且高 106rpx', /position:\s*fixed/.test(tabWxss) && /height:\s*calc\(106rpx/.test(tabWxss))

  const bar = (/\.fixed-bar\s*\{[^}]*\}/.exec(wxss) || [''])[0]
  ok('预约页底部栏让出 tabBar 高度', /bottom:\s*calc\(106rpx \+ env\(safe-area-inset-bottom\)\)/.test(bar))
  ok('预约页底部栏不再贴底', !/bottom:\s*0\s*;/.test(bar))

  const mask = (/\.mask\s*\{[^}]*\}/.exec(wxss) || [''])[0]
  ok('核对弹层也让出 tabBar 高度', /bottom:\s*calc\(106rpx \+ env\(safe-area-inset-bottom\)\)/.test(mask))
  ok('核对弹层层级高于 tabBar', /z-index:\s*300/.test(mask))
}

/* ---------------------- 执行 ---------------------- */

;(async () => {
  layoutTests()
  await bookingTests()
  await rescheduleTests()
  await webTests()
  console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
  if (fail) process.exit(1)
})().catch((e) => { console.error('ERROR ' + e.stack); process.exit(1) })
