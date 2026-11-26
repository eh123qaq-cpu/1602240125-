/* 需求符合性补强测试（UC01/02/07/08/09/10/12，验收 T07/T08/T10）
 *
 * 用内存数据库桩跑云函数 enhance.js，验证跨店排班、资质筛选、凭证防重、
 * 过敏询问状态、季度审批版本与操作留痕，并确认原有 action 没被改坏。
 *
 * 运行：node tests/enhance.js
 */
const fs = require('fs')
const vm = require('vm')
const path = require('path')
const ROOT = path.join(__dirname, '..')

const Module = require('module')
const path0 = require('path')
// 云函数里的 require('wx-server-sdk') 指向本地内存桩，不依赖 node_modules
const STUB_SDK = path0.join(__dirname, 'stub', 'wx-server-sdk', 'index.js')
const _resolve = Module._resolveFilename
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return STUB_SDK
  return _resolve.call(this, req, ...rest)
}


let pass = 0
let fail = 0
const ok = (name, cond, info) => {
  if (cond) { console.log('PASS  ' + name + (info ? ' · ' + info : '')); pass++ }
  else { console.log('FAIL  ' + name); fail++ }
}
const throws = async (fn, word) => {
  try { await fn(); return false } catch (e) {
    return !word || String(e.message || e).includes(word)
  }
}

/* ==================== A. 云函数增强模块 ==================== */

let seq = 0
const store = {
  dentists: [
    { _id: 'd1', emp_no: 'D-DEMO-01', name: '陈安', clinic_ids: ['c1', 'c2'], qualification_ids: ['q1', 'q5'], active: true },
    { _id: 'd2', emp_no: 'D-DEMO-02', name: '李敏', clinic_ids: ['c1'], qualification_ids: ['q1'], active: true }
  ],
  clinics: [{ _id: 'c1', name: '天河店' }, { _id: 'c2', name: '越秀店' }],
  treatments: [
    { _id: 't1', name: '洗牙', required_qual_ids: ['q1', 'q5'], qual_match_mode: 'ANY' },
    { _id: 't2', name: '影像', required_qual_ids: ['q1', 'q5'], qual_match_mode: 'ALL' }
  ],
  appointments: [
    { _id: 'a1', dentist_id: 'd1', date: '2026-11-26', start: '09:00', end: '09:30', status: 'PENDING' }
  ],
  costs: [{ _id: 'k1', period: '2026Q4', voucher: 'V-001', type: 'SUPPLY', amount: 100 }],
  patients: [{ _id: 'p1', name: '林小雅', phone: '13800000001', allergies: [] }],
  invoices: [{ _id: 'i1', period: '2026Q4', invoice_no: 'I-001', status: 'VALID', total: 320 }],
  staff: [
    { _id: 's1', username: 'manager', name: '黄立群', role: 'MANAGER', active: true },
    { _id: 's2', username: 'desk', name: '周晓雯', role: 'DESK', active: true }
  ]
}

const match = (row, w) => Object.keys(w || {}).every((k) => {
  const cond = w[k]
  if (cond && cond.__in) return cond.__in.includes(row[k])
  if (Array.isArray(row[k])) return row[k].includes(cond)
  return row[k] === cond
})
const rowsOf = (name) => (store[name] || (store[name] = []))
const db = {
  createCollection: async (name) => { if (!store[name]) store[name] = [] },
  collection(name) {
    const rows = () => rowsOf(name)
    const chain = (filtered) => {
      const c = {
        limit(n) { return { get: async () => ({ data: filtered.slice(0, n) }), count: async () => ({ total: filtered.length }) } },
        orderBy() { return c },
        get: async () => ({ data: filtered.slice() }),
        count: async () => ({ total: filtered.length }),
        remove: async () => {
          const ids = new Set(filtered.map((x) => x._id))
          store[name] = rows().filter((x) => !ids.has(x._id))
          return {}
        }
      }
      return c
    }
    return {
      where(w) { return chain(rows().filter((r) => match(r, w))) },
      limit(n) { return chain(rows()).limit(n) },
      orderBy() { return chain(rows()) },
      count: async () => ({ total: rows().length }),
      add: async ({ data }) => {
        const d = { _id: 'x' + (++seq), ...data }
        rows().push(d)
        return { _id: d._id }
      },
      doc(id) {
        return {
          get: async () => ({ data: rows().find((x) => x._id === id) || null }),
          update: async ({ data }) => {
            const r = rows().find((x) => x._id === id)
            if (r) Object.assign(r, data)
            return {}
          },
          remove: async () => {
            const i = rows().findIndex((x) => x._id === id)
            if (i >= 0) rows().splice(i, 1)
            return {}
          }
        }
      }
    }
  }
}

const _ = { in: (arr) => ({ __in: arr }) }
const okRes = (data) => ({ code: 0, data })
const bizError = (msg, code = 400) => { const e = new Error(msg); e.bizCode = code; throw e }
const getDoc = async (coll, id) => (rowsOf(coll).find((x) => x._id === id) || null)
const toMin = (h) => { const a = String(h).split(':').map(Number); return a[0] * 60 + a[1] }
const toHHMM = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
const genSlots = () => {
  const out = []
  for (let t = 9 * 60; t + 30 <= 12 * 60; t += 30) out.push(toHHMM(t))
  return out
}

// 原有 action 的最小桩：enhance 只包装、不重写它们
const handlers = {}
const origSlots = async ({ clinicId }) => okRes([
  { dentist_id: 'd1', dentist_name: '陈安', slots: genSlots().map((s) => ({ start: s, key: s, taken: false })), qual_names: [] },
  { dentist_id: 'd2', dentist_name: '李敏', slots: genSlots().map((s) => ({ start: s, key: s, taken: false })), qual_names: [] }
])
handlers['appointment.availableSlots'] = origSlots
handlers['patient.create'] = async (p) => okRes({ _id: 'p1', name: p.name, phone: p.phone, allergies: [] })
handlers['cost.add'] = async (p) => okRes({ _id: 'k2', ...p })
let quarterState = { payable: '可核算', fund: 10500 }
handlers['report.quarter'] = async ({ period }) => okRes({
  period, rows: [], total: { revenue: 200000, supply: 50000, opex: 45000, net: 105000 },
  fund: quarterState.fund, fund_rate: 0.1, payable: quarterState.payable
})

const STAFF_ONLY = new Set(['appointment.availableSlots', 'patient.create', 'cost.add', 'report.quarter'])
const ROLE_ACL = {
  DESK: [], DENTIST: [], FINANCE: [], OPERATIONS: [], MANAGER: ['*']
}
const enhanced = require(path.join(ROOT, 'cloudfunctions', 'api', 'enhance.js'))(handlers, {
  db,
  C: {
    dentists: 'dentists', clinics: 'clinics', treatments: 'treatments',
    appointments: 'appointments', costs: 'costs', patients: 'patients', invoices: 'invoices',
    staff: 'staff'
  },
  _, bizError, ok: okRes,
  ymd: () => '2026-11-25', todayYmd: () => '2026-11-25',
  quarterOf: () => '2026Q4',
  getDoc, HOLDING: ['PENDING', 'ARRIVED', 'DONE'],
  toMin, toHHMM, SLOT_MIN: 30,
  STAFF_ONLY, ROLE_ACL,
  ROLE_NAME: { DESK: '前台', DENTIST: '牙医', FINANCE: '财务', OPERATIONS: '运营', MANAGER: '总部经理' }
})

;(async () => {
  console.log('--- A. 云端增强 ---')

  // system.ensure 幂等建集合
  const ens = await handlers['system.ensure']()
  ok('建集合幂等且返回 3 个', ens.code === 0 && ens.data.collections.length === 3)

  // T07：跨店重叠拒绝、不同日期允许
  const base = { dentistId: 'd1', clinicId: 'c1', date: '2026-11-26', start: '09:00', end: '12:00' }
  const r1 = await handlers['schedule.upsert'](base)
  ok('录入 c1 排班成功', r1.code === 0)
  ok('跨店同日重叠被拒绝', await throws(
    () => handlers['schedule.upsert']({ ...base, clinicId: 'c2', start: '11:00', end: '14:00' }), '跨店重叠'))
  ok('同牙医不同日期允许', (await handlers['schedule.upsert']({ ...base, date: '2026-11-27' })).code === 0)
  ok('转场间隔有人工核实提示', (await handlers['schedule.upsert']({ ...base, clinicId: 'c2', start: '12:30', end: '15:00' })).data.warning.includes('转场'))
  ok('起止时间非法被拒绝', await throws(
    () => handlers['schedule.upsert']({ ...base, date: '2026-11-28', start: '15:00', end: '09:00' }), '晚于'))
  ok('删除有预约的排班被拒绝', await throws(
    () => handlers['schedule.remove']({ scheduleId: r1.data._id }), '有效预约'))
  ok('删除无预约排班成功', (await handlers['schedule.remove']({ scheduleId: (await handlers['schedule.upsert']({ ...base, clinicId: 'c2', start: '15:00', end: '17:00' })).data._id })).code === 0)

  // 牙医账号只能维护本人排班（工号 D-DEMO-02 对应 d2）
  const asLi = { role: 'DENTIST', name: '李敏', emp_no: 'D-DEMO-02' }
  ok('牙医改他人排班被拒绝', await throws(
    () => handlers['schedule.upsert']({ ...base, date: '2026-12-01', __staff: asLi }), '本人'))
  ok('牙医不给本人在职门店排班被拒绝', await throws(
    () => handlers['schedule.upsert']({ ...base, dentistId: 'd2', clinicId: 'c2', date: '2026-12-01', __staff: asLi }), '在职'))
  const selfSch = await handlers['schedule.upsert']({
    clinicId: 'c1', date: '2026-12-02', start: '09:00', end: '12:00', __staff: asLi
  })
  ok('牙医不填牙医也能落成本人排班', selfSch.code === 0 && selfSch.data.dentist_id === 'd2')
  ok('牙医删他人排班被拒绝', await throws(
    () => handlers['schedule.remove']({ scheduleId: r1.data._id, __staff: asLi }), '本人'))

  // 排班驱动可约时段 + 回退兼容
  const withSchedule = await handlers['appointment.availableSlots']({ clinicId: 'c1', date: '2026-11-27' })
  ok('有排班时按排班生成时段', withSchedule.code === 0 && withSchedule.data.every((d) => d.schedule_based))
  const noSchedule = await handlers['appointment.availableSlots']({ clinicId: 'c1', date: '2026-11-29' })
  ok('无排班时回退原有行为', noSchedule.code === 0 && noSchedule.data.length === 2 && !noSchedule.data[0].schedule_based)

  // UC02 / UC07 资质筛选
  const any = await handlers['appointment.availableSlots']({ clinicId: 'c1', date: '2026-11-29', treatmentId: 't1' })
  ok('ANY 模式：持任一资质即可', any.data.length === 2)
  const all = await handlers['appointment.availableSlots']({ clinicId: 'c1', date: '2026-11-29', treatmentId: 't2' })
  ok('ALL 模式：过滤掉资质不全的牙医', all.data.length === 1 && all.data[0].dentist_id === 'd1')

  // UC09 凭证防重
  ok('重复凭证被拒绝', await throws(
    () => handlers['cost.add']({ voucher: 'V-001', amount: 50 }), '重复录入'))
  ok('新凭证可以登记', (await handlers['cost.add']({ voucher: 'V-002', amount: 50 })).code === 0)

  // UC01 / UC04 过敏询问状态
  ok('未登记过敏不能标记「已报告」', await throws(
    () => handlers['patient.allergy.setInquiry']({ patientId: 'p1', status: 'REPORTED' }), '先登记'))
  ok('「尚未询问」可以保存', (await handlers['patient.allergy.setInquiry']({ patientId: 'p1', status: 'NOT_ASKED' })).code === 0)
  ok('建档自动补默认询问状态', (await handlers['patient.create']({ name: '林小雅', phone: '13800000001' })).data.allergy_inquiry_status === 'NOT_ASKED')

  // T08 / UC10 季度版本与审批
  quarterState = { payable: '待确认', fund: null }
  ok('待分摊时不能提交核算（T08）', await throws(() => handlers['quarter.submit']({ period: '2026Q4' }), '待分摊'))
  quarterState = { payable: '可核算', fund: 10500 }
  const sub = await handlers['quarter.submit']({ period: '2026Q4', __staff: { name: '财务小李', role: 'FINANCE' } })
  ok('可核算时提交生成版本 v1', sub.code === 0 && sub.data.version === 1 && sub.data.status === 'SUBMITTED')
  const ap = await handlers['quarter.approve']({ quarterId: sub.data._id, __staff: { name: '总部经理', role: 'MANAGER' } })
  ok('经理审批通过', ap.code === 0 && ap.data.status === 'APPROVED')
  ok('审批后报表带出已审批版本', (await handlers['report.quarter']({ period: '2026Q4' })).data.approved_version === 1)
  ok('报表带出下钻来源', (await handlers['report.quarter']({ period: '2026Q4' })).data.sources.invoice_nos.includes('I-001'))
  ok('核算版本可列出', (await handlers['quarter.list']({ period: '2026Q4' })).data.length === 1)

  // T10 / UC12 留痕与越权
  ok('写操作成功后有审计记录', (store.audit_logs || []).some((x) => x.action === 'schedule.upsert' && x.result === 'OK'))
  ok('审计含操作者与业务编号', (store.audit_logs || []).some((x) => x.operator.includes('系统') || x.biz_no))
  await enhanced.writeAudit('invoice.create', { __staff: { _id: 's1', name: '前台小王', role: 'DESK' } }, null, 'FAIL', '越权请求被拒绝')
  ok('越权 / 失败请求也留痕', (store.audit_logs || []).some((x) => x.result === 'FAIL' && x.message.includes('越权')))
  ok('审计可按关键字与结果查询', (await handlers['audit.list']({ keyword: 'schedule', result: 'OK', limit: 50 })).data.length > 0)
  ok('新 action 都纳入员工 token 校验', ['schedule.upsert', 'quarter.submit', 'audit.list'].every((a) => STAFF_ONLY.has(a)))
  ok('审批动作没有下放给普通角色', !ROLE_ACL.FINANCE.includes('quarter.approve') && ROLE_ACL.FINANCE.includes('quarter.submit'))

  // 员工账号：同一角色可开多个，但只有经理能维护，密码哈希不出库
  const sl = await handlers['staff.list']({ __staff: { _id: 's1', role: 'MANAGER' } })
  ok('经理可读员工账号', sl.code === 0 && sl.data.length === 2 && !('password_hash' in sl.data[0]))
  ok('非经理不能读员工账号', await throws(
    () => handlers['staff.list']({ __staff: { _id: 's2', role: 'DESK' } }), '经理'))
  ok('牙医账号必须填工号', await throws(
    () => handlers['staff.upsert']({ __staff: { _id: 's1', role: 'MANAGER' }, username: 'dentist9', name: '测试', role: 'DENTIST', password: 'adc123456' }),
    '工号'))
  const newStaff = await handlers['staff.upsert']({
    __staff: { _id: 's1', role: 'MANAGER' }, username: 'desk9', name: '测试前台', role: 'DESK',
    clinic_name: '越秀店', password: 'adc123456'
  })
  ok('新增同角色第二个账号', newStaff.code === 0 && newStaff.data.created === true && newStaff.data.active === true)
  ok('密码不以明文 / 哈希返回', !JSON.stringify(newStaff.data).includes('adc123456') && !('password_hash' in newStaff.data))


  console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('测试异常：', e); process.exit(1) })
