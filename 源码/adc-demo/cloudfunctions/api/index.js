/**
 * ADC 安德鲁牙科连锁 —— 统一业务入口云函数
 *
 * 设计要点（作业评分点，见 README）：
 *  1. 所有写操作只经过这里，小程序端 / Web 端都不直连数据库
 *  2. 预约用 slot_key 唯一键防同一牙医同一时段被重复占用   —— UC02 / T02
 *  3. 到诊 attended 从 false 变 true 才允许录入治疗        —— UC04
 *  4. 治疗行保存单价快照，调价不影响历史结算              —— UC05 / T06
 *  5. 一次就诊只允许一张有效结算单（幂等返回原单号）      —— UC06 / T06
 *  6. 取消率分母只算「已到期的有效预约」                  —— UC11 / T03
 *  7. 净利润 = 收入 - 耗材成本 - 运营费用，10% 是基金不是个人奖金 —— UC10 / T09
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const C = {
  clinics: 'clinics',
  dentists: 'dentists',
  quals: 'qualifications',
  patients: 'patients',
  appointments: 'appointments',
  visits: 'visits',
  treatments: 'treatments',
  lines: 'visit_treatments',
  invoices: 'invoices',
  costs: 'costs',
  wxusers: 'wechat_users',
  staff: 'staff',
  sessions: 'staff_sessions',
  schedules: 'schedules'
}

/* ------------------------------ 工具 ------------------------------ */

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// 云函数运行环境默认 UTC：直接用 new Date() 取「今天」会在北京时间 0–8 点差一天，
// 预约「过去日期」判断、发票单号、报表日期都会错。统一按 UTC+8 取业务日期与时刻。
const CN_OFFSET = 8 * 60 * 60 * 1000
const cnYmd = () => {
  const d = new Date(Date.now() + CN_OFFSET)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const cnMinuteOfDay = () => {
  const d = new Date(Date.now() + CN_OFFSET)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const compact = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
const money = (n) => Math.round(Number(n) * 100) / 100

const quarterOf = (dateStr) => {
  const [y, m] = dateStr.split('-').map(Number)
  return `${y}Q${Math.ceil(m / 3)}`
}

const ok = (data) => ({ code: 0, data })
const fail = (msg, code = 400) => ({ code, msg })

// 业务异常直接抛出，由 main 统一转成 { code, msg }
const bizError = (msg, code = 400) => {
  const e = new Error(msg)
  e.bizCode = code
  throw e
}

// 必填参数兜底。参数缺了还往数据库扔，只会抛「docId必须为字符串或数字」
// 「查询参数对象值不能均为undefined」这类内部错误：用户看不懂，前端还会当成服务故障。
const needParam = (v, label) => {
  const x = String(v === undefined || v === null ? '' : v).trim()
  if (!x) bizError('请先选择' + label)
  return x
}

// 各状态定义：false 不等于取消，必须区分
const ST = {
  PENDING: 'PENDING',       // 待到诊
  ARRIVED: 'ARRIVED',       // 已到诊
  DONE: 'DONE',             // 治疗完成
  CANCELLED: 'CANCELLED',   // 患者主动取消
  VOID: 'VOID',             // 诊所撤销
  RESCHEDULED: 'RESCHEDULED', // 已改约（原记录）
  VERIFY: 'VERIFY',         // 到期待核实
  NO_SHOW: 'NO_SHOW'        // 已核实未到诊
}

// 占用时段的状态（取消 / 撤销 / 改约 都不占）
const HOLDING = [ST.PENDING, ST.ARRIVED, ST.DONE]

// 计入「已到期有效预约」分母的状态（T03）
const DUE = [ST.ARRIVED, ST.DONE, ST.CANCELLED, ST.NO_SHOW, ST.VERIFY]

const WORK_WINDOWS = [
  ['09:00', '12:00'],
  ['14:00', '17:30']
]
const SLOT_MIN = 30

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}
const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

// 生成某天标准可约时段（30 分钟一格）
const genSlots = () => {
  const out = []
  WORK_WINDOWS.forEach(([s, e]) => {
    for (let t = toMin(s); t + SLOT_MIN <= toMin(e); t += SLOT_MIN) out.push(toHHMM(t))
  })
  return out
}

const slotKey = (dentistId, date, start) => `${dentistId}|${date}|${start}`
// slot_key 上有唯一索引。取消 / 改约后必须释放，否则该时段会被永久锁死；
// 释放写法仍保持唯一（带原单 _id），历史记录保留，符合「改约不删原单」。
const releasedKey = (a, id) => `${a.slot_key || slotKey(a.dentist_id, a.date, a.start)}#released:${id}`

// 改约时新时段可能正好是它自己（只换牙医不换时间）：要把本单排除掉，
// 否则用户「保存」后只会看到「新时段已被占用」，像功能坏了。
const slotTakenByOther = async (key, selfId) => {
  const rows = (await db.collection(C.appointments).where({ slot_key: key, status: _.in(HOLDING) }).limit(10).get()).data
  return rows.some((x) => x._id !== selfId)
}

// 当天已经过去的时段不能再约；跨天只比日期
const isPastSlot = (date, start) => {
  const today = cnYmd()
  if (date < today) return true
  if (date > today) return false
  return toMin(start) <= cnMinuteOfDay()
}

// 下单 / 改约共用的时段校验：人在职、在该门店出诊、时间在门诊时段内、当天排班内、且不在过去。
// 前端拿到的 availableSlots 已经是过滤后的结果，这里再挡一次，防止直接调接口绕过。
const assertBookable = async ({ clinicId, dentistId, date, start }) => {
  if (!genSlots().includes(start)) bizError('该时间不在门诊时段内（30 分钟一格）')
  if (isPastSlot(date, start)) bizError('该时段已经过去，请选择之后的时间')

  const dentist = await getDoc(C.dentists, dentistId)
  if (!dentist || dentist.active === false) bizError('该牙医当前不在职', 404)
  if (!(dentist.clinic_ids || []).includes(clinicId)) bizError('该牙医不在所选门店出诊')

  // 当天有排班时必须落在本人排班内；一条排班都没有时沿用基础工作时间
  let sch = []
  try {
    sch = (await db.collection(C.schedules)
      .where({ clinic_id: clinicId, date, status: 'ACTIVE' }).limit(300).get()).data
  } catch (e) { sch = [] }
  if (sch.length) {
    const mine = sch.filter((x) => x.dentist_id === dentistId)
    if (!mine.length) bizError('该牙医当天未排班')
    const hit = mine.some((x) => toMin(start) >= toMin(x.start) && toMin(start) + SLOT_MIN <= toMin(x.end))
    if (!hit) bizError('该时段不在该牙医当天的出诊时间内')
  }
  return dentist
}

// 生成业务单号：前缀 + 日期 + 当日流水
const nextNo = async (prefix, coll, field, dateStr) => {
  const day = dateStr.replace(/-/g, '')
  const res = await db
    .collection(coll)
    .where({ [field]: db.RegExp({ regexp: `^${prefix}${day}-` }) })
    .count()
  return `${prefix}${day}-${String(res.total + 1).padStart(3, '0')}`
}

/* ---------------------------- 患者 / 档案 ---------------------------- */

// UC01 建立患者档案：按 手机 + 姓名 + 出生日期 核对，不按手机号硬合并
const findOrCreatePatient = async (p) => {
  const name = String(p.name || '').trim()
  const phone = String(p.phone || '').trim()
  const dob = String(p.dob || '').trim()
  if (!name || !phone) bizError('姓名和手机号必填')
  if (!/^1[3-9]\d{9}$/.test(phone)) bizError('手机号格式不正确')

  const exact = await db.collection(C.patients).where({ name, phone, dob }).get()
  if (exact.data.length) return exact.data[0]

  const samePhone = await db.collection(C.patients).where({ phone }).get()
  if (samePhone.data.length) {
    const hit = samePhone.data.find((x) => x.name === name)
    if (hit) return hit
    bizError('该手机号已存在不同姓名的档案，请前台人工核对，不能直接合并')
  }

  const doc = {
    name,
    phone,
    dob,
    billing_address: p.billing_address || '',
    email: p.email || '',          // 邮箱可空 —— T01
    emergency_name: p.emergency_name || '',
    emergency_phone: p.emergency_phone || '',
    // 过敏逐项保存，不用一条文本覆盖另一条 —— T01
    allergies: Array.isArray(p.allergies) ? p.allergies : [],
    created_at: Date.now()
  }
  const r = await db.collection(C.patients).add({ data: doc })
  return { _id: r._id, ...doc }
}

/* ------------------------------ 预约 ------------------------------ */

const handlers = {}

handlers['meta.bootstrap'] = async () => {
  const [clinics, dentists, treatments, quals] = await Promise.all([
    db.collection(C.clinics).where({ active: true }).limit(50).get(),
    db.collection(C.dentists).where({ active: true }).limit(50).get(),
    db.collection(C.treatments).where({ active: true }).limit(100).get(),
    db.collection(C.quals).limit(50).get()
  ])
  return ok({
    clinics: clinics.data,
    dentists: dentists.data,
    treatments: treatments.data,
    qualifications: quals.data
  })
}

// UC02 可约时段：按「牙医出诊门店 + 未被占用」筛选
handlers['appointment.availableSlots'] = async ({ clinicId, date }) => {
  if (!clinicId || !date) bizError('缺少门店或日期')
  const today = cnYmd()
  if (date < today) bizError('不能预约过去的日期')

  const ds = await db
    .collection(C.dentists)
    .where({ active: true, clinic_ids: clinicId })
    .limit(50)
    .get()

  const booked = await db
    .collection(C.appointments)
    .where({ clinic_id: clinicId, date, status: _.in(HOLDING) })
    .limit(200)
    .get()

  const taken = new Set(booked.data.map((a) => a.slot_key))
  const all = genSlots()

  // 排班是「谁在哪天出诊」的唯一依据。当天有排班时必须按排班出号，
  // 否则这里会给出一个 assertBookable 明确拒绝的时段 —— 用户点了必然失败。
  let sch = []
  try {
    sch = (await db
      .collection(C.schedules)
      .where({ clinic_id: clinicId, date, status: 'ACTIVE' })
      .limit(300)
      .get()).data
  } catch (e) { sch = [] }

  const inShift = (dentistId, start) => {
    const mine = sch.filter((x) => x.dentist_id === dentistId)
    if (!mine.length) return false
    return mine.some((x) => toMin(start) >= toMin(x.start) && toMin(start) + SLOT_MIN <= toMin(x.end))
  }

  return ok(
    ds.data
      // 有排班时，当天没排班的牙医不进候选，避免点开是「约满」其实根本没出诊
      .filter((d) => (sch.length ? sch.some((x) => x.dentist_id === d._id) : true))
      .map((d) => ({
        dentist_id: d._id,
        dentist_name: d.name,
        title: d.title || '',
        emp_no: d.emp_no,
        qual_names: d.qual_names || [],
        slots: all
          .filter((s) => (sch.length ? inShift(d._id, s) : true))
          .map((s) => ({ start: s, key: slotKey(d._id, date, s), taken: taken.has(slotKey(d._id, date, s)) }))
          .filter((s) => !s.taken && !isPastSlot(date, s.start))
      }))
  )
}

// UC02 提交预约
handlers['appointment.create'] = async (p) => {
  const { clinicId, dentistId, date, start, need } = p
  if (!clinicId || !dentistId || !date || !start) bizError('预约信息不完整')
  if (date < cnYmd()) bizError('不能预约过去的日期')

  // 先校验时段，再动患者档案：抢号失败不应该顺手建出一个新患者
  const key = slotKey(dentistId, date, start)

  // 防抢号：先查，靠唯一索引兜底（README 第 5 步要求建唯一索引）
  const dup = await db.collection(C.appointments).where({ slot_key: key, status: _.in(HOLDING) }).count()
  if (dup.total > 0) bizError('该时段刚被占用，请换一个时段', 409)

  // 时段合法性：门诊格、未过期、牙医在该门店出诊、落在当天排班内
  await assertBookable({ clinicId, dentistId, date, start })

  // 患者自助下单：身份取 OPENID，前端伪造不了；
  // 前台下单（电话建档）才按 姓名+手机 核对，允许顺便建新档案
  const patient = p.name && p.phone ? await findOrCreatePatient(p) : await currentPatient()

  const clinic = (await db.collection(C.clinics).doc(clinicId).get()).data
  const dentist = (await db.collection(C.dentists).doc(dentistId).get()).data

  const doc = {
    patient_id: patient._id,
    patient_name: patient.name,
    patient_phone: patient.phone,
    clinic_id: clinicId,
    clinic_name: clinic.name,
    dentist_id: dentistId,
    dentist_name: dentist.name,
    date,
    start,
    end: toHHMM(toMin(start) + SLOT_MIN),
    slot_key: key,
    need: need || '',
    special_need: p.special_need || '',
    attended: false,           // 案例要求的布尔字段，初值 false
    status: ST.PENDING,
    source: p.source || 'MINI', // MINI=患者自助 / DESK=前台电话
    created_at: Date.now()
  }
  try {
    const r = await db.collection(C.appointments).add({ data: doc })
    return ok({ appointment_id: r._id, ...doc })
  } catch (e) {
    // 唯一索引冲突
    bizError('该时段已被预约（唯一索引拦截）', 409)
  }
}

// UC03 取消 / 改约 / 核实未到诊
handlers['appointment.changeStatus'] = async ({ appointmentId, to, reason, by }) => {
  appointmentId = needParam(appointmentId, '要操作的预约')
  const cur = (await db.collection(C.appointments).doc(appointmentId).get()).data
  if (!cur) bizError('预约不存在', 404)

  if ([ST.ARRIVED, ST.DONE].includes(cur.status) && [ST.CANCELLED, ST.VOID].includes(to)) {
    bizError('已到诊或已治疗的预约不能按取消 / 撤销处理；如确有错误请走更正流程')
  }
  if (cur.status === ST.CANCELLED && [ST.VERIFY, ST.NO_SHOW].includes(to)) {
    bizError('已取消的预约不能再改为待核实 / 未到诊')
  }
  if (![ST.CANCELLED, ST.VOID, ST.NO_SHOW, ST.VERIFY].includes(to)) {
    bizError('非法状态变更')
  }

  const patch = {
    status: to,
    status_reason: reason || '',
    status_by: by || 'STAFF',
    status_at: Date.now()
  }
  // 取消 / 作废 / 未到诊都要把时段放回可约池
  if ([ST.CANCELLED, ST.VOID, ST.NO_SHOW].includes(to)) {
    patch.slot_key = releasedKey(cur, appointmentId)
  }
  await db.collection(C.appointments).doc(appointmentId).update({ data: patch })
  return ok({ appointment_id: appointmentId, status: to })
}

// UC03 改约：新记录 + 原记录标记已改约，不删除原单
handlers['appointment.reschedule'] = async ({ appointmentId, date, start, dentistId }) => {
  appointmentId = needParam(appointmentId, '要改约的预约')
  date = needParam(date, '改约日期')
  start = needParam(start, '改约时段')
  const cur = (await db.collection(C.appointments).doc(appointmentId).get()).data
  if (!cur) bizError('预约不存在', 404)
  if (![ST.PENDING, ST.VERIFY].includes(cur.status)) bizError('当前状态不允许改约')

  const newDentistId = dentistId || cur.dentist_id
  const key = slotKey(newDentistId, date, start)
  if (await slotTakenByOther(key, appointmentId)) bizError('新时段已被占用，原预约继续有效', 409)

  // 改约同样要守住门店、排班和「不能改到过去」
  await assertBookable({ clinicId: cur.clinic_id, dentistId: newDentistId, date, start })

  const dentist = (await db.collection(C.dentists).doc(newDentistId).get()).data
  const doc = {
    ...cur,
    _id: undefined,
    dentist_id: newDentistId,
    dentist_name: dentist.name,
    date,
    start,
    end: toHHMM(toMin(start) + SLOT_MIN),
    slot_key: key,
    status: ST.PENDING,
    attended: false,
    rescheduled_from: appointmentId,
    created_at: Date.now()
  }
  delete doc._id

  // 先把原单的 slot_key 释放成 #released 形式，再插入新单。
  // uniq_slot_key 是唯一索引：原单还占着格子时插入同格新单会直接报
  // Duplicate key violation，「只换牙医不换时间」的改约每次都撞。
  const oldKey = cur.slot_key || slotKey(cur.dentist_id, cur.date, cur.start)
  await db.collection(C.appointments).doc(appointmentId).update({
    data: {
      status: ST.RESCHEDULED,
      slot_key: releasedKey(cur, appointmentId),
      status_at: Date.now()
    }
  })

  let r
  try {
    r = await db.collection(C.appointments).add({ data: doc })
  } catch (e) {
    // 新单没落库就把原单恢复：不能让患者「原单已改约、新单没建成」
    await db.collection(C.appointments).doc(appointmentId).update({
      data: { status: cur.status, slot_key: oldKey, status_at: cur.status_at || Date.now() }
    })
    throw e
  }

  await db.collection(C.appointments).doc(appointmentId).update({ data: { rescheduled_to: r._id } })
  return ok({ appointment_id: r._id })
}

// 预约列表（按日期，前端自己分状态展示）
handlers['appointment.list'] = async ({ date, phone, clinicId, limit = 100 }) => {
  const w = {}
  if (date) w.date = date
  if (phone) w.patient_phone = phone
  if (clinicId) w.clinic_id = clinicId
  const r = await db
    .collection(C.appointments)
    .where(w)
    .orderBy('date', 'asc')
    .orderBy('start', 'asc')
    .limit(limit)
    .get()
  return ok(r.data)
}

/* ---------------------------- 到诊 / 治疗 ---------------------------- */

// UC04 到诊登记：attended 立即置 true，不等治疗结束
handlers['visit.checkin'] = async ({ appointmentId }) => {
  appointmentId = needParam(appointmentId, '要登记到诊的预约')
  const ap = (await db.collection(C.appointments).doc(appointmentId).get()).data
  if (!ap) bizError('预约不存在', 404)
  if (ap.status !== ST.PENDING && ap.status !== ST.VERIFY) bizError('该预约状态不能登记到诊')
  if (ap.date > cnYmd()) bizError('还没到预约日期，不能提前登记到诊')

  await db.collection(C.appointments).doc(appointmentId).update({
    data: { attended: true, status: ST.ARRIVED, arrived_at: Date.now() }
  })

  const exist = await db.collection(C.visits).where({ appointment_id: appointmentId }).get()
  if (exist.data.length) return ok(exist.data[0])

  const today = cnYmd()
  const doc = {
    visit_no: await nextNo('V', C.visits, 'visit_no', today),
    appointment_id: appointmentId,
    patient_id: ap.patient_id,
    patient_name: ap.patient_name,
    clinic_id: ap.clinic_id,
    dentist_id: ap.dentist_id,
    dentist_name: ap.dentist_name,
    special_need: ap.special_need || '',
    status: 'OPEN',
    arrived_at: Date.now()
  }
  const r = await db.collection(C.visits).add({ data: doc })
  return ok({ _id: r._id, ...doc })
}

// 某次就诊的完整档案：患者 + 逐项过敏 + 实际治疗行 + 结算单
// 按预约取就诊记录（前台/诊间用）
handlers['visit.byAppointment'] = async ({ appointmentId }) => {
  appointmentId = needParam(appointmentId, '要查看的预约')
  const r = await db.collection(C.visits).where({ appointment_id: appointmentId }).get()
  return ok(r.data[0] || null)
}

handlers['visit.get'] = async ({ visitId }) => {
  visitId = needParam(visitId, '要查看的就诊记录')
  const visit = (await db.collection(C.visits).doc(visitId).get()).data
  if (!visit) bizError('就诊不存在', 404)
  const [patient, lines, invoice] = await Promise.all([
    db.collection(C.patients).doc(visit.patient_id).get(),
    db.collection(C.lines).where({ visit_id: visitId }).orderBy('created_at', 'asc').limit(100).get(),
    db.collection(C.invoices).where({ visit_id: visitId, status: 'VALID' }).get()
  ])
  return ok({
    visit,
    patient: patient.data,
    lines: lines.data,
    invoice: invoice.data[0] || null
  })
}

// UC05 追加实际治疗行（单价取当时快照）
handlers['visitTreatment.add'] = async ({ visitId, treatmentId, units, dentistId }) => {
  const visit = (await db.collection(C.visits).doc(visitId).get()).data
  if (!visit) bizError('就诊不存在', 404)

  const ap = (await db.collection(C.appointments).doc(visit.appointment_id).get()).data
  if (!ap || ap.attended !== true) bizError('未到诊不得录入已实施治疗')

  if (visit.status === 'INVOICED') bizError('已开单，需走更正审批，不能直接加行')
  if (!(Number(units) > 0)) bizError('单位数必须为正值')

  const t = (await db.collection(C.treatments).doc(treatmentId).get()).data
  if (!t) bizError('治疗项目不存在', 404)

  const doc = {
    visit_id: visitId,
    treatment_id: treatmentId,
    name: t.name,                       // 名称快照
    units: Number(units),
    unit_price: Number(t.unit_price),   // 单价快照 —— T06
    subtotal: money(Number(units) * Number(t.unit_price)),
    dentist_id: dentistId || visit.dentist_id,
    status: 'DRAFT',
    created_at: Date.now()
  }
  const r = await db.collection(C.lines).add({ data: doc })
  return ok({ _id: r._id, ...doc })
}

handlers['visitTreatment.remove'] = async ({ lineId }) => {
  const l = (await db.collection(C.lines).doc(lineId).get()).data
  if (!l) bizError('明细不存在', 404)
  if (l.status !== 'DRAFT') bizError('已签署的明细不能删除')
  await db.collection(C.lines).doc(lineId).remove()
  return ok({ removed: lineId })
}

// UC05 签署确认：确认后锁定，前台无写权限
handlers['visitTreatment.confirm'] = async ({ visitId }) => {
  const lines = await db.collection(C.lines).where({ visit_id: visitId, status: 'DRAFT' }).limit(100).get()
  if (!lines.data.length) bizError('没有待签署的明细')
  for (const l of lines.data) {
    await db.collection(C.lines).doc(l._id).update({ data: { status: 'CONFIRMED', confirmed_at: Date.now() } })
  }
  await db.collection(C.visits).doc(visitId).update({ data: { status: 'DONE', done_at: Date.now() } })
  return ok({ confirmed: lines.data.length })
}

/* ------------------------------ 结算 ------------------------------ */

// UC06 生成结算单：一就诊一单，重复提交返回原单号（幂等）
handlers['invoice.create'] = async ({ visitId }) => {
  // 缺 visitId 时 where 条件会被 SDK 抹掉，反而命中任意一张有效结算单，
  // 让人以为「开单成功」，实际返回的是别人的单子。必须先拦住。
  visitId = needParam(visitId, '要开单的就诊记录')
  const exist = await db.collection(C.invoices).where({ visit_id: visitId, status: 'VALID' }).get()
  if (exist.data.length) return ok({ ...exist.data[0], reused: true })

  const visit = (await db.collection(C.visits).doc(visitId).get()).data
  if (!visit) bizError('就诊不存在', 404)

  const lines = await db.collection(C.lines).where({ visit_id: visitId, status: 'CONFIRMED' }).limit(100).get()
  if (!lines.data.length) bizError('治疗未签署，不能开单')

  const draft = await db.collection(C.lines).where({ visit_id: visitId, status: 'DRAFT' }).count()
  if (draft.total > 0) bizError('还有未确认的治疗项，请先签署')

  const today = cnYmd()
  const total = money(lines.data.reduce((s, l) => s + l.subtotal, 0))

  const doc = {
    invoice_no: await nextNo('I', C.invoices, 'invoice_no', today),
    visit_id: visitId,
    patient_id: visit.patient_id,
    patient_name: visit.patient_name,
    clinic_id: visit.clinic_id,
    dentist_id: visit.dentist_id,       // 收入归接到接诊牙医
    dentist_name: visit.dentist_name,
    biz_date: today,
    period: quarterOf(today),
    lines: lines.data.map((l) => ({
      line_id: l._id,
      treatment_id: l.treatment_id,
      name: l.name,
      units: l.units,
      unit_price: l.unit_price,
      subtotal: l.subtotal
    })),
    total,
    version: 1,
    status: 'VALID',
    created_at: Date.now()
  }
  const r = await db.collection(C.invoices).add({ data: doc })
  await db.collection(C.visits).doc(visitId).update({ data: { status: 'INVOICED', invoice_id: r._id } })
  return ok({ _id: r._id, ...doc })
}

handlers['invoice.get'] = async ({ invoiceId }) => {
  invoiceId = needParam(invoiceId, '要查看的结算单')
  const r = await db.collection(C.invoices).doc(invoiceId).get()
  if (!r.data) bizError('结算单不存在', 404)
  return ok(r.data)
}

handlers['invoice.list'] = async ({ visitId, period, limit = 50 }) => {
  const w = { status: 'VALID' }
  if (visitId) w.visit_id = visitId
  if (period) w.period = period
  const r = await db.collection(C.invoices).where(w).orderBy('created_at', 'desc').limit(limit).get()
  return ok(r.data)
}

/* ------------------------------ 报表 ------------------------------ */

// UC11 取消率：分母只算已到期的有效预约，未来预约不进分母（T03）
handlers['report.dashboard'] = async ({ date }) => {
  const today = date || cnYmd()
  const all = await db.collection(C.appointments).orderBy('date', 'desc').limit(500).get()

  const due = all.data.filter((a) => a.date <= today && DUE.includes(a.status))
  const bucket = {}
  Object.values(ST).forEach((s) => (bucket[s] = 0))
  due.forEach((a) => (bucket[a.status] = (bucket[a.status] || 0) + 1))

  const future = all.data.filter((a) => a.date > today && a.status === ST.PENDING).length
  const denom = due.length

  const pct = (n) => (denom === 0 ? null : Math.round((n / denom) * 1000) / 10) // null 表示无适用数据

  return ok({
    today,
    denominator: denom,
    future_pending: future,
    counts: bucket,
    cancel_rate: pct(bucket[ST.CANCELLED] || 0),
    no_show_rate: pct(bucket[ST.NO_SHOW] || 0),
    verify_rate: pct(bucket[ST.VERIFY] || 0),
    today_list: all.data.filter((a) => a.date === today)
  })
}

// UC10 季度核算：净利润 = 收入 - 耗材成本 - 运营费用；10% 是基金，不自动分给个人
handlers['report.quarter'] = async ({ period }) => {
  const [invs, costs, dentists] = await Promise.all([
    db.collection(C.invoices).where({ period, status: 'VALID' }).limit(500).get(),
    db.collection(C.costs).where({ period }).limit(500).get(),
    db.collection(C.dentists).where({ active: true }).limit(50).get()
  ])

  const rows = dentists.data.map((d) => {
    const revenue = money(
      invs.data.filter((i) => i.dentist_id === d._id).reduce((s, i) => s + i.total, 0)
    )
    const supply = money(
      costs.data.filter((c) => c.dentist_id === d._id && c.type === 'SUPPLY').reduce((s, c) => s + c.amount, 0)
    )
    const opex = money(
      costs.data.filter((c) => c.dentist_id === d._id && c.type === 'OPEX').reduce((s, c) => s + c.amount, 0)
    )
    const pending = costs.data.filter((c) => c.dentist_id === d._id && c.type === 'UNALLOCATED').length
    return {
      dentist_id: d._id,
      dentist_name: d.name,
      emp_no: d.emp_no,
      revenue,
      supply,
      opex,
      net: money(revenue - supply - opex),
      pending_items: pending,
      invoice_count: invs.data.filter((i) => i.dentist_id === d._id).length
    }
  })

  const sum = (k) => money(rows.reduce((s, r) => s + r[k], 0))
  // 历史上可能有没填归属牙医的耗材 / 运营费：不能因为没落到牙医行就从合计里消失
  const unattributed = costs.data.filter(
    (c) => (c.type === 'SUPPLY' || c.type === 'OPEX') && !String(c.dentist_id || '').trim()
  )
  const extra = (t) => money(unattributed.filter((c) => c.type === t).reduce((s, c) => s + c.amount, 0))
  const revenue = sum('revenue')
  const supply = money(sum('supply') + extra('SUPPLY'))
  const opex = money(sum('opex') + extra('OPEX'))
  const net = money(revenue - supply - opex)
  // 任何一条待分摊费用（哪怕还没落到具体牙医）都让本期核算停在"待确认"
  const hasPending = costs.data.some((c) => c.type === 'UNALLOCATED') || unattributed.length > 0

  return ok({
    period,
    rows,
    total: { revenue, supply, opex, net },
    unattributed_count: unattributed.length,
    fund: net > 0 && !hasPending ? money(net * 0.1) : null, // 有待分摊时不出可分配结果
    fund_rate: 0.1,
    payable: hasPending ? '待确认' : '可核算'
  })
}

handlers['cost.list'] = async ({ period }) => {
  const r = await db.collection(C.costs).where(period ? { period } : {}).limit(200).get()
  return ok(r.data)
}

/* --------------------------- 患者端（小程序） --------------------------- */

// 小程序"假登录"：用手机号认人，不做短信验证码（大作业够用）
handlers['patient.me'] = async ({ phone }) => {
  if (!phone) bizError('请先填写手机号')
  const r = await db.collection(C.patients).where({ phone }).get()
  if (!r.data.length) return ok(null)
  return ok(r.data[0])
}

// 我的就诊记录（含结算单），按患者归集
handlers['visit.listByPhone'] = async ({ phone }) => {
  const ph = String(phone === undefined || phone === null ? '' : phone).trim()
  if (!ph) bizError('请填写患者手机号')
  const pr = await db.collection(C.patients).where({ phone: ph }).get()
  if (!pr.data.length) return ok({ patient: null, visits: [] })
  const patient = pr.data[0]

  const vs = await db
    .collection(C.visits)
    .where({ patient_id: patient._id })
    .orderBy('created_at', 'desc')
    .limit(50)
    .get()

  const invs = await db.collection(C.invoices).where({ patient_id: patient._id, status: 'VALID' }).limit(50).get()
  const invMap = {}
  invs.data.forEach((i) => (invMap[i.visit_id] = i))

  const visits = []
  for (const v of vs.data) {
    const lines = await db.collection(C.lines).where({ visit_id: v._id }).limit(50).get()
    visits.push({ ...v, lines: lines.data, invoice: invMap[v._id] || null })
  }
  return ok({ patient, visits })
}

/* --------------------- 患者端（小程序）· 身份与归属 --------------------- */

/**
 * 身份一律以云函数拿到的 OPENID 为准，前端传什么都不算数。
 * 账号与档案的映射存在 wechat_users：{ openid, patient_id }
 */
const getOpenId = () => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) bizError('未获取到微信身份，请在小程序内打开', 401)
  return OPENID
}

const getDoc = async (coll, id) => {
  if (!id) return null
  try {
    const r = await db.collection(coll).doc(id).get()
    return r.data || null
  } catch (e) {
    return null
  }
}

const wxUserOf = async (openid) => {
  const r = await db.collection(C.wxusers).where({ openid }).limit(1).get()
  return r.data[0] || null
}

/** 当前登录患者；未绑定抛 401，小程序据此跳登录页 */
const currentPatient = async () => {
  const openid = getOpenId()
  const u = await wxUserOf(openid)
  if (!u) bizError('请先登录', 401)
  const p = await getDoc(C.patients, u.patient_id)
  if (!p) bizError('档案不存在，请联系门店', 401)
  return p
}

/** 是否可自助取消 / 改约，由服务端判定，前端只负责展示 */
const apptView = (a) => ({
  ...a,
  canCancel: (a.status === ST.PENDING || a.status === ST.VERIFY) && !isPastSlot(a.date, a.start),
  canReschedule: a.status === ST.PENDING && !isPastSlot(a.date, a.start)
})

handlers['patient.session'] = async () => {
  const openid = getOpenId()
  const u = await wxUserOf(openid)
  if (!u) return ok({ bound: false })
  const p = await getDoc(C.patients, u.patient_id)
  if (!p) return ok({ bound: false })
  return ok({ bound: true, patient: p })
}

// 演示身份列表：不要求用户填写任何信息，直接给几份虚构档案供选择
// 返回的姓名与手机号都来自种子数据，不是用户输入
const maskPhone = (p) => String(p || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')

handlers['patient.demoList'] = async () => {
  const r = await db.collection(C.patients).limit(6).get()
  const list = []
  for (const p of r.data) {
    const cnt = await db.collection(C.appointments).where({ patient_id: p._id }).count()
    const tags = []
    if ((p.allergies || []).length) tags.push('有过敏记录')
    if (cnt.total) tags.push('有预约记录')
    if (!tags.length) tags.push('新到店演示档案')
    list.push({ _id: p._id, name: p.name, phoneMasked: maskPhone(p.phone), tags })
  }
  return ok({ list })
}

// 选择一个演示身份进入：只把 openid 与虚构档案关联，不收集姓名手机号
handlers['patient.demoLogin'] = async ({ patientId }) => {
  patientId = needParam(patientId, '要进入的演示身份')
  const p = await getDoc(C.patients, patientId)
  if (!p) bizError('演示档案不存在', 404)
  const openid = getOpenId()
  const exist = await wxUserOf(openid)
  if (exist) {
    await db.collection(C.wxusers).doc(exist._id).update({
      data: { patient_id: p._id, updated_at: Date.now() }
    })
  } else {
    await db.collection(C.wxusers).add({
      data: { openid, patient_id: p._id, created_at: Date.now() }
    })
  }
  return ok({ bound: true, patient: p })
}

// 首次登录绑定：手机号命中已有档案则核对姓名，未命中则新建档案（UC01 的线上入口）
// 小程序端已改为「选择演示身份」，本接口保留给网页端员工建档与历史数据兼容
handlers['patient.bind'] = async ({ name, phone }) => {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) bizError('手机号格式不正确')
  const nm = String(name || '').trim()
  if (nm.length < 2) bizError('请填写真实姓名')

  const openid = getOpenId()

  let patient = null
  const samePhone = await db.collection(C.patients).where({ phone }).limit(5).get()
  if (samePhone.data.length) {
    patient = samePhone.data.find((p) => p.name === nm)
    // 同一手机号不允许被不同姓名静默绑定，避免冒用他人档案
    if (!patient) bizError('该手机号已有档案且姓名不一致，请联系门店前台核对')
  } else {
    const doc = {
      name: nm,
      phone,
      dob: '',
      email: '',
      allergies: [],
      billing_address: '',
      emergency_name: '',
      emergency_phone: '',
      source: 'MINI',
      created_at: Date.now()
    }
    const r = await db.collection(C.patients).add({ data: doc })
    patient = { _id: r._id, ...doc }
  }

  // 一份患者档案只允许绑定一个微信号。
  // 否则 A 用自己手机号建档后，B 再填同一个手机号+姓名就能看到 A 的病历。
  const bound = await db.collection(C.wxusers).where({ patient_id: patient._id }).limit(5).get()
  if (bound.data.some((u) => u.openid !== openid)) {
    bizError('该档案已绑定其他微信账号，请联系门店前台核对', 403)
  }

  const exist = await wxUserOf(openid)
  if (exist) {
    await db.collection(C.wxusers).doc(exist._id).update({
      data: { patient_id: patient._id, updated_at: Date.now() }
    })
  } else {
    await db.collection(C.wxusers).add({
      data: { openid, patient_id: patient._id, created_at: Date.now() }
    })
  }

  return ok({ bound: true, patient })
}

handlers['patient.update'] = async (p) => {
  const me = await currentPatient()
  const allow = ['dob', 'email', 'billing_address', 'emergency_name', 'emergency_phone']
  const data = {}
  allow.forEach((k) => {
    if (p[k] !== undefined) data[k] = String(p[k]).trim()
  })
  if (!Object.keys(data).length) return ok(me)
  await db.collection(C.patients).doc(me._id).update({ data })
  return ok((await getDoc(C.patients, me._id)) || me)
}

// 患者自报过敏：只能是"待核实"，核实动作在门店端
handlers['patient.allergy.add'] = async ({ name }) => {
  const me = await currentPatient()
  const n = String(name || '').trim()
  if (!n) bizError('请填写过敏原')
  const list = me.allergies || []
  if (list.some((a) => a.name === n)) bizError('该过敏原已登记')
  const next = list.concat([{ name: n, confirmed: false, source: 'PATIENT', created_at: Date.now() }])
  await db.collection(C.patients).doc(me._id).update({ data: { allergies: next } })
  return ok({ ...me, allergies: next })
}

// 已核实的过敏记录不允许患者自行删除，防止诊疗安全信息被抹掉
handlers['patient.allergy.remove'] = async ({ name }) => {
  const me = await currentPatient()
  const list = me.allergies || []
  const item = list.find((a) => a.name === name)
  if (!item) return ok(me)
  if (item.confirmed) bizError('门店已核实过的过敏记录不能自行删除，请联系前台')
  const next = list.filter((a) => a.name !== name)
  await db.collection(C.patients).doc(me._id).update({ data: { allergies: next } })
  return ok({ ...me, allergies: next })
}

handlers['appointment.mine'] = async () => {
  const me = await currentPatient()
  const r = await db.collection(C.appointments).where({ patient_id: me._id }).limit(100).get()
  const list = r.data.sort((a, b) => (a.date + a.start < b.date + b.start ? 1 : -1))
  return ok(list.map(apptView))
}

handlers['appointment.mine.next'] = async () => {
  const me = await currentPatient()
  const today = cnYmd()
  const r = await db
    .collection(C.appointments)
    .where({ patient_id: me._id, status: ST.PENDING, date: _.gte(today) })
    .limit(20)
    .get()
  const list = r.data
    .filter((a) => !isPastSlot(a.date, a.start))
    .sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1))
  return ok(list[0] ? apptView(list[0]) : null)
}

handlers['appointment.cancelSelf'] = async ({ appointmentId, reason }) => {
  const me = await currentPatient()
  const a = await getDoc(C.appointments, appointmentId)
  if (!a) bizError('预约不存在', 404)
  if (a.patient_id !== me._id) bizError('无权操作该预约', 403)
  if (![ST.PENDING, ST.VERIFY].includes(a.status)) bizError('当前状态不能自助取消，请联系门店')
  if (isPastSlot(a.date, a.start)) bizError('预约时间已过，不能再自助取消，请联系门店')

  await db.collection(C.appointments).doc(appointmentId).update({
    data: {
      status: ST.CANCELLED,
      status_reason: reason || '患者自助取消',
      status_by: 'PATIENT',
      slot_key: releasedKey(a, appointmentId),
      status_at: Date.now()
    }
  })
  return ok(apptView({ ...a, status: ST.CANCELLED }))
}

// 改约：新增一条记录 + 原记录标记 RESCHEDULED，原单不删除
handlers['appointment.rescheduleSelf'] = async ({ appointmentId, date, start, dentistId }) => {
  const me = await currentPatient()
  const cur = await getDoc(C.appointments, appointmentId)
  if (!cur) bizError('预约不存在', 404)
  if (cur.patient_id !== me._id) bizError('无权操作该预约', 403)
  if (cur.status !== ST.PENDING) bizError('当前状态不允许改约')
  if (date < cnYmd()) bizError('不能改到过去的日期')

  const newDentistId = dentistId || cur.dentist_id
  const key = slotKey(newDentistId, date, start)
  if (await slotTakenByOther(key, appointmentId)) bizError('新时段已被占用，原预约继续有效', 409)

  // 改约同样要守住门店、排班和「不能改到过去」
  await assertBookable({ clinicId: cur.clinic_id, dentistId: newDentistId, date, start })

  const dentist = await getDoc(C.dentists, newDentistId)
  const doc = {
    ...cur,
    dentist_id: newDentistId,
    dentist_name: (dentist && dentist.name) || cur.dentist_name,
    date,
    start,
    end: toHHMM(toMin(start) + SLOT_MIN),
    slot_key: key,
    status: ST.PENDING,
    attended: false,
    rescheduled_from: appointmentId,
    created_at: Date.now()
  }
  delete doc._id
  // 与后台改约同一套顺序：先释放原单时段，再插入新单，失败要能回滚
  const oldKey = cur.slot_key || slotKey(cur.dentist_id, cur.date, cur.start)
  await db.collection(C.appointments).doc(appointmentId).update({
    data: { status: ST.RESCHEDULED, slot_key: releasedKey(cur, appointmentId), status_at: Date.now() }
  })
  let r
  try {
    r = await db.collection(C.appointments).add({ data: doc })
  } catch (e) {
    await db.collection(C.appointments).doc(appointmentId).update({
      data: { status: cur.status, slot_key: oldKey, status_at: cur.status_at || Date.now() }
    })
    throw e
  }
  await db.collection(C.appointments).doc(appointmentId).update({ data: { rescheduled_to: r._id } })
  return ok({ appointment_id: r._id })
}

// 我的就诊记录：只返回本人的，治疗行与结算单一并带出
handlers['visit.mine'] = async () => {
  const me = await currentPatient()
  const [vs, clinics] = await Promise.all([
    db.collection(C.visits).where({ patient_id: me._id }).orderBy('created_at', 'desc').limit(50).get(),
    db.collection(C.clinics).limit(50).get()
  ])
  const clinicMap = {}
  clinics.data.forEach((c) => (clinicMap[c._id] = c.name))

  const invs = await db.collection(C.invoices).where({ patient_id: me._id, status: 'VALID' }).limit(50).get()
  const invMap = {}
  invs.data.forEach((i) => (invMap[i.visit_id] = i))

  const visits = []
  for (const v of vs.data) {
    const lines = await db.collection(C.lines).where({ visit_id: v._id }).limit(50).get()
    visits.push({
      ...v,
      clinic_name: clinicMap[v.clinic_id] || '',
      lines: lines.data,
      invoice: invMap[v._id] || null
    })
  }
  return ok({ patient: me, visits })
}

handlers['invoice.mine'] = async ({ invoiceId }) => {
  const me = await currentPatient()
  const inv = await getDoc(C.invoices, invoiceId)
  if (!inv || inv.status !== 'VALID') bizError('结算单不存在', 404)
  if (inv.patient_id !== me._id) bizError('无权查看该结算单', 403)
  return ok(inv)
}

/* ------------------------------ 门店 / 牙医 ------------------------------ */

handlers['clinic.list'] = async () => {
  const r = await db.collection(C.clinics).where({ active: true }).limit(50).get()
  return ok(r.data)
}

handlers['clinic.get'] = async ({ clinicId }) => {
  const clinic = await getDoc(C.clinics, clinicId)
  if (!clinic) bizError('门店不存在', 404)
  const ds = await db.collection(C.dentists).where({ active: true, clinic_ids: clinicId }).limit(50).get()
  return ok({ clinic, dentists: ds.data })
}

handlers['dentist.list'] = async ({ clinicId }) => {
  const w = { active: true }
  if (clinicId) w.clinic_ids = clinicId
  const [ds, clinics] = await Promise.all([
    db.collection(C.dentists).where(w).limit(50).get(),
    db.collection(C.clinics).where({ active: true }).limit(50).get()
  ])
  return ok(
    ds.data.map((d) => ({
      ...d,
      clinics: clinics.data.filter((c) => (d.clinic_ids || []).includes(c._id))
    }))
  )
}

handlers['dentist.get'] = async ({ dentistId }) => {
  const d = await getDoc(C.dentists, dentistId)
  if (!d) bizError('牙医不存在', 404)
  const clinics = await db.collection(C.clinics).where({ active: true }).limit(50).get()
  return ok({ dentist: d, clinics: clinics.data.filter((c) => (d.clinic_ids || []).includes(c._id)) })
}

// 退出登录 = 解除当前微信与档案的绑定，下次需重新用手机号登录
handlers['auth.logout'] = async () => {
  const openid = getOpenId()
  const u = await wxUserOf(openid)
  if (u) await db.collection(C.wxusers).doc(u._id).remove()
  return ok({ ok: true })
}

/* --------------------------- 员工身份与权限 --------------------------- */
/**
 * Web 员工端与小程序患者端是两套身份体系：
 *  - 患者端：getWXContext().OPENID → wechat_users → patients（前端无法伪造）
 *  - 员工端：账号密码 → staff_sessions.token → staff.role
 * 员工端写操作统一在入口做 token 校验 + 角色 ACL，前端不参与权限判断。
 */
const SESSION_TTL = 8 * 60 * 60 * 1000
const hashPwd = (pwd, salt) => crypto.scryptSync(String(pwd), salt, 32).toString('hex')
const newToken = () => crypto.randomBytes(32).toString('hex')
const ROLE_NAME = { DESK: '前台', DENTIST: '牙医', FINANCE: '财务', OPERATIONS: '运营', MANAGER: '总部经理' }

const publicStaff = (u) => ({
  _id: u._id, username: u.username, name: u.name, role: u.role,
  role_name: ROLE_NAME[u.role] || u.role,
  clinic_name: u.clinic_name || '', emp_no: u.emp_no || ''
})

// 需要员工 token 的 action。患者端 action（含 appointment.create 自助下单、
// clinic.list / dentist.list / meta.bootstrap 等字典读）刻意不在此列。
const STAFF_ONLY = new Set([
  'report.dashboard', 'appointment.list', 'appointment.changeStatus', 'appointment.reschedule',
  'visit.checkin', 'visit.byAppointment', 'visit.get',
  'visitTreatment.add', 'visitTreatment.remove', 'visitTreatment.confirm',
  'invoice.create', 'invoice.get', 'invoice.list',
  'report.quarter', 'cost.list', 'cost.add',
  'patient.me', 'patient.create', 'patient.allergy.confirm', 'visit.listByPhone',
  'dict.upsert', 'qual.list', 'staff.session', 'staff.logout'
])

const ROLE_ACL = {
  DESK: [
    'report.dashboard', 'appointment.list', 'appointment.changeStatus', 'appointment.reschedule',
    'visit.checkin', 'visit.byAppointment', 'visit.get',
    'patient.me', 'patient.create', 'patient.allergy.confirm', 'visit.listByPhone',
    'clinic.list', 'clinic.get', 'dentist.list', 'dentist.get', 'meta.bootstrap'
  ],
  DENTIST: [
    'report.dashboard', 'visit.byAppointment', 'visit.get',
    'visitTreatment.add', 'visitTreatment.remove', 'visitTreatment.confirm',
    'patient.me', 'patient.allergy.confirm', 'visit.listByPhone',
    'clinic.list', 'dentist.list', 'meta.bootstrap'
  ],
  FINANCE: [
    'report.dashboard', 'report.quarter', 'invoice.create', 'invoice.get', 'invoice.list',
    'cost.list', 'cost.add', 'visit.byAppointment', 'visit.get', 'meta.bootstrap'
  ],
  OPERATIONS: [
    'report.dashboard', 'report.quarter', 'appointment.list', 'appointment.changeStatus',
    'appointment.reschedule', 'cost.list', 'cost.add', 'dict.upsert', 'qual.list',
    'clinic.list', 'clinic.get', 'dentist.list', 'dentist.get', 'meta.bootstrap'
  ],
  MANAGER: ['*']
}

const permit = (role, action) => {
  if (String(action).startsWith('staff.')) return true // 已登录即可查自己 / 退出
  const acl = ROLE_ACL[role] || []
  return acl[0] === '*' || acl.includes(action)
}

const requireStaff = async (token) => {
  if (!token) bizError('请先登录员工工作台', 401)
  let s = null
  try {
    const r = await db.collection(C.sessions).where({ token }).limit(1).get()
    s = r.data[0]
  } catch (e) {
    bizError('登录服务不可用，请确认已运行 seedStaff', 500)
  }
  if (!s || !s.expire_at || s.expire_at < Date.now()) bizError('登录已过期，请重新登录', 401)
  const u = await getDoc(C.staff, s.staff_id)
  if (!u || u.active === false) bizError('账号已停用，请联系管理员', 403)
  return u
}

/* --------------------------- 员工端登录 --------------------------- */

handlers['staff.login'] = async ({ username, password }) => {
  const uname = String(username || '').trim()
  if (!uname || !password) bizError('请输入账号和密码')
  let u = null
  try {
    const r = await db.collection(C.staff).where({ username: uname }).limit(1).get()
    u = r.data[0]
  } catch (e) {
    bizError('员工账号未初始化，请先部署并运行 seedStaff 云函数', 500)
  }
  if (!u || u.active === false) bizError('账号或密码不正确', 401)
  if (hashPwd(password, u.salt) !== u.password_hash) bizError('账号或密码不正确', 401)
  const token = newToken()
  try {
    await db.collection(C.sessions).add({
      data: { token, staff_id: u._id, role: u.role, expire_at: Date.now() + SESSION_TTL, created_at: Date.now() }
    })
  } catch (e) {
    bizError('会话服务不可用，请确认已运行 seedStaff', 500)
  }
  return ok({ token, staff: publicStaff(u) })
}

handlers['staff.session'] = async ({ __staff }) => ok({ staff: publicStaff(__staff) })

handlers['staff.logout'] = async ({ __token }) => {
  try {
    if (__token) await db.collection(C.sessions).where({ token: __token }).remove()
  } catch (e) { /* 会话已失效时忽略 */ }
  return ok({ ok: true })
}

/* --------------------------- 员工端补充接口 --------------------------- */

// 前台建档（UC01）：复用患者端建档规则，禁止按手机号硬合并
handlers['patient.create'] = async (p) => ok(await findOrCreatePatient(p))

// 牙医核实患者自报过敏：confirmed 只能由员工端改
handlers['patient.allergy.confirm'] = async ({ patientId, name }) => {
  const p = await getDoc(C.patients, patientId)
  if (!p) bizError('患者不存在', 404)
  const allergies = (p.allergies || []).map((a) => (a.name === name ? { ...a, confirmed: true } : a))
  if (!allergies.some((a) => a.name === name)) bizError('该患者没有这条过敏记录')
  await db.collection(C.patients).doc(patientId).update({ data: { allergies } })
  return ok({ allergies })
}

// 成本 / 费用录入（T08/T09）：UNALLOCATED 会让本期基金停在「待确认」
handlers['cost.add'] = async ({ period, type, amount, dentistId, note, voucher }) => {
  const t = ['SUPPLY', 'OPEX', 'UNALLOCATED'].includes(type) ? type : 'UNALLOCATED'
  const amt = Number(amount)
  if (!amt || amt <= 0) bizError('金额必须大于 0')
  // 耗材 / 运营费必须落到具体牙医，否则这笔钱不会进任何牙医的成本行，季度净利润会虚高
  if (t !== 'UNALLOCATED' && !String(dentistId || '').trim()) {
    bizError('耗材 / 运营费必须选择归属牙医；暂时无法归属的请选「待分摊」')
  }
  if (t !== 'UNALLOCATED' && !(await getDoc(C.dentists, String(dentistId)))) {
    bizError('归属牙医不存在', 404)
  }
  const doc = {
    period: period || quarterOf(cnYmd()),
    type: t,
    amount: money(amt),
    dentist_id: t === 'UNALLOCATED' ? '' : String(dentistId || ''),
    note: String(note || '').trim(),
    voucher: String(voucher || '').trim(),
    created_at: Date.now()
  }
  const r = await db.collection(C.costs).add({ data: doc })
  return ok({ _id: r._id, ...doc })
}

// 字典维护：只允许改这四类目录集合
handlers['dict.upsert'] = async ({ coll, doc }) => {
  const allow = ['clinics', 'dentists', 'treatments', 'qualifications']
  if (!allow.includes(coll)) bizError('不允许修改该集合', 403)
  const data = { ...doc }
  delete data._id
  delete data._openid
  if (doc._id) {
    await db.collection(coll).doc(doc._id).update({ data })
    return ok({ _id: doc._id, ...data })
  }
  // 新增时防止同一编码 / 工号重复建档（重复工号会让牙医账号和排班对不上人）
  const uniq = coll === 'clinics' ? 'code' : coll === 'dentists' ? 'emp_no' : ''
  if (uniq && String(data[uniq] || '').trim()) {
    const dup = await db.collection(coll).where({ [uniq]: String(data[uniq]).trim() }).limit(1).get()
    if (dup.data.length) bizError(`${uniq === 'code' ? '门店编码' : '工号'}「${data[uniq]}」已存在，不能重复建档`)
  }
  const r = await db.collection(coll).add({ data: { active: true, ...data } })
  return ok({ _id: r._id, active: true, ...data })
}

handlers['qual.list'] = async () => {
  const r = await db.collection(C.quals).limit(100).get()
  return ok(r.data)
}

/* ------------------------ 需求符合性补强（UC01/02/07/08/09/10/12） ------------------------
 * 独立模块，只包装与新增 action，不改上面 44 个业务实现。
 * 对应说明见 enhance.js 文件头与 docs/需求符合性检查.md。
 */
const enhanced = require('./enhance')(handlers, {
  db, C, _, bizError, ok, ymd, quarterOf, getDoc,
  HOLDING, toMin, toHHMM, SLOT_MIN,
  STAFF_ONLY, ROLE_ACL, ROLE_NAME, todayYmd: cnYmd
})

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const { action, payload = {} } = event
  const handler = handlers[action]
  if (!handler) return fail(`未知操作: ${action}`, 404)
  let next = payload
  let denied = false
  try {
    if (STAFF_ONLY.has(action)) {
      const token = payload.__token || ''
      const staff = await requireStaff(token)
      if (!permit(staff.role, action)) {
        // T10：越权请求要留下操作者与动作，不能只拒绝不留痕
        denied = true
        await enhanced.writeAudit(action, { ...payload, __staff: staff }, cloud.getWXContext(), 'FAIL', '越权请求被拒绝')
        bizError(`「${ROLE_NAME[staff.role] || staff.role}」无权执行此操作`, 403)
      }
      next = { ...payload, __staff: staff, __token: token }
    }
    return await handler(next, cloud.getWXContext())
  } catch (e) {
    const raw = String((e && e.message) || '服务异常')
    // 云开发读不存在的文档时抛的是 SDK 异常（默认会被当成 500）。这其实是业务上的
    // 「记录不存在」，必须按 404 返回：否则网页会把一次数据过期误判成「云端不可用」，
    // 整页降级到演示数据，用户随后拿着演示 ID 继续操作就会连环失败。
    const missing = /does not exist|not exist|not found|DOCUMENT_NOT_FOUND/i.test(raw)
    // 并发抢同一格时唯一索引会抛 Duplicate key：这是「时段被占」而不是服务故障
    const dupKey = /duplicate key|uniq_slot_key/i.test(raw)
    let msg = raw
    let code = e.bizCode || 500
    if (missing) { msg = '记录不存在或已被删除，请刷新页面后重试'; code = 404 }
    else if (dupKey) { msg = '该时段刚被别的预约占用，请换一个时段'; code = 409 }
    if (!denied) {
      await enhanced.writeAudit(action, next, cloud.getWXContext(), 'FAIL', msg)
    }
    return fail(msg, code)
  }
}
