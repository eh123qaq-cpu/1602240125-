/**
 * 本地冒烟测试 —— 不连云开发，用内存桩跑通核心链路
 *
 * 运行：在 adc-demo 目录下执行  node tests/smoke.js
 * 覆盖：UC02 / UC03 / UC04 / UC05 / UC06 / UC10 / UC11
 *       T02 抢号  T03 取消率分母  T05 两行治疗320  T06 幂等+价格快照  T08 待分摊  T09 核算口径
 *
 * 说明：node_modules/wx-server-sdk 是本地测试桩，只实现用到的接口，
 *      部署云函数时不会上传，也不影响云端运行。
 */
const Module = require('module')
const path0 = require('path')
// 云函数里的 require('wx-server-sdk') 指向本地内存桩，不依赖 node_modules
const STUB_SDK = path0.join(__dirname, 'stub', 'wx-server-sdk', 'index.js')
const _resolve = Module._resolveFilename
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return STUB_SDK
  return _resolve.call(this, req, ...rest)
}

const initData = require(path0.join(__dirname, '..', 'cloudfunctions', 'initData', 'index.js'))
const seedStaff = require(path0.join(__dirname, '..', 'cloudfunctions', 'seedStaff', 'index.js'))
const api = require(path0.join(__dirname, '..', 'cloudfunctions', 'api', 'index.js'))

// 员工端 action 由云函数入口统一校验 staff token，本地测试需先登录一个 manager
let staffToken = ''
const call = async (action, payload = {}) => {
  const r = await api.main({ action, payload: { ...payload, __token: staffToken } })
  if (r.code !== 0) throw new Error(`[${action}] ${r.msg}`)
  return r.data
}
const ok = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`)
  if (!cond) process.exitCode = 1
}

;(async () => {
  const seed = await initData.main()
  console.log('seed:', JSON.stringify(seed.data))

  // 灌入员工账号并登录，取得覆盖全部角色权限的 token
  const sf = await seedStaff.main({ __seedKey: 'adc-seed-7f3c9d21b8e4' })
  if (sf.code !== 0) throw new Error('seedStaff: ' + sf.msg)
  const login = await api.main({ action: 'staff.login', payload: { username: 'manager', password: 'Adc@Staff2026!Q4' } })
  if (login.code !== 0) throw new Error('staff.login: ' + login.msg)
  staffToken = login.data.token
  console.log('staff login:', login.data.staff.role)

  const meta = await call('meta.bootstrap')
  ok('门店/牙医/项目已载入', meta.clinics.length === 2 && meta.dentists.length === 3 && meta.treatments.length === 7,
     { c: meta.clinics.length, d: meta.dentists.length, t: meta.treatments.length })

  const today = seed.data.today
  const tomorrow = (() => {
    const d = new Date(seed.data.today + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  // 今天门诊时间已过就改约明天，避免测试依赖运行时刻
  let bookDate = today
  let groups = await call('appointment.availableSlots', { clinicId: meta.clinics[0]._id, date: today })
  if (!groups.some((g) => g.slots.length)) {
    bookDate = tomorrow
    groups = await call('appointment.availableSlots', { clinicId: meta.clinics[0]._id, date: bookDate })
  }
  const free = groups.filter((g) => g.slots.length)
  ok('可约时段返回且排除已占用时段', groups.length === 2 && free.length > 0,
     groups.map((g) => `${g.dentist_name}:${g.slots.length}`))
  const pick = free[0]
  const start = pick.slots[0].start

  // T05：只约洗牙，到诊后加影像
  const ap = await call('appointment.create', {
    clinicId: meta.clinics[0]._id, dentistId: pick.dentist_id, date: bookDate, start,
    need: '洗牙', name: '林小雅', phone: '13800000001'
  })
  ok('UC02 预约成功', !!ap.appointment_id, `${ap.date} ${ap.start}`)

  // T02：同一时段再抢一次
  let conflict = false
  try { await call('appointment.create', { clinicId: meta.clinics[0]._id, dentistId: pick.dentist_id, date: bookDate, start, name: '张家明', phone: '13800000002' }) }
  catch (e) { conflict = /占用/.test(e.message) }
  ok('T02 同一时段第二笔被拒', conflict)

  // 新校验：过去日期、非门诊格、牙医不在该店
  let pastBlocked = false
  try { await call('appointment.create', { clinicId: meta.clinics[0]._id, dentistId: pick.dentist_id, date: '2020-01-01', start: '10:00', name: '测试', phone: '13900000001' }) }
  catch (e) { pastBlocked = /过去/.test(e.message) }
  ok('不能预约过去的日期', pastBlocked)

  let badSlot = false
  try { await call('appointment.create', { clinicId: meta.clinics[0]._id, dentistId: pick.dentist_id, date: bookDate, start: '03:00', name: '测试', phone: '13900000001' }) }
  catch (e) { badSlot = /门诊时段/.test(e.message) }
  ok('非门诊时段被拒绝', badSlot)

  const otherClinicDentist = meta.dentists.find((d) => !(d.clinic_ids || []).includes(meta.clinics[0]._id))
  let wrongClinic = false
  if (otherClinicDentist) {
    try { await call('appointment.create', { clinicId: meta.clinics[0]._id, dentistId: otherClinicDentist._id, date: bookDate, start, name: '测试', phone: '13900000001' }) }
    catch (e) { wrongClinic = /不在所选门店/.test(e.message) }
  }
  ok('牙医不在该门店出诊被拒', wrongClinic)

  // 到诊只能用今天的预约，不能用明天的预约提前登记
  const todays = await call('appointment.list', { date: today })
  const pendingToday = todays.find((a) => a.status === 'PENDING')
  const v = await call('visit.checkin', { appointmentId: pendingToday._id })
  ok('UC04 到诊生成就诊记录', !!v.visit_no, v.visit_no)

  let earlyCheckin = false
  try { await call('visit.checkin', { appointmentId: ap.appointment_id }) }
  catch (e) { earlyCheckin = /提前/.test(e.message) }
  ok('不能提前给未来预约登记到诊', earlyCheckin || bookDate === today)

  let denied = false
  try { await call('invoice.create', { visitId: v._id }) }
  catch (e) { denied = /未签署/.test(e.message) }
  ok('UC06 未签署不能开单', denied)

  const treatIds = meta.treatments
  const clean = treatIds.find(t => t.name === '洗牙')
  const xray = treatIds.find(t => t.name === '检查影像')

  await call('visitTreatment.add', { visitId: v._id, treatmentId: clean._id, units: 1 })
  await call('visitTreatment.add', { visitId: v._id, treatmentId: xray._id, units: 1 })
  await call('visitTreatment.confirm', { visitId: v._id })

  const detail = await call('visit.get', { visitId: v._id })
  ok('T05 实际治疗两行', detail.lines.length === 2, detail.lines.map(l => `${l.name}×${l.units}=${l.subtotal}`))

  const inv = await call('invoice.create', { visitId: v._id })
  ok('UC06 结算单 320 元', inv.total === 320, { no: inv.invoice_no, total: inv.total })

  const again = await call('invoice.create', { visitId: v._id })
  ok('T06 重复开单返回原单号', again.invoice_no === inv.invoice_no && again.reused === true, again.invoice_no)

  // 调价不影响历史
  ok('T06 单价快照已保存', inv.lines[0].unit_price === 200 || inv.lines[1].unit_price === 120,
     inv.lines.map(l => `${l.name}@${l.unit_price}`))

  // 季度核算
  const q = await call('report.quarter', { period: seed.data.period })
  // 种子 200000 + 本次演示单 320
  ok('T09 净利润 = 收入-耗材-运营费', q.total.net === 200000 + inv.total - 50000 - 45000, q.total)
  ok('T09 基金 = 净利润 10%', q.fund === Math.round(q.total.net * 0.1 * 100) / 100, q.fund)

  // 取消率
  const d = await call('report.dashboard', {})
  // 种子 6 条：ARRIVED / CANCELLED / NO_SHOW / VERIFY 进分母，2 条 PENDING 不进；本次再 +1 ARRIVED
  ok('T03 分母只含到期有效预约', d.denominator === 5 && d.counts.PENDING === 0, { denom: d.denominator, counts: d.counts, cancel: d.cancel_rate })
  ok('T03 取消率 = 1/5 = 20%', d.cancel_rate === 20, d.cancel_rate)

  // T08 有待分摊时不出可分配结果
  const db2 = require('wx-server-sdk').database()
  await db2.collection('costs').add({ data: { dentist_id: 'd-x', type: 'UNALLOCATED', amount: 5000, period: seed.data.period } })
  const q2 = await call('report.quarter', { period: seed.data.period })
  ok('T08 待分摊 → 基金为 null 且标记待确认', q2.fund === null && q2.payable === '待确认', { fund: q2.fund, payable: q2.payable })

  // 越权/状态约束：已到诊不能普通取消
  let blocked = false
  try { await call('appointment.changeStatus', { appointmentId: pendingToday._id, to: 'CANCELLED' }) }
  catch (e) { blocked = true }
  ok('UC03 已到诊不能按普通取消处理', blocked)

  // 患者端
  const dl = await call('patient.demoList', {})
  ok('演示身份列表（云端）', dl.list.length >= 4, dl.list.map((x) => x.name))
  ok('演示身份手机号已掩码', dl.list.every((x) => /\*\*\*\*/.test(x.phoneMasked)), dl.list[0].phoneMasked)
  const inside = await call('patient.demoLogin', { patientId: dl.list[0]._id })
  ok('云端选择演示身份可进入', inside.bound === true && inside.patient._id === dl.list[0]._id, inside.patient && inside.patient.name)

  const mine = await call('visit.listByPhone', { phone: '13800000001' })
  ok('小程序就诊记录可查', mine.visits.length >= 1, mine.visits.length)
  const one = await call('invoice.get', { invoiceId: inv._id })
  ok('结算单详情可查', one.total === 320)

  // 参数缺失必须给业务提示。以前会把 undefined 丢给数据库，抛「docId必须为字符串或数字」
  // 「查询参数对象值不能均为undefined」这种内部错误，用户看不懂，前端还会当成服务故障。
  const rawInv = await api.main({ action: 'invoice.create', payload: { __token: staffToken } })
  ok('T06 开单缺参数给业务提示', rawInv.code === 400 && /就诊记录/.test(rawInv.msg || ''), rawInv.msg)
  const rawPhone = await api.main({ action: 'visit.listByPhone', payload: { __token: staffToken } })
  ok('UC05 查档缺手机号给业务提示', rawPhone.code === 400 && /手机号/.test(rawPhone.msg || ''), rawPhone.msg)
  const rawChk = await api.main({ action: 'visit.checkin', payload: { __token: staffToken } })
  ok('UC04 到诊缺预约号给业务提示', rawChk.code === 400 && /预约/.test(rawChk.msg || ''), rawChk.msg)
})().catch(e => { console.error('ERROR:', e.message); process.exitCode = 1 })
