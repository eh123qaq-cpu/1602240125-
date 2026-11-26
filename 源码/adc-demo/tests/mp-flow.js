/**
 * 小程序数据层冒烟测试（不连云端、不需要开发者工具）
 *
 * 运行：node tests/mp-flow.js
 *
 * 校验对象是 miniprogram/utils/mock.js —— 它的契约与 cloudfunctions/api 完全一致，
 * 所以这里跑通的流程，配置 envId 换成云端后也是同一套调用与同一种返回结构。
 *
 * 覆盖：登录绑定 → 查可约时段 → 预约 → 抢号冲突 → 取消 → 改约 →
 *       就诊记录 → 结算单归属校验 → 过敏登记与删除保护
 */
const path = require('path')

/* ------------------------------ wx 桩 ------------------------------ */

const storage = new Map()
global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))),
  removeStorageSync: (k) => storage.delete(k),
  showLoading() {},
  hideLoading() {}
}

const mock = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'mock.js'))
const F = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'format.js'))

let failed = 0
const ok = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`)
  if (!cond) failed += 1
}
const expectFail = async (label, fn, matcher) => {
  try {
    await fn()
    ok(label, false, '没有抛出预期错误')
  } catch (e) {
    ok(label, matcher ? matcher.test(e.message) : true, e.message)
  }
}

const call = (action, payload) => mock.handle(action, payload)

;(async () => {
  /* ---------- 1. 未登录 ---------- */
  let s = await call('patient.session')
  ok('未绑定时 session.bound = false', s.bound === false)

  await expectFail('未登录直接预约被拒', () => call('appointment.create', { clinicId: 'clinic_tianhe', dentistId: 'dentist_chen', date: F.ymd(new Date()), start: '10:00' }), /登录/)

  /* ---------- 2. 选择演示身份进入（不收集手机号） ---------- */
  const dl = await call('patient.demoList')
  ok('演示身份列表可用', dl.list.length >= 4, dl.list.map((x) => x.name))
  ok('列表不返回完整手机号', dl.list.every((x) => /\*\*\*\*/.test(x.phoneMasked)), dl.list[0].phoneMasked)
  ok('身份带标签', dl.list.some((x) => x.tags && x.tags.length), dl.list.map((x) => x.tags.join('/')))

  await expectFail('选择不存在的身份被拒', () => call('patient.demoLogin', { patientId: 'nope' }), /不存在/)
  await expectFail('未选身份被拒', () => call('patient.demoLogin', {}), /身份/)

  const b = await call('patient.demoLogin', { patientId: 'p_lin' })
  ok('选择身份后进入', b.bound && b.patient._id === 'p_lin', b.patient && b.patient.name)
  ok('过敏记录随档案带出', b.patient.allergies.length === 2, b.patient.allergies.map((a) => a.name))

  s = await call('patient.session')
  ok('session 返回已绑定', s.bound === true)

  const b2 = await call('patient.demoLogin', { patientId: 'p_zhang' })
  ok('可切换演示身份', b2.patient._id === 'p_zhang', b2.patient.name)
  await call('patient.demoLogin', { patientId: 'p_lin' })

  /* ---------- 3. 门店与牙医 ---------- */
  const clinics = await call('clinic.list')
  ok('门店列表', clinics.length === 2, clinics.map((c) => c.short_name))

  const clinic = await call('clinic.get', { clinicId: 'clinic_tianhe' })
  ok('门店详情含出诊牙医', clinic.dentists.length === 2, clinic.dentists.map((d) => d.name))

  const dentist = await call('dentist.get', { dentistId: 'dentist_chen' })
  ok('牙医详情含出诊门店', dentist.clinics.length === 2, dentist.clinics.map((c) => c.short_name))

  /* ---------- 4. 可约时段 ---------- */
  const today = F.ymd(new Date())
  const groups = await call('appointment.availableSlots', { clinicId: 'clinic_tianhe', date: today })
  ok('可约时段按牙医分组', groups.length === 2, groups.map((g) => `${g.dentist_name}:${g.slots.length}`))

  const g = groups.find((x) => x.slots.length)
  const slot = g.slots[0].start
  const before = g.slots.length

  /* ---------- 5. 预约 + 抢号 ---------- */
  const ap = await call('appointment.create', {
    clinicId: 'clinic_tianhe',
    dentistId: g.dentist_id,
    date: today,
    start: slot,
    need: '全口洁牙'
  })
  ok('预约成功', ap.status === 'PENDING' && ap.patient_id === 'p_lin', `${ap.date} ${ap.start} ${ap.dentist_name}`)
  ok('slot_key 已写入（唯一索引依据）', ap.slot_key === `${g.dentist_id}|${today}|${slot}`, ap.slot_key)

  await expectFail(
    '同牙医同时段再约被拒',
    () => call('appointment.create', { clinicId: 'clinic_tianhe', dentistId: g.dentist_id, date: today, start: slot }),
    /占用/
  )

  const after = (await call('appointment.availableSlots', { clinicId: 'clinic_tianhe', date: today })).find(
    (x) => x.dentist_id === g.dentist_id
  )
  ok('已约时段从可约列表消失', after.slots.length === before - 1, `${before} → ${after.slots.length}`)

  /* ---------- 6. 我的预约 / 取消 ---------- */
  const mine = await call('appointment.mine')
  ok('只返回本人预约', mine.every((a) => a.patient_id === 'p_lin'), mine.length)
  ok('按时间倒序', mine[0].date + mine[0].start >= mine[mine.length - 1].date + mine[mine.length - 1].start)
  ok('可取消标记由服务端给出', mine.find((a) => a.status === 'PENDING').canCancel === true)

  const cancelled = await call('appointment.cancelSelf', { appointmentId: ap._id, reason: '临时有事' })
  ok('自助取消成功', cancelled.status === 'CANCELLED', cancelled.status_reason)
  await expectFail('重复取消被拒', () => call('appointment.cancelSelf', { appointmentId: ap._id }), /不能/)
  await expectFail('取消他人预约被拒', () => call('appointment.cancelSelf', { appointmentId: 'ap_noshow' }), /无权/)

  /* ---------- 7. 改约 ---------- */
  const future = mine.find((a) => a._id === 'ap_future' && a.status === 'PENDING')
  ok('存在可改约的预约', !!future, future && `${future.date} ${future.start}`)

  const target = g.slots.find((x) => x.start !== slot) || g.slots[g.slots.length - 1]
  const moved = await call('appointment.rescheduleSelf', { appointmentId: future._id, date: today, start: target.start })
  ok('改约生成新记录', moved._id !== future._id && moved.rescheduled_from === future._id)

  const afterMove = await call('appointment.mine')
  const old = afterMove.find((a) => a._id === future._id)
  ok('原记录标记为已改约而不是删除', old && old.status === 'RESCHEDULED', old && old.status)
  ok('新记录重新占用时段', afterMove.some((a) => a._id === moved._id && a.status === 'PENDING'))

  /* ---------- 8. 就诊记录与结算单 ---------- */
  const vs = await call('visit.mine')
  ok('就诊记录只含本人', vs.visits.every((v) => v.patient_id === 'p_lin'), vs.visits.length)

  const done = vs.visits.find((v) => v.invoice)
  ok('已结算就诊带出治疗行与结算单', done.lines.length === 2 && done.invoice.total === 320, done.invoice.invoice_no)

  const inv = await call('invoice.mine', { invoiceId: done.invoice._id })
  ok('结算单详情可查', inv.total === 320 && inv.lines.length === 2)

  await expectFail('查看不存在的结算单被拒', () => call('invoice.mine', { invoiceId: 'inv_not_exist' }), /不存在/)

  /* ---------- 9. 过敏登记 ---------- */
  const p2 = await call('patient.allergy.add', { name: '金属' })
  const added = p2.allergies.find((a) => a.name === '金属')
  ok('自报过敏标记为待核实', added && added.confirmed === false && added.source === 'PATIENT')

  await expectFail('重复登记过敏被拒', () => call('patient.allergy.add', { name: '金属' }), /已登记/)
  await expectFail('已核实过敏不能自删', () => call('patient.allergy.remove', { name: '青霉素' }), /不能自行删除/)

  const p3 = await call('patient.allergy.remove', { name: '金属' })
  ok('待核实的过敏可以删除', !p3.allergies.some((a) => a.name === '金属'))

  /* ---------- 10. 日期工具 ---------- */
  const strip = F.dateStrip(14)
  ok('日期条 14 天且首日为今天', strip.length === 14 && strip[0].date === today, `${strip[0].date} ~ ${strip[13].date}`)
  ok('相对日期文案', strip[0].label === '今天' && strip[1].label === '明天', [strip[0].label, strip[1].label])
  ok('金额格式化保留两位', F.money(320) === '320' && F.money(12.5) === '12.50', [F.money(320), F.money(12.5)])
  ok('手机号掩码', F.maskPhone('13800000001') === '138****0001', F.maskPhone('13800000001'))
  ok('已改约不算取消', F.statusOf('RESCHEDULED').text === '已改约' && F.statusOf('NO_SHOW').text === '未完成')

  console.log('')
  console.log(failed ? `❌ ${failed} 条断言失败` : '✅ 全部通过')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
