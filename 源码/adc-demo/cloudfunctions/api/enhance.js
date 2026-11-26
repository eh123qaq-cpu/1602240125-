/**
 * ADC 需求符合性补强模块
 *
 * 对应《安德鲁牙科连锁管理系统 拟开发项目愿景与业务需求说明》：
 *   UC01 过敏询问状态（未询问 / 已询问无已知过敏 / 已报告）
 *   UC02 按治疗所需资质筛选候选牙医
 *   UC07 治疗项目所需资质与 ANY / ALL 匹配模式
 *   UC08 跨店出诊排班、时段重叠校验、调整时保护已有预约
 *   UC09 费用凭证防重
 *   UC10 季度核算版本、提交审批、下钻来源
 *   UC12 每次业务变更留痕（操作者 / 时间 / 原因 / 业务编号）与越权记录
 *
 * 设计原则：不改动原有 44 个 action 的实现，只用「包装 + 新增」补齐。
 * 新集合不存在或没有数据时自动回退原有行为，线上老数据不受影响。
 */
module.exports = function install(handlers, ctx) {
  const crypto = require('crypto')
  const {
    db, C, _, bizError, ok, ymd, quarterOf, getDoc,
    HOLDING, toMin, toHHMM, SLOT_MIN,
    STAFF_ONLY, ROLE_ACL, ROLE_NAME,
    todayYmd = () => new Date().toISOString().slice(0, 10)
  } = ctx

  const COLL = {
    schedules: 'schedules',
    audits: 'audit_logs',
    quarters: 'quarter_closes'
  }
  const now = () => Date.now()
  const s = (v) => String(v === undefined || v === null ? '' : v).trim()

  // 云函数实例复用期间只尝试一次建集合；已存在会报错，忽略即可
  const ensured = {}
  const ensure = async (name) => {
    if (ensured[name]) return
    try { await db.createCollection(name) } catch (e) { /* 已存在 */ }
    ensured[name] = true
  }

  /* ==================== UC12 操作留痕 ==================== */

  const WRITE_ACTS = [
    'appointment.create', 'appointment.changeStatus', 'appointment.reschedule',
    'appointment.cancelSelf', 'appointment.rescheduleSelf',
    'visit.checkin', 'visitTreatment.add', 'visitTreatment.remove', 'visitTreatment.confirm',
    'invoice.create', 'cost.add', 'dict.upsert',
    'patient.create', 'patient.update', 'patient.allergy.add', 'patient.allergy.remove',
    'patient.allergy.confirm', 'patient.allergy.setInquiry', 'patient.bind', 'patient.demoLogin',
    'auth.logout', 'staff.login', 'staff.logout',
    'schedule.upsert', 'schedule.remove', 'quarter.submit', 'quarter.approve', 'staff.upsert'
  ]

  const actorOf = (action, p, wxctx) => {
    if (p && p.__staff) {
      const u = p.__staff
      return {
        id: u._id || '', name: u.name || u.username || '', role: u.role || '',
        label: `${u.name || u.username} · ${ROLE_NAME[u.role] || u.role}`
      }
    }
    if (action === 'staff.login') {
      return { id: '', name: s(p && p.username), role: 'STAFF', label: `${s(p && p.username)} · 员工登录` }
    }
    if (wxctx && wxctx.OPENID) {
      return { id: '', name: '患者端', role: 'PATIENT', label: '患者端 · 微信身份' }
    }
    return { id: '', name: '系统', role: 'SYSTEM', label: '系统' }
  }

  const bizNoOf = (p, res) => {
    if (p) {
      for (const k of ['appointmentId', 'visitId', 'invoiceId', 'patientId', 'lineId', 'scheduleId', 'quarterId', '_id']) {
        if (p[k]) return s(p[k])
      }
    }
    const d = res && res.data
    if (d) {
      for (const k of ['_id', 'invoice_no', 'visit_no', 'appointment_id', 'visit_id']) {
        if (d[k]) return s(d[k])
      }
    }
    return ''
  }

  const writeAudit = async (action, p, wxctx, result, message, res) => {
    const a = actorOf(action, p, wxctx)
    try {
      await ensure(COLL.audits)
      await db.collection(COLL.audits).add({
        data: {
          action,
          at: now(),
          operator: a.label,
          operator_id: a.id,
          role: a.role,
          biz_no: bizNoOf(p, res),
          result,
          reason: s(p && (p.reason || p.note)),
          message: s(message).slice(0, 200),
          fields: p
            ? Object.keys(p).filter((k) => !k.startsWith('__') && !/pass|token|salt|hash/i.test(k)).join(',')
            : ''
        }
      })
    } catch (e) {
      // 审计失败不能影响业务办理（文档 7.2：不因辅助动作假装失败）
    }
  }

  /* ==================== 新 action 与 ACL 注册 ==================== */

  const NEW_ACTS = [
    'schedule.list', 'schedule.upsert', 'schedule.remove',
    'audit.list', 'patient.allergy.setInquiry', 'patient.list',
    'quarter.list', 'quarter.detail', 'quarter.submit', 'quarter.approve',
    'staff.list', 'staff.upsert'
  ]
  NEW_ACTS.forEach((a) => STAFF_ONLY.add(a))

  const grant = (roles, acts) => roles.forEach((r) => {
    const list = ROLE_ACL[r]
    if (!list || list[0] === '*') return
    acts.forEach((a) => { if (!list.includes(a)) list.push(a) })
  })
  grant(['DESK', 'DENTIST', 'FINANCE', 'OPERATIONS'], ['schedule.list', 'audit.list', 'quarter.list', 'quarter.detail', 'patient.list'])
  grant(['DESK', 'DENTIST'], ['patient.allergy.setInquiry'])
  grant(['OPERATIONS', 'DENTIST'], ['schedule.upsert', 'schedule.remove'])
  grant(['FINANCE'], ['quarter.submit'])
  // quarter.approve 只有 MANAGER（ACL 为 ['*']），符合「财务提交、经理审批」

  // 员工端「患者档案」默认展示在册患者，避免进去只有一句「请输入手机号」像是没数据。
  // 只读、限量，不返回登录凭据；档案详情仍走 patient.me / visit.listByPhone。
  handlers['patient.list'] = async (p) => {
    const r = await db.collection(C.patients).limit(200).get()
    const kw = s(p.keyword).toLowerCase()
    const rows = r.data
      .filter((x) => !kw || [x.name, x.phone].some((v) => String(v || '').toLowerCase().includes(kw)))
      .map((x) => ({
        _id: x._id, name: x.name || '', phone: x.phone || '', dob: x.dob || '',
        allergies: x.allergies || [], allergy_inquiry_status: x.allergy_inquiry_status || ''
      }))
    return ok(rows)
  }

  /* ==================== 员工账号（总部经理） ==================== */

  const STAFF_ROLES = ['DESK', 'DENTIST', 'FINANCE', 'OPERATIONS', 'MANAGER']
  const hashPwd = (pwd, salt) => crypto.scryptSync(String(pwd), salt, 32).toString('hex')
  const safeStaff = (u) => ({
    _id: u._id, username: u.username || '', name: u.name || '',
    role: u.role || '', role_name: ROLE_NAME[u.role] || u.role || '',
    clinic_name: u.clinic_name || '', emp_no: u.emp_no || '',
    active: u.active !== false, created_at: u.created_at || null
  })
  const requireManager = (p, msg) => {
    if (!p.__staff || p.__staff.role !== 'MANAGER') bizError(msg || '只有总部经理可以维护员工账号', 403)
  }

  // 只返回账号资料，salt / password_hash 永远不出库
  handlers['staff.list'] = async (p) => {
    if (!p.__staff || p.__staff.role !== 'MANAGER') bizError('只有总部经理可以查看员工账号', 403)
    const r = await db.collection(C.staff).limit(200).get()
    return ok(r.data
      .map(safeStaff)
      .sort((a, b) => a.role.localeCompare(b.role) || a.username.localeCompare(b.username)))
  }

  // 新增账号 / 改资料 / 重置密码 / 停用启用；按 username 唯一
  handlers['staff.upsert'] = async (p) => {
    requireManager(p, '只有总部经理可以维护员工账号')
    const username = s(p.username).toLowerCase()
    if (!/^[a-z][a-z0-9_]{2,19}$/.test(username)) {
      bizError('账号需 3–20 位，小写字母开头，可含数字和下划线')
    }
    const name = s(p.name)
    if (!name) bizError('请填写员工姓名')
    const role = s(p.role).toUpperCase()
    if (!STAFF_ROLES.includes(role)) bizError('角色不正确')
    const empNo = s(p.emp_no)
    if (role === 'DENTIST') {
      if (!empNo) bizError('牙医账号必须填工号，否则排班和诊间无法按本人过滤')
      const d = await db.collection(C.dentists).where({ emp_no: empNo }).limit(1).get()
      if (!d.data.length) bizError('工号不存在，请先在「门店与牙医」里建档')
    }
    const password = s(p.password)
    if (password && password.length < 8) bizError('密码至少 8 位')

    const patch = {
      username, name, role, emp_no: empNo,
      clinic_name: s(p.clinic_name),
      active: p.active === false ? false : true
    }
    const found = await db.collection(C.staff).where({ username }).limit(1).get()
    const doc = found.data[0]

    if (doc) {
      if (doc._id === p.__staff._id && patch.active === false) bizError('不能停用当前登录的账号')
      if (p.active === undefined) delete patch.active   // 不传就沿用原状态，避免顺手把停用账号启用
      if (password) {
        patch.salt = crypto.randomBytes(16).toString('hex')
        patch.password_hash = hashPwd(password, patch.salt)
      }
      await db.collection(C.staff).doc(doc._id).update({ data: patch })
      return ok({ ...safeStaff({ ...doc, ...patch }), created: false })
    }

    if (!password) bizError('新增账号必须设置初始密码（至少 8 位）')
    const salt = crypto.randomBytes(16).toString('hex')
    const nd = { ...patch, salt, password_hash: hashPwd(password, salt), created_at: now() }
    const r = await db.collection(C.staff).add({ data: nd })
    return ok({ ...safeStaff({ _id: r._id, ...nd }), created: true })
  }

  // 幂等建集合，部署后调用一次即可；不需要员工 token
  handlers['system.ensure'] = async () => {
    for (const k of Object.keys(COLL)) await ensure(COLL[k])
    return ok({ collections: Object.values(COLL) })
  }

  /* ==================== UC08 跨店出诊排班 ==================== */

  handlers['schedule.list'] = async (p) => {
    const w = {}
    if (s(p.date)) w.date = s(p.date)
    if (s(p.clinicId)) w.clinic_id = s(p.clinicId)
    if (s(p.dentistId)) w.dentist_id = s(p.dentistId)
    await ensure(COLL.schedules)
    const r = await db.collection(COLL.schedules).where(w).limit(300).get()
    return ok(r.data.sort((a, b) => String(a.date + a.start).localeCompare(String(b.date + b.start))))
  }

  handlers['schedule.upsert'] = async (p) => {
    let dentistId = s(p.dentistId)
    const clinicId = s(p.clinicId)
    const date = s(p.date)
    const start = s(p.start)
    const end = s(p.end)

    // 牙医账号：只能维护本人、本人在职门店的排班（工号与 dentists.emp_no 绑定）
    if (p.__staff && p.__staff.role === 'DENTIST') {
      const r = await db.collection(C.dentists).where({ emp_no: p.__staff.emp_no }).limit(1).get()
      const mine = r.data[0]
      if (!mine) bizError('未找到与当前账号关联的牙医档案，请联系运营维护工号', 403)
      if (dentistId && dentistId !== mine._id) bizError('只能维护本人的排班', 403)
      if (clinicId && !(mine.clinic_ids || []).includes(clinicId)) bizError('只能给本人在职的门店排班', 403)
      dentistId = mine._id
    }

    if (!dentistId || !clinicId || !date || !start || !end) bizError('牙医、门店、日期、起止时间都要填写')
    const st = toMin(start), en = toMin(end)
    if (!(st < en)) bizError('出诊结束时间必须晚于开始时间')
    if (date < todayYmd()) bizError('不能给过去的日期排班')

    const dentist = await getDoc(C.dentists, dentistId)
    if (!dentist) bizError('牙医不存在', 404)
    const clinic = await getDoc(C.clinics, clinicId)
    if (!clinic) bizError('门店不存在', 404)

    await ensure(COLL.schedules)
    const all = await db.collection(COLL.schedules)
      .where({ dentist_id: dentistId, date, status: 'ACTIVE' }).limit(200).get()
    const others = all.data.filter((x) => x._id !== s(p._id))

    // T07：同一牙医同一天跨店时段重叠必须拒绝
    const overlap = others.find((x) => st < toMin(x.end) && en > toMin(x.start))
    if (overlap) {
      const cross = overlap.clinic_id !== clinicId
      bizError(
        `冲突：该牙医 ${date} ${overlap.start}-${overlap.end} 已在「${overlap.clinic_name || '另一门店'}」出诊` +
        (cross ? '（跨店重叠）' : '') + '，请改时间或换一位牙医'
      )
    }
    // 转场间隔：不阻断，但必须提示人工核实（文档明确「不假定上一店结束就能立即在另一店接诊」）
    const near = others.find((x) => x.clinic_id !== clinicId &&
      Math.min(Math.abs(toMin(x.start) - en), Math.abs(st - toMin(x.end))) < 60)
    const warning = near
      ? `注意：与「${near.clinic_name || '另一门店'}」${near.start}-${near.end} 相邻，跨店转场时间需人工核实`
      : ''

    const doc = {
      dentist_id: dentistId, dentist_name: dentist.name || '',
      clinic_id: clinicId, clinic_name: clinic.name || clinic.short_name || '',
      date, start, end, note: s(p.note), status: 'ACTIVE', updated_at: now()
    }
    let out
    if (s(p._id)) {
      await db.collection(COLL.schedules).doc(s(p._id)).update({ data: doc })
      out = { _id: s(p._id), ...doc }
    } else {
      doc.created_at = now()
      const a = await db.collection(COLL.schedules).add({ data: doc })
      out = { _id: a._id, ...doc }
    }
    return ok({ ...out, warning })
  }

  handlers['schedule.remove'] = async (p) => {
    const row = await getDoc(COLL.schedules, s(p.scheduleId))
    if (!row) bizError('排班不存在', 404)
    if (p.__staff && p.__staff.role === 'DENTIST') {
      const r = await db.collection(C.dentists).where({ emp_no: p.__staff.emp_no }).limit(1).get()
      const mine = r.data[0]
      if (!mine || row.dentist_id !== mine._id) bizError('只能删除本人的排班', 403)
    }
    const appts = await db.collection(C.appointments)
      .where({ dentist_id: row.dentist_id, date: row.date, status: _.in(HOLDING) }).limit(200).get()
    const affected = appts.data.filter((a) => toMin(a.start) >= toMin(row.start) && toMin(a.start) < toMin(row.end))
    if (affected.length) {
      bizError(`该时段已有 ${affected.length} 条有效预约，请先改约或安排替代牙医，不能直接删除排班（UC08）`)
    }
    await db.collection(COLL.schedules).doc(row._id).remove()
    return ok({ ok: true })
  }

  /* ============ UC02 / UC07 排班驱动与资质筛选 ============ */

  const origSlots = handlers['appointment.availableSlots']
  handlers['appointment.availableSlots'] = async (p, wxctx) => {
    const base = await origSlots(p, wxctx)
    if (!base || base.code !== 0 || !Array.isArray(base.data)) return base
    let list = base.data

    // 排班：录入过任意排班后，可约时段以排班为准；完全没有排班时沿用固定工作时间
    let sch = []
    try {
      await ensure(COLL.schedules)
      sch = (await db.collection(COLL.schedules)
        .where({ clinic_id: p.clinicId, date: p.date, status: 'ACTIVE' }).limit(300).get()).data
    } catch (e) { sch = [] }
    if (sch.length) {
      list = list.map((d) => {
        const mine = sch.filter((x) => x.dentist_id === d.dentist_id)
        const starts = new Set()
        mine.forEach((x) => {
          for (let t = toMin(x.start); t + SLOT_MIN <= toMin(x.end); t += SLOT_MIN) starts.add(toHHMM(t))
        })
        return {
          ...d,
          slots: d.slots.filter((sl) => starts.has(sl.start)),
          schedule_based: true,
          schedule_text: mine.length ? mine.map((x) => `${x.start}-${x.end}`).join('、') : '当日未排班'
        }
      }).filter((d) => d.slots.length)
    }

    // 资质：治疗项目可配置所需资质与 ANY / ALL 匹配模式
    if (s(p.treatmentId)) {
      const t = await getDoc(C.treatments, s(p.treatmentId))
      const need = (t && t.required_qual_ids) || []
      if (need.length) {
        const mode = (t && t.qual_match_mode) === 'ALL' ? 'ALL' : 'ANY'
        const dent = await db.collection(C.dentists)
          .where({ active: true, clinic_ids: p.clinicId }).limit(50).get()
        const qmap = {}
        dent.data.forEach((x) => { qmap[x._id] = x.qualification_ids || [] })
        list = list.filter((d) => {
          const have = qmap[d.dentist_id] || []
          return mode === 'ALL' ? need.every((q) => have.includes(q)) : need.some((q) => have.includes(q))
        })
      }
    }
    return ok(list)
  }

  /* ==================== UC01 过敏询问状态 ==================== */

  const INQUIRY = ['NOT_ASKED', 'NO_KNOWN', 'REPORTED']
  handlers['patient.allergy.setInquiry'] = async (p) => {
    const status = s(p.status)
    if (!INQUIRY.includes(status)) bizError('未知的过敏询问状态')
    const pt = await getDoc(C.patients, s(p.patientId))
    if (!pt) bizError('患者不存在', 404)
    if (status === 'REPORTED' && !(pt.allergies || []).length) {
      bizError('标记为「已报告过敏」前，请先登记至少一条过敏原')
    }
    const patch = {
      allergy_inquiry_status: status,
      allergy_inquiry_note: s(p.note),
      allergy_inquiry_by: (p.__staff && (p.__staff.name || p.__staff.username)) || '',
      allergy_inquiry_at: now()
    }
    await db.collection(C.patients).doc(pt._id).update({ data: patch })
    return ok({ ...pt, ...patch })
  }

  // 建档时补默认值：区分「还没问过」和「问过、没有已知过敏」
  const origCreate = handlers['patient.create']
  handlers['patient.create'] = async (p, wxctx) => {
    const r = await origCreate(p, wxctx)
    const d = r && r.data
    if (d && d._id && !d.allergy_inquiry_status) {
      try {
        await db.collection(C.patients).doc(d._id).update({ data: { allergy_inquiry_status: 'NOT_ASKED' } })
        d.allergy_inquiry_status = 'NOT_ASKED'
      } catch (e) { /* 老档案不强制改写 */ }
    }
    return r
  }

  /* ==================== UC09 费用凭证防重 ==================== */

  const origCost = handlers['cost.add']
  handlers['cost.add'] = async (p, wxctx) => {
    const v = s(p.voucher)
    if (v) {
      const dup = await db.collection(C.costs).where({ voucher: v }).count()
      if (dup.total) bizError(`凭证号「${v}」已存在，请核对是否重复录入（UC09）`)
    }
    return origCost(p, wxctx)
  }

  /* ============ UC10 季度核算版本、审批与下钻 ============ */

  const origQuarter = handlers['report.quarter']
  handlers['report.quarter'] = async (p, wxctx) => {
    const r = await origQuarter(p, wxctx)
    if (!r || r.code !== 0 || !r.data) return r
    const period = r.data.period
    try {
      const [invs, costs] = await Promise.all([
        db.collection(C.invoices).where({ period, status: 'VALID' }).limit(500).get(),
        db.collection(C.costs).where({ period }).limit(500).get()
      ])
      r.data.sources = {
        invoice_nos: invs.data.map((i) => i.invoice_no),
        cost_vouchers: costs.data.map((c) => c.voucher).filter(Boolean)
      }
      await ensure(COLL.quarters)
      const qs = await db.collection(COLL.quarters)
        .where({ period, status: 'APPROVED' }).orderBy('version', 'desc').limit(1).get()
      r.data.approved_version = qs.data.length ? qs.data[0].version : null
    } catch (e) {
      r.data.sources = { invoice_nos: [], cost_vouchers: [] }
      r.data.approved_version = null
    }
    return r
  }

  handlers['quarter.list'] = async (p) => {
    await ensure(COLL.quarters)
    const w = s(p.period) ? { period: s(p.period) } : {}
    const r = await db.collection(COLL.quarters).where(w).orderBy('submitted_at', 'desc').limit(100).get()
    return ok(r.data)
  }

  handlers['quarter.detail'] = async (p) => {
    const q = await getDoc(COLL.quarters, s(p.quarterId))
    if (!q) bizError('核算版本不存在', 404)
    return ok(q)
  }

  handlers['quarter.submit'] = async (p) => {
    const period = s(p.period) || quarterOf(todayYmd())
    const r = await handlers['report.quarter']({ period }, {})
    if (!r || r.code !== 0) bizError('季度报表读取失败')
    const d = r.data
    if (d.payable === '待确认' || d.fund === null) {
      bizError('存在待分摊费用，核算未完成，不能提交审批（T08）')
    }
    await ensure(COLL.quarters)
    const cnt = await db.collection(COLL.quarters).where({ period }).count()
    const staff = p.__staff || {}
    const doc = {
      period,
      version: cnt.total + 1,
      status: 'SUBMITTED',
      snapshot: d,
      note: s(p.note),
      submitted_by: staff.name || staff.username || '',
      submitted_role: staff.role || '',
      submitted_at: now(),
      approved_by: '', approved_at: 0, approve_note: ''
    }
    const a = await db.collection(COLL.quarters).add({ data: doc })
    return ok({ _id: a._id, ...doc })
  }

  handlers['quarter.approve'] = async (p) => {
    const q = await getDoc(COLL.quarters, s(p.quarterId))
    if (!q) bizError('核算版本不存在', 404)
    if (q.status === 'APPROVED') return ok(q)
    const staff = p.__staff || {}
    const patch = {
      status: 'APPROVED',
      approved_by: staff.name || staff.username || '',
      approved_at: now(),
      approve_note: s(p.note)
    }
    await db.collection(COLL.quarters).doc(q._id).update({ data: patch })
    return ok({ ...q, ...patch })
  }

  /* ==================== 审计查询 ==================== */

  handlers['audit.list'] = async (p) => {
    await ensure(COLL.audits)
    const r = await db.collection(COLL.audits).orderBy('at', 'desc').limit(300).get()
    let rows = r.data
    const kw = s(p.keyword).toLowerCase()
    if (kw) {
      rows = rows.filter((x) => [x.action, x.operator, x.biz_no, x.reason, x.message]
        .some((v) => String(v || '').toLowerCase().includes(kw)))
    }
    if (s(p.result)) rows = rows.filter((x) => x.result === s(p.result))
    return ok(rows.slice(0, Number(p.limit) || 100))
  }

  /* ============ 统一包装：写操作成功后留痕；失败由入口 catch 记录 ============ */

  WRITE_ACTS.forEach((name) => {
    if (typeof handlers[name] !== 'function') return
    const orig = handlers[name]
    handlers[name] = async (p, wxctx) => {
      const res = await orig(p, wxctx)
      if (!res || res.code === 0) {
        await writeAudit(name, p, wxctx, 'OK', '', res)
      }
      return res
    }
  })

  return {
    collections: COLL,
    writeAudit: (action, p, wxctx, result, message) => writeAudit(action, p, wxctx, result, message, null)
  }
}
