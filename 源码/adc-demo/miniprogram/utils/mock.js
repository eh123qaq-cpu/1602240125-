/**
 * 本地演示数据层（只在 config.envId 为空时启用）
 *
 * 目的：没有云环境也能把整套流程点通，方便开发期调试和验收演示。
 * 契约与 cloudfunctions/api 完全一致：同样的 action 名、同样的入参与返回结构，
 * 所以配置 envId 之后可以直接切到云端，页面代码一行都不用改。
 */
const KEY = 'adc_mock_v2'

const pad = (n) => (n < 10 ? '0' + n : '' + n)
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() + n)
  return x
}
const toMin = (s) => {
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}
const toHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
const money = (n) => Math.round(Number(n) * 100) / 100
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const WINDOWS = [['09:00', '12:00'], ['14:00', '17:30']]
const SLOT = 30

const slotsOf = () => {
  const out = []
  WINDOWS.forEach(([s, e]) => {
    for (let t = toMin(s); t + SLOT <= toMin(e); t += SLOT) out.push(toHHMM(t))
  })
  return out
}

const HOLDING = ['PENDING', 'ARRIVED', 'DONE']

function seed() {
  const today = ymd(new Date())
  const d1 = ymd(addDays(new Date(), -7))
  const d2 = ymd(addDays(new Date(), -1))

  const clinics = [
    {
      _id: 'clinic_tianhe',
      code: 'C-A',
      name: '安德鲁牙科·天河店',
      short_name: '天河店',
      address: '广州市天河区体育西路 88 号高德置地 3 层 301',
      phone: '020-8888-0001',
      hours: '09:00 - 18:00',
      lat: 23.1322,
      lng: 113.3245,
      area: 320,
      tags: ['种植修复', '显微根管', '儿童齿科'],
      intro: '连锁旗舰店，配备 8 台综合治疗椅与 CBCT 影像中心，可开展显微根管、即刻种植与全口修复。',
      active: true
    },
    {
      _id: 'clinic_yuexiu',
      code: 'C-B',
      name: '安德鲁牙科·越秀店',
      short_name: '越秀店',
      address: '广州市越秀区中山五路 12 号 2 层 205',
      phone: '020-8888-0002',
      hours: '09:00 - 18:00',
      lat: 23.1291,
      lng: 113.2644,
      area: 260,
      tags: ['牙周治疗', '美学修复', '舒适洁牙'],
      intro: '社区型门诊，主打牙周维护与美学修复，提供周末延时服务。',
      active: true
    }
  ]

  const dentists = [
    {
      _id: 'dentist_chen',
      emp_no: 'D-01',
      name: '陈嘉明',
      title: '主治医师',
      years: 12,
      clinic_ids: ['clinic_tianhe', 'clinic_yuexiu'],
      qual_names: ['显微根管', '牙体修复'],
      intro: '从业 12 年，累计完成显微根管治疗 3000 余例，擅长疑难根管再治疗。',
      active: true
    },
    {
      _id: 'dentist_lin',
      emp_no: 'D-02',
      name: '林芷若',
      title: '副主任医师',
      years: 16,
      clinic_ids: ['clinic_tianhe'],
      qual_names: ['口腔种植', '美学修复'],
      intro: '副主任医师，专注前牙美学种植与全口重建，广东省口腔医学会种植专委会委员。',
      active: true
    },
    {
      _id: 'dentist_huang',
      emp_no: 'D-03',
      name: '黄启文',
      title: '医师',
      years: 6,
      clinic_ids: ['clinic_yuexiu'],
      qual_names: ['儿童齿科', '预防保健'],
      intro: '擅长儿童行为诱导与窝沟封闭，接诊 3-12 岁患儿。',
      active: true
    }
  ]

  const treatments = [
    { _id: 't_clean', name: '全口洁牙', unit_price: 200, active: true },
    { _id: 't_xray', name: '检查影像', unit_price: 120, active: true },
    { _id: 't_fill', name: '树脂充填', unit_price: 380, active: true },
    { _id: 't_rct', name: '根管治疗', unit_price: 1200, active: true },
    { _id: 't_ext', name: '拔牙', unit_price: 300, active: true },
    { _id: 't_seal', name: '窝沟封闭', unit_price: 150, active: true },
    { _id: 't_white', name: '牙齿美白', unit_price: 1500, active: true }
  ]

  const patients = [
    {
      _id: 'p_lin',
      name: '林小雅',
      phone: '13800000001',
      dob: '1994-03-18',
      email: '',
      billing_address: '广州市天河区体育西路 88 号',
      emergency_name: '林建国',
      emergency_phone: '13900000011',
      allergies: [
        { name: '青霉素', confirmed: true, source: 'CLINIC', created_at: Date.now() - 86400000 * 90 },
        { name: '乳胶', confirmed: false, source: 'PATIENT', created_at: Date.now() - 86400000 * 3 }
      ]
    },
    {
      _id: 'p_zhang',
      name: '张家明',
      phone: '13800000002',
      dob: '1988-11-02',
      email: 'zhang@demo.cn',
      allergies: [],
      billing_address: '',
      emergency_name: '',
      emergency_phone: ''
    },
    { _id: 'p_li', name: '李慧', phone: '13800000003', dob: '1999-07-25', email: '', allergies: [], billing_address: '', emergency_name: '', emergency_phone: '' },
    { _id: 'p_wang', name: '王浩然', phone: '13800000004', dob: '1976-01-09', email: '', allergies: [{ name: '磺胺类', confirmed: true, source: 'CLINIC', created_at: Date.now() }], billing_address: '', emergency_name: '', emergency_phone: '' }
  ]

  const mkAppt = (o) => ({
    date: o.date,
    start: o.start,
    attended: false,
    source: 'MINI',
    need: '',
    special_need: '',
    status: 'PENDING',
    slot_key: `${o.dentist_id}|${o.date}|${o.start}`,
    end: toHHMM(toMin(o.start) + SLOT),
    created_at: Date.now()
  })

  const appts = [
    Object.assign(
      mkAppt({ date: today, start: '09:30', dentist_id: 'dentist_chen' }),
      { _id: 'ap_done', patient_id: 'p_lin', patient_name: '林小雅', patient_phone: '13800000001', clinic_id: 'clinic_tianhe', clinic_name: '安德鲁牙科·天河店', dentist_name: '陈嘉明', status: 'DONE', attended: true, need: '洗牙' }
    ),
    Object.assign(
      mkAppt({ date: today, start: '14:00', dentist_id: 'dentist_lin' }),
      { _id: 'ap_li', patient_id: 'p_li', patient_name: '李慧', patient_phone: '13800000003', clinic_id: 'clinic_tianhe', clinic_name: '安德鲁牙科·天河店', dentist_name: '林芷若', status: 'PENDING', need: '种植咨询' }
    ),
    Object.assign(
      mkAppt({ date: ymd(addDays(new Date(), 2)), start: '10:30', dentist_id: 'dentist_chen' }),
      { _id: 'ap_future', patient_id: 'p_lin', patient_name: '林小雅', patient_phone: '13800000001', clinic_id: 'clinic_tianhe', clinic_name: '安德鲁牙科·天河店', dentist_name: '陈嘉明', status: 'PENDING', need: '复查' }
    ),
    Object.assign(
      mkAppt({ date: d2, start: '11:00', dentist_id: 'dentist_huang' }),
      { _id: 'ap_cancel', patient_id: 'p_lin', patient_name: '林小雅', patient_phone: '13800000001', clinic_id: 'clinic_yuexiu', clinic_name: '安德鲁牙科·越秀店', dentist_name: '黄启文', status: 'CANCELLED', status_reason: '患者临时有事' }
    ),
    Object.assign(
      mkAppt({ date: d2, start: '15:00', dentist_id: 'dentist_lin' }),
      { _id: 'ap_noshow', patient_id: 'p_zhang', patient_name: '张家明', patient_phone: '13800000002', clinic_id: 'clinic_tianhe', clinic_name: '安德鲁牙科·天河店', dentist_name: '林芷若', status: 'NO_SHOW' }
    ),
    Object.assign(
      mkAppt({ date: d1, start: '10:00', dentist_id: 'dentist_lin' }),
      { _id: 'ap_past', patient_id: 'p_lin', patient_name: '林小雅', patient_phone: '13800000001', clinic_id: 'clinic_tianhe', clinic_name: '安德鲁牙科·天河店', dentist_name: '林芷若', status: 'DONE', attended: true, need: '根管治疗' }
    )
  ]

  const visits = [
    {
      _id: 'v_done',
      visit_no: `V${today.replace(/-/g, '')}-001`,
      appointment_id: 'ap_done',
      patient_id: 'p_lin',
      patient_name: '林小雅',
      clinic_id: 'clinic_tianhe',
      clinic_name: '安德鲁牙科·天河店',
      dentist_id: 'dentist_chen',
      dentist_name: '陈嘉明',
      special_need: '怕疼，需告知每一步操作',
      status: 'INVOICED',
      created_at: Date.now() - 3600000 * 5
    },
    {
      _id: 'v_past',
      visit_no: `V${d1.replace(/-/g, '')}-003`,
      appointment_id: 'ap_past',
      patient_id: 'p_lin',
      patient_name: '林小雅',
      clinic_id: 'clinic_tianhe',
      clinic_name: '安德鲁牙科·天河店',
      dentist_id: 'dentist_lin',
      dentist_name: '林芷若',
      special_need: '',
      status: 'INVOICED',
      created_at: Date.now() - 86400000 * 7
    }
  ]

  const lines = [
    { _id: 'l1', visit_id: 'v_done', treatment_id: 't_clean', name: '全口洁牙', units: 1, unit_price: 200, subtotal: 200, created_at: Date.now() - 3600000 * 4 },
    { _id: 'l2', visit_id: 'v_done', treatment_id: 't_xray', name: '检查影像', units: 1, unit_price: 120, subtotal: 120, created_at: Date.now() - 3600000 * 3 },
    { _id: 'l3', visit_id: 'v_past', treatment_id: 't_rct', name: '根管治疗', units: 1, unit_price: 1200, subtotal: 1200, created_at: Date.now() - 86400000 * 7 },
    { _id: 'l4', visit_id: 'v_past', treatment_id: 't_fill', name: '树脂充填', units: 1, unit_price: 380, subtotal: 380, created_at: Date.now() - 86400000 * 7 }
  ]

  const invoices = [
    {
      _id: 'inv_done',
      invoice_no: `I${today.replace(/-/g, '')}-001`,
      visit_id: 'v_done',
      patient_id: 'p_lin',
      patient_name: '林小雅',
      dentist_id: 'dentist_chen',
      dentist_name: '陈嘉明',
      clinic_id: 'clinic_tianhe',
      clinic_name: '安德鲁牙科·天河店',
      biz_date: today,
      total: 320,
      status: 'VALID',
      paid: false,
      lines: [
        { line_id: 'l1', name: '全口洁牙', units: 1, unit_price: 200, subtotal: 200 },
        { line_id: 'l2', name: '检查影像', units: 1, unit_price: 120, subtotal: 120 }
      ],
      created_at: Date.now() - 3600000 * 3
    },
    {
      _id: 'inv_past',
      invoice_no: `I${d1.replace(/-/g, '')}-003`,
      visit_id: 'v_past',
      patient_id: 'p_lin',
      patient_name: '林小雅',
      dentist_id: 'dentist_lin',
      dentist_name: '林芷若',
      clinic_id: 'clinic_tianhe',
      clinic_name: '安德鲁牙科·天河店',
      biz_date: d1,
      total: 1580,
      status: 'VALID',
      paid: true,
      lines: [
        { line_id: 'l3', name: '根管治疗', units: 1, unit_price: 1200, subtotal: 1200 },
        { line_id: 'l4', name: '树脂充填', units: 1, unit_price: 380, subtotal: 380 }
      ],
      created_at: Date.now() - 86400000 * 7
    }
  ]

  return { clinics, dentists, treatments, patients, appointments: appts, visits, lines, invoices, boundPhone: '' }
}

/* ------------------------------ 存储 ------------------------------ */

let state = null

const load = () => {
  if (state) return state
  try {
    const cached = wx.getStorageSync(KEY)
    if (cached && cached.clinics) {
      state = cached
      return state
    }
  } catch (e) {
    /* 忽略 */
  }
  state = seed()
  save()
  return state
}

const save = () => {
  try {
    wx.setStorageSync(KEY, state)
  } catch (e) {
    /* 忽略 */
  }
}

const reset = () => {
  state = seed()
  save()
  return state
}

/* ------------------------------ 工具 ------------------------------ */

const err = (msg, code = 400) => {
  const e = new Error(msg)
  e.code = code
  throw e
}

const current = () => {
  const s = load()
  return s.patients.find((p) => p.phone === s.boundPhone) || null
}

const apptView = (a) => ({
  ...a,
  canCancel: a.status === 'PENDING' || a.status === 'VERIFY',
  canReschedule: a.status === 'PENDING'
})

/* ------------------------------ 接口 ------------------------------ */

const handlers = {}

handlers['patient.session'] = () => {
  const me = current()
  if (!me) return { bound: false }
  return { bound: true, patient: me, avatar: '' }
}

const maskPhone = (p) => String(p || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')

handlers['patient.demoList'] = () => {
  const s = load()
  const list = s.patients.slice(0, 6).map((p) => {
    const tags = []
    if ((p.allergies || []).length) tags.push('有过敏记录')
    if (s.appointments.some((a) => a.patient_id === p._id)) tags.push('有预约记录')
    if (!tags.length) tags.push('新到店演示档案')
    return { _id: p._id, name: p.name, phoneMasked: maskPhone(p.phone), tags }
  })
  return { list }
}

handlers['patient.demoLogin'] = ({ patientId }) => {
  if (!patientId) err('请选择要进入的演示身份')
  const s = load()
  const p = s.patients.find((x) => x._id === patientId)
  if (!p) err('演示档案不存在', 404)
  s.boundPhone = p.phone
  save()
  return { bound: true, patient: p, avatar: '' }
}

handlers['patient.bind'] = ({ name, phone }) => {
  if (!/^1\d{10}$/.test(String(phone || ''))) err('手机号格式不正确')
  if (!name || String(name).trim().length < 2) err('请填写真实姓名')

  const s = load()
  const exist = s.patients.find((p) => p.phone === phone)
  if (exist) {
    if (exist.name !== String(name).trim()) err('该手机号已有档案，姓名不一致，请联系门店前台核对')
    s.boundPhone = phone
    save()
    return { bound: true, patient: exist }
  }
  const doc = {
    _id: uid('p'),
    name: String(name).trim(),
    phone,
    dob: '',
    email: '',
    allergies: [],
    billing_address: '',
    emergency_name: '',
    emergency_phone: ''
  }
  s.patients.push(doc)
  s.boundPhone = phone
  save()
  return { bound: true, patient: doc }
}

handlers['patient.update'] = (p) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const allow = ['dob', 'email', 'billing_address', 'emergency_name', 'emergency_phone']
  allow.forEach((k) => {
    if (p[k] !== undefined) me[k] = String(p[k]).trim()
  })
  save()
  return me
}

handlers['patient.allergy.add'] = ({ name }) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const n = String(name || '').trim()
  if (!n) err('请填写过敏原')
  if (me.allergies.some((a) => a.name === n)) err('该过敏原已登记')
  me.allergies.push({ name: n, confirmed: false, source: 'PATIENT', created_at: Date.now() })
  save()
  return me
}

handlers['patient.allergy.remove'] = ({ name }) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const item = me.allergies.find((a) => a.name === name)
  if (item && item.confirmed) err('门店已核实过的过敏记录不能自行删除，请联系前台')
  me.allergies = me.allergies.filter((a) => a.name !== name)
  save()
  return me
}

handlers['meta.bootstrap'] = () => {
  const s = load()
  return { clinics: s.clinics, dentists: s.dentists, treatments: s.treatments, qualifications: [] }
}

handlers['clinic.list'] = () => load().clinics.filter((c) => c.active)

handlers['clinic.get'] = ({ clinicId }) => {
  const c = load().clinics.find((x) => x._id === clinicId)
  if (!c) err('门店不存在', 404)
  return { clinic: c, dentists: load().dentists.filter((d) => d.clinic_ids.includes(clinicId)) }
}

handlers['dentist.list'] = ({ clinicId }) => {
  const s = load()
  const list = clinicId ? s.dentists.filter((d) => d.clinic_ids.includes(clinicId)) : s.dentists
  return list.map((d) => ({ ...d, clinics: s.clinics.filter((c) => d.clinic_ids.includes(c._id)) }))
}

handlers['dentist.get'] = ({ dentistId }) => {
  const s = load()
  const d = s.dentists.find((x) => x._id === dentistId)
  if (!d) err('牙医不存在', 404)
  return { dentist: d, clinics: s.clinics.filter((c) => d.clinic_ids.includes(c._id)) }
}

handlers['appointment.availableSlots'] = ({ clinicId, date }) => {
  const s = load()
  const today = ymd(new Date())
  if (!date || date < today) err('不能预约过去的日期')
  const ds = s.dentists.filter((d) => d.clinic_ids.includes(clinicId))
  const taken = new Set(
    s.appointments.filter((a) => a.clinic_id === clinicId && a.date === date && HOLDING.includes(a.status)).map((a) => a.slot_key)
  )
  return ds.map((d) => ({
    dentist_id: d._id,
    dentist_name: d.name,
    title: d.title,
    emp_no: d.emp_no,
    qual_names: d.qual_names,
    slots: slotsOf()
      .map((t) => ({ start: t, taken: taken.has(`${d._id}|${date}|${t}`) }))
      .filter((x) => !x.taken)
  }))
}

handlers['appointment.create'] = (p) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const s = load()
  const { clinicId, dentistId, date, start } = p
  if (!clinicId || !dentistId || !date || !start) err('预约信息不完整')
  if (date < ymd(new Date())) err('不能预约过去的日期')

  const key = `${dentistId}|${date}|${start}`
  if (s.appointments.some((a) => a.slot_key === key && HOLDING.includes(a.status))) {
    err('该时段刚被占用，请换一个时段', 409)
  }

  const clinic = s.clinics.find((c) => c._id === clinicId)
  const dentist = s.dentists.find((d) => d._id === dentistId)
  const doc = {
    _id: uid('ap'),
    patient_id: me._id,
    patient_name: me.name,
    patient_phone: me.phone,
    clinic_id: clinicId,
    clinic_name: clinic.name,
    dentist_id: dentistId,
    dentist_name: dentist.name,
    date,
    start,
    end: toHHMM(toMin(start) + SLOT),
    slot_key: key,
    need: p.need || '',
    special_need: p.special_need || '',
    attended: false,
    status: 'PENDING',
    source: 'MINI',
    created_at: Date.now()
  }
  s.appointments.push(doc)
  save()
  return doc
}

handlers['appointment.mine'] = () => {
  const me = current()
  if (!me) err('请先登录', 401)
  const list = load()
    .appointments.filter((a) => a.patient_id === me._id)
    .sort((a, b) => (a.date + a.start < b.date + b.start ? 1 : -1))
  return list.map(apptView)
}

handlers['appointment.cancel'] = ({ appointmentId, reason }) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const s = load()
  const a = s.appointments.find((x) => x._id === appointmentId)
  if (!a) err('预约不存在', 404)
  if (a.patient_id !== me._id) err('无权操作该预约', 403)
  if (!['PENDING', 'VERIFY'].includes(a.status)) err('当前状态不能自助取消，请联系门店')
  a.status = 'CANCELLED'
  a.status_reason = reason || '患者自助取消'
  a.status_by = 'PATIENT'
  a.status_at = Date.now()
  save()
  return apptView(a)
}

handlers['appointment.reschedule'] = ({ appointmentId, date, start, dentistId }) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const s = load()
  const a = s.appointments.find((x) => x._id === appointmentId)
  if (!a) err('预约不存在', 404)
  if (a.patient_id !== me._id) err('无权操作该预约', 403)
  if (a.status !== 'PENDING') err('当前状态不允许改约')

  const nd = dentistId || a.dentist_id
  const key = `${nd}|${date}|${start}`
  if (s.appointments.some((x) => x.slot_key === key && HOLDING.includes(x.status))) {
    err('新时段已被占用，原预约继续有效', 409)
  }
  const dentist = s.dentists.find((d) => d._id === nd)
  const doc = {
    ...a,
    _id: uid('ap'),
    dentist_id: nd,
    dentist_name: dentist ? dentist.name : a.dentist_name,
    date,
    start,
    end: toHHMM(toMin(start) + SLOT),
    slot_key: key,
    status: 'PENDING',
    attended: false,
    rescheduled_from: appointmentId,
    created_at: Date.now()
  }
  s.appointments.push(doc)
  a.status = 'RESCHEDULED'
  a.rescheduled_to = doc._id
  a.status_at = Date.now()
  save()
  return doc
}

handlers['visit.mine'] = () => {
  const me = current()
  if (!me) err('请先登录', 401)
  const s = load()
  const visits = s.visits
    .filter((v) => v.patient_id === me._id)
    .sort((a, b) => b.created_at - a.created_at)
    .map((v) => ({
      ...v,
      lines: s.lines.filter((l) => l.visit_id === v._id),
      invoice: s.invoices.find((i) => i.visit_id === v._id && i.status === 'VALID') || null
    }))
  return { patient: me, visits }
}

handlers['invoice.mine'] = ({ invoiceId }) => {
  const me = current()
  if (!me) err('请先登录', 401)
  const inv = load().invoices.find((i) => i._id === invoiceId && i.status === 'VALID')
  if (!inv) err('结算单不存在', 404)
  if (inv.patient_id !== me._id) err('无权查看该结算单', 403)
  return inv
}

handlers['appointment.mine.next'] = () => {
  const me = current()
  if (!me) err('请先登录', 401)
  const today = ymd(new Date())
  const list = load()
    .appointments.filter((a) => a.patient_id === me._id && a.status === 'PENDING' && a.date >= today)
    .sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1))
  return list[0] ? apptView(list[0]) : null
}

handlers['auth.logout'] = () => {
  const s = load()
  s.boundPhone = ''
  save()
  return { ok: true }
}

handlers['demo.reset'] = () => {
  reset()
  return { ok: true }
}

// 与云函数同名，保证小程序端只写一套 action 名
handlers['appointment.cancelSelf'] = handlers['appointment.cancel']
handlers['appointment.rescheduleSelf'] = handlers['appointment.reschedule']

module.exports = {
  handle(action, payload) {
    const fn = handlers[action]
    if (!fn) return Promise.reject(new Error(`离线模式未实现：${action}`))
    try {
      return Promise.resolve(fn(payload || {}))
    } catch (e) {
      return Promise.reject(e)
    }
  }
}
