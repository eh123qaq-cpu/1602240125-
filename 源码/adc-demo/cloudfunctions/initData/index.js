/**
 * 演示数据初始化（可重复执行，会先清空业务集合）
 *
 * 目标：让三个演示流程一打开就有数据
 *   1. 小程序预约   —— 今天/明天的空时段
 *   2. 前台到诊 + 牙医加项目 —— 今天 6 条不同状态的预约
 *   3. 结算 + 季度报表 —— 本季度 9 张结算单，合计 200000，核算出净利润 105000 / 基金 10500
 *
 * 全部为演示数据（P-DEMO / D-DEMO），不含任何真实患者信息。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const COL = [
  'clinics', 'dentists', 'qualifications', 'patients',
  'appointments', 'visits', 'treatments', 'visit_treatments',
  'invoices', 'costs', 'wechat_users'
]

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const money = (n) => Math.round(Number(n) * 100) / 100
const addDays = (d, n) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
const quarterOf = (s) => {
  const [y, m] = s.split('-').map(Number)
  return `${y}Q${Math.ceil(m / 3)}`
}
// 30 分钟一格的结束时间
const endOf = (start) => {
  const [h, m] = start.split(':').map(Number)
  const t = h * 60 + m + 30
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`
}

// 云开发里集合不会自动创建，优先 createCollection，失败则用 add 触发自动建集合
const ensureCollections = async () => {
  const report = []
  for (const name of COL) {
    let ok = false

    try {
      await db.createCollection(name)
      report.push(name + ': createCollection ok')
      ok = true
    } catch (e) {
      const m = String((e && (e.errMsg || e.message)) || e)
      if (/exist/i.test(m)) {
        report.push(name + ': already exists')
        ok = true
      } else {
        report.push(name + ': createCollection -> ' + m.slice(0, 80))
      }
    }

    if (!ok) {
      try {
        await db.collection(name).limit(1).get()
        report.push(name + ': get ok')
        ok = true
      } catch (e) {
        try {
          const r = await db.collection(name).add({ data: { __probe: 1 } })
          await db.collection(name).doc(r._id).remove()
          report.push(name + ': add 触发建集合 ok')
          ok = true
        } catch (e2) {
          report.push(name + ': add -> ' + String((e2 && (e2.errMsg || e2.message)) || e2).slice(0, 80))
        }
      }
    }
  }
  return report
}

const clear = async (name) => {
  let guard = 0
  while (guard++ < 20) {
    let r
    try {
      r = await db.collection(name).limit(100).get()
    } catch (e) {
      const msg = String((e && (e.errMsg || e.message)) || e)
      // 集合不存在：不需要清
      if (/not found|not exist|-501001|-502005/i.test(msg)) return
      throw e
    }
    if (!r.data.length) return
    for (const d of r.data) await db.collection(name).doc(d._id).remove()
  }
}

const insert = async (name, docs) => {
  const ids = []
  for (const d of docs) {
    const r = await db.collection(name).add({ data: { ...d, created_at: Date.now() } })
    ids.push(r._id)
  }
  return ids
}

let __report = []

const seed = async () => {
  __report = await ensureCollections()
  const failed = __report
  for (const c of COL) await clear(c)

  const now = new Date()
  const today = ymd(now)
  const period = quarterOf(today)

  /* 1. 诊所 */
  const clinicDocs = [
    {
      code: 'C-A', name: 'ADC 安德鲁牙科·天河店', short_name: '天河店',
      address: '广州市天河区体育西路 88 号高德置地 3 层 301', manager: '周敏',
      phone: '020-8888-0001', email: 'tianhe@adc-demo.cn', area: 320,
      hours: '09:00 - 18:00', lat: 23.1322, lng: 113.3245,
      tags: ['种植修复', '显微根管', '儿童齿科'],
      intro: '连锁旗舰店，配备 8 台综合治疗椅与 CBCT 影像中心，可开展显微根管、即刻种植与全口修复。',
      active: true
    },
    {
      code: 'C-B', name: 'ADC 安德鲁牙科·越秀店', short_name: '越秀店',
      address: '广州市越秀区中山五路 12 号 2 层 205', manager: '黄立',
      phone: '020-8888-0002', email: 'yuexiu@adc-demo.cn', area: 260,
      hours: '09:00 - 18:00', lat: 23.1291, lng: 113.2644,
      tags: ['牙周治疗', '美学修复', '舒适洁牙'],
      intro: '社区型门诊，主打牙周维护与美学修复，提供周末延时服务。',
      active: true
    }
  ]
  const clinicIds = await insert('clinics', clinicDocs)
  const [CA, CB] = clinicIds

  /* 2. 资质目录（多对多的一端） */
  const qualDocs = [
    { code: 'Q-ENDO', name: '牙髓病学' },
    { code: 'Q-PATH', name: '口腔病理学' },
    { code: 'Q-RAD', name: '口腔放射学' },
    { code: 'Q-PEDO', name: '儿童牙科' },
    { code: 'Q-IMPL', name: '口腔种植' }
  ]
  const qualIds = await insert('qualifications', qualDocs)

  /* 3. 牙医（不隶属单店，qualification_ids 为多对多；clinic_ids 为出诊门店） */
  const dentistDocs = [
    {
      emp_no: 'D-DEMO-01', name: '陈安', title: '主治医师', years: 12,
      dob: '1985-03-12', address: '广州市天河区', phone: '13900000001',
      email: 'chen@adc-demo.cn', clinic_ids: [CA, CB], qualification_ids: [qualIds[0], qualIds[4]],
      qual_names: ['牙髓病学', '口腔种植'],
      intro: '从业 12 年，累计完成显微根管治疗 3000 余例，擅长疑难根管再治疗与种植修复。',
      active: true
    },
    {
      emp_no: 'D-DEMO-02', name: '李敏', title: '副主任医师', years: 16,
      dob: '1990-07-21', address: '广州市越秀区', phone: '13900000002',
      email: 'li@adc-demo.cn', clinic_ids: [CA, CB], qualification_ids: [qualIds[3], qualIds[2]],
      qual_names: ['儿童牙科', '口腔放射学'],
      intro: '副主任医师，擅长儿童行为诱导与早期咬合管理，接诊 3-12 岁患儿。',
      active: true
    },
    {
      emp_no: 'D-DEMO-03', name: '王强', title: '医师', years: 6,
      dob: '1982-11-02', address: '广州市海珠区', phone: '13900000003',
      email: 'wang@adc-demo.cn', clinic_ids: [CB], qualification_ids: [qualIds[1]],
      qual_names: ['口腔病理学'],
      intro: '专注口腔黏膜病与牙周基础治疗。',
      active: true
    }
  ]
  const dentistIds = await insert('dentists', dentistDocs)
  const [D1, D2, D3] = dentistIds

  /* 4. 治疗项目目录 */
  const treatDocs = [
    { code: 'T-CLEAN', name: '洗牙', unit_price: 200, standard_unit: '次', active: true },
    { code: 'T-XRAY', name: '检查影像', unit_price: 120, standard_unit: '单位', active: true },
    { code: 'T-FILL', name: '树脂充填', unit_price: 380, standard_unit: '颗', active: true },
    { code: 'T-CROWN', name: '全瓷牙冠', unit_price: 1800, standard_unit: '颗', active: true },
    { code: 'T-IMPL', name: '种植体植入', unit_price: 8000, standard_unit: '颗', active: true },
    { code: 'T-ORTHO', name: '隐形正畸疗程', unit_price: 24000, standard_unit: '疗程', active: true },
    { code: 'T-POLISH', name: '抛光', unit_price: 150, standard_unit: '次', active: true }
  ]
  const treatIds = await insert('treatments', treatDocs)

  /* 5. 患者（过敏逐项存；邮箱可空） */
  const patientDocs = [
    {
      name: '林小雅', phone: '13800000001', dob: '1994-05-08', billing_address: '广州市天河区体育东路 12 号',
      email: '', emergency_name: '林海', emergency_phone: '13800000009',
      allergies: [{ name: '乳胶', confirmed: true }, { name: '树脂', confirmed: true }]
    },
    {
      name: '张家明', phone: '13800000002', dob: '1988-09-17', billing_address: '广州市越秀区解放路 45 号',
      email: 'zhang@demo.cn', emergency_name: '张丽', emergency_phone: '13800000010',
      allergies: [{ name: '麻醉剂', confirmed: true }]
    },
    {
      name: '陈慧', phone: '13800000003', dob: '2001-02-25', billing_address: '广州市海珠区江南大道 8 号',
      email: '', emergency_name: '陈强', emergency_phone: '13800000011',
      allergies: []
    },
    {
      name: '黄志远', phone: '13800000004', dob: '1975-12-03', billing_address: '广州市天河区珠江新城 3 号',
      email: 'huang@demo.cn', emergency_name: '黄敏', emergency_phone: '13800000012',
      allergies: [{ name: '金属', confirmed: false }]
    }
  ]
  const patientIds = await insert('patients', patientDocs)

  /* 6. 今天的预约（覆盖 8 态里的 6 种，用于前台看板 + 取消率口径演示） */
  const slotKey = (d, date, start) => `${d}|${date}|${start}`
  const apRows = [
    { p: 0, d: D1, start: '09:00', status: 'ARRIVED', attended: true, need: '洗牙' },
    { p: 1, d: D1, start: '09:30', status: 'PENDING', attended: false, need: '补牙' },
    { p: 2, d: D2, start: '10:00', status: 'CANCELLED', attended: false, need: '洗牙' },
    { p: 3, d: D2, start: '14:00', status: 'NO_SHOW', attended: false, need: '复查' },
    { p: 0, d: D2, start: '15:00', status: 'PENDING', attended: false, need: '正畸咨询' },
    { p: 1, d: D3, start: '16:00', status: 'VERIFY', attended: false, need: '拔牙' }
  ]
  const apDocs = apRows.map((r) => ({
    patient_id: patientIds[r.p],
    patient_name: patientDocs[r.p].name,
    patient_phone: patientDocs[r.p].phone,
    clinic_id: r.d === D3 ? CB : CA,
    clinic_name: r.d === D3 ? clinicDocs[1].name : clinicDocs[0].name,
    dentist_id: r.d,
    dentist_name: dentistDocs[[D1, D2, D3].indexOf(r.d)].name,
    date: today,
    start: r.start,
    end: endOf(r.start),
    slot_key: slotKey(r.d, today, r.start),
    need: r.need,
    special_need: r.p === 0 ? '怕痛，需缓慢操作' : '',
    attended: r.attended,
    status: r.status,
    source: 'DESK'
  }))
  const apIds = await insert('appointments', apDocs)

  // 第一条已到诊的预约，顺手建出就诊记录，方便直接演示「诊间录入」
  const visitDocs = [
    {
      visit_no: `V${today.replace(/-/g, '')}-001`,
      appointment_id: apIds[0],
      patient_id: apDocs[0].patient_id,
      patient_name: apDocs[0].patient_name,
      clinic_id: apDocs[0].clinic_id,
      dentist_id: D1,
      dentist_name: '陈安',
      special_need: '怕痛，需缓慢操作',
      status: 'OPEN',
      arrived_at: Date.now()
    }
  ]
  await insert('visits', visitDocs)

  /* 7. 本季度历史结算单（用于季度核算：200000 / 105000 / 10500） */
  const plan = [
    { d: 0, treat: 5, units: 1 }, // D1 隐形正畸 24000
    { d: 0, treat: 5, units: 1 },
    { d: 0, treat: 5, units: 1 },
    { d: 0, treat: 5, units: 1 },
    { d: 0, treat: 5, units: 1 },
    { d: 1, treat: 5, units: 1 }, // D2 隐形正畸 24000
    { d: 1, treat: 5, units: 1 },
    { d: 1, treat: 5, units: 1 },
    { d: 1, treat: 4, units: 1 }  // D2 种植 8000
  ]

  let seq = 1
  for (let i = 0; i < plan.length; i++) {
    const row = plan[i]
    const dId = row.d === 0 ? D1 : D2
    const dName = row.d === 0 ? '陈安' : '李敏'
    const pIdx = i % 4
    // 日期落在本季度内且早于今天
    const back = 3 + i * 3
    const bizDate = ymd(addDays(now, -back))
    const t = treatDocs[row.treat]
    const subtotal = money(t.unit_price * row.units)

    const vNo = `V${bizDate.replace(/-/g, '')}-${String(seq++).padStart(3, '0')}`
    const vRes = await db.collection('visits').add({
      data: {
        visit_no: vNo,
        appointment_id: '',
        patient_id: patientIds[pIdx],
        patient_name: patientDocs[pIdx].name,
        clinic_id: CA,
        dentist_id: dId,
        dentist_name: dName,
        status: 'INVOICED',
        arrived_at: Date.now() - back * 86400000,
        created_at: Date.now()
      }
    })

    const lineRes = await db.collection('visit_treatments').add({
      data: {
        visit_id: vRes._id,
        treatment_id: treatIds[row.treat],
        name: t.name,
        units: row.units,
        unit_price: t.unit_price,
        subtotal,
        dentist_id: dId,
        status: 'CONFIRMED',
        confirmed_at: Date.now(),
        created_at: Date.now()
      }
    })

    await db.collection('invoices').add({
      data: {
        invoice_no: `I${bizDate.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`,
        visit_id: vRes._id,
        patient_id: patientIds[pIdx],
        patient_name: patientDocs[pIdx].name,
        clinic_id: CA,
        dentist_id: dId,
        dentist_name: dName,
        biz_date: bizDate,
        period,
        lines: [
          {
            line_id: lineRes._id,
            treatment_id: treatIds[row.treat],
            name: t.name,
            units: row.units,
            unit_price: t.unit_price,
            subtotal
          }
        ],
        total: subtotal,
        version: 1,
        status: 'VALID',
        created_at: Date.now() - back * 86400000
      }
    })
  }

  /* 8. 成本与运营费用（一位牙医一行，合计对应需求文档示例） */
  await insert('costs', [
    { dentist_id: D1, type: 'SUPPLY', amount: 30000, period, note: '耗材（种植体、正畸托槽）', voucher: 'PO-2026-1001' },
    { dentist_id: D1, type: 'OPEX', amount: 20000, period, note: '椅位、助理、水电分摊', voucher: 'OE-2026-1001' },
    { dentist_id: D2, type: 'SUPPLY', amount: 20000, period, note: '耗材（正畸附件）', voucher: 'PO-2026-1002' },
    { dentist_id: D2, type: 'OPEX', amount: 25000, period, note: '椅位、助理、水电分摊', voucher: 'OE-2026-1002' }
  ])

  return {
    code: 0,
    data: {
      collections: failed,
      period,
      today,
      clinics: clinicDocs.length,
      dentists: dentistDocs.length,
      patients: patientDocs.length,
      treatments: treatDocs.length,
      appointments_today: apDocs.length,
      invoices_seeded: plan.length,
      expected: { revenue: 200000, supply: 50000, opex: 45000, net: 105000, fund: 10500 }
    }
  }
}

/**
 * 对外入口：任何异常都返回可读信息，而不是只有 -501000
 * （云函数里靠 console.error 查日志太慢，演示阶段直接回传原因）
 */
exports.main = async () => {
  try {
    return await seed()
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e)
    console.error('[initData] failed:', msg, e && e.stack)
    return {
      code: 500,
      msg,
      env: (() => { try { return cloud.getWXContext().ENV } catch (e) { return 'unknown' } })(),
      collections: __report.slice(0, 3),
      where: e && e.stack ? String(e.stack).split('\n').slice(1, 4).join(' <- ') : ''
    }
  }
}
