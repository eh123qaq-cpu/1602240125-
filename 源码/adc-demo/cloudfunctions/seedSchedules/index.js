/**
 * 出诊排班初始化（可重复执行，只写 schedules 集合）
 *
 * 为什么需要：schedule.list 之前是空表，员工进「出诊排班」只看到 0 条，
 * 会以为功能坏了；而排班一旦为空，预约页只能退回固定工作时间，UC08
 * 「排班驱动可约时段」也演示不出来。
 *
 * 写入内容：在册牙医 × 今天起 7 天 × 上午 09:00-12:00 / 下午 14:00-17:30，
 * 门店取该牙医 clinic_ids 的第一家（陈安、李敏→天河，王强→越秀）。
 * 已存在同一牙医、同一天、同开始时间的 ACTIVE 排班则跳过，不覆盖人工调整。
 *
 * 与 seedStaff 一样需要本地初始化密钥，避免公开后被随意调用。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const SEED_KEY = 'adc-seed-7f3c9d21b8e4'
const DAYS = 30   // 覆盖小程序 bookingDays（14 天）再留余量，演示期不会出现「后半个月没排班」
const SEGMENTS = [['09:00', '12:00', '上午门诊'], ['14:00', '17:30', '下午门诊']]

const pad = (n) => String(n).padStart(2, '0')
// 与 api 云函数一致：按北京时间算「今天」（运行环境默认 UTC）
const CN_OFFSET = 8 * 60 * 60 * 1000
const cnYmd = (offsetDays = 0) => {
  const d = new Date(Date.now() + CN_OFFSET + offsetDays * 86400000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const ensure = async () => {
  try {
    await db.createCollection('schedules')
  } catch (e) {
    const m = String((e && (e.errMsg || e.message)) || e)
    if (!/exist/i.test(m)) {
      try {
        const r = await db.collection('schedules').add({ data: { __probe: 1 } })
        await db.collection('schedules').doc(r._id).remove()
      } catch (e2) {
        return String((e2 && (e2.errMsg || e2.message)) || e2).slice(0, 120)
      }
    }
  }
  return ''
}

exports.main = async (event = {}) => {
  if (String((event && event.__seedKey) || '') !== SEED_KEY) {
    return { code: 403, msg: 'seedSchedules 已停用：需提供本地初始化密钥（见项目 README）' }
  }
  try {
    const err = await ensure()
    if (err) return { code: 500, msg: 'schedules 集合不可用：' + err }

    const dentists = (await db.collection('dentists').where({ active: true }).limit(50).get()).data
    const clinics = (await db.collection('clinics').limit(50).get()).data
    if (!dentists.length) return { code: 400, msg: '没有在册牙医，请先初始化基础数据' }

    // 一次读出已有排班，避免 42 次串行查询把云函数拖到超时
    let exist = []
    try {
      exist = (await db.collection('schedules').limit(1000).get()).data
    } catch (e) { exist = [] }
    const seen = new Set(exist
      .filter((x) => x.status === 'ACTIVE')
      .map((x) => `${x.dentist_id}|${x.date}|${x.start}`))

    let created = 0
    let skipped = 0
    const detail = []
    const docs = []

    for (const d of dentists) {
      const clinicId = (d.clinic_ids || [])[0]
      const clinic = clinics.find((c) => c._id === clinicId)
      if (!clinicId || !clinic) { detail.push({ dentist: d.name, note: '无出诊门店，跳过' }); continue }
      let mine = 0
      for (let i = 0; i < DAYS; i++) {
        const date = cnYmd(i)
        for (const [start, end, note] of SEGMENTS) {
          const key = `${d._id}|${date}|${start}`
          if (seen.has(key)) { skipped++; continue }
          seen.add(key)
          docs.push({
            dentist_id: d._id, dentist_name: d.name || '',
            clinic_id: clinicId, clinic_name: clinic.name || clinic.short_name || '',
            date, start, end, note, status: 'ACTIVE', created_at: Date.now()
          })
          mine++
        }
      }
      detail.push({ dentist: d.name, clinic: clinic.name, added: mine })
    }

    // 分批并发写入，单批 6 条
    for (let i = 0; i < docs.length; i += 6) {
      const chunk = docs.slice(i, i + 6)
      const r = await Promise.all(chunk.map((data) => db.collection('schedules').add({ data })))
      created += r.length
    }

    return { code: 0, data: { created, skipped, days: DAYS, detail } }
  } catch (e) {
    return { code: 500, msg: e.message || 'seedSchedules 执行失败', where: String(e.stack || '').slice(0, 300) }
  }
}
