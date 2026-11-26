/* =====================================================================
 * ADC 牙科连锁 · 员工工作台
 *
 * 只连云端：CloudBase Web SDK 调同一个云函数 api，与患者小程序共用数据。
 * 页面里没有本地演示数据，读到的每一条都是云端真实记录。
 *
 * 身份：账号密码 → 云函数签发 token → staff_sessions → staff.role
 *       前端只展示，所有权限判断在云函数入口完成。
 * ===================================================================== */

const CONFIG = {
  envId: 'patient-damselfly-d3di6275acf229',
  // 通道账号：只用于建立「浏览器 → 云函数」的调用通道，本身不含任何业务权限。
  // 该云环境是 PostgreSQL 版，匿名登录接口返回 SDK_UPGRADE_REQUIRED、
  // 且匿名身份调用云函数会被网关拒绝（EXCEED_AUTHORITY），所以改用普通应用用户登录。
  // 业务权限仍由云函数内的 staff token + 角色 ACL 判定，拿到这个账号也读不到业务数据。
  channel: { username: 'webconsole', password: 'Adc@Web2026#Ch' }
}
// 最近一次云端失败原因，显示在顶栏 title 与降级横幅里，避免静默降级后无从排查
let cloudErr = ''
const fmtErr = (e, fallback) => {
  let raw = (e && (e.message || e.errMsg || e.code || e.errCode)) || (typeof e === 'string' ? e : '')
  // SDK 偶尔抛的不是 Error 而是纯对象（{ errCode, errMsg } 甚至空对象），
  // 直接 String() 只会得到 [object Object]，横幅上看不出原因。
  if (!raw && e && typeof e === 'object') {
    try {
      const j = JSON.stringify(e)
      if (j && j !== '{}' && j !== '[]') raw = j
    } catch (x) { raw = '' }
  }
  return String(raw || fallback || '未知错误').replace(/\s+/g, ' ').slice(0, 170)
}
// 顶栏、横幅只给一句能看懂的原因；原始错误码留在悬停提示里备查。
const friendlyErr = (raw) => {
  const s = String(raw || '')
  if (!s) return '网络暂时不通'
  if (/SDK 未加载/.test(s)) return '页面脚本未加载，请刷新'
  if (/timeout|timed out|超时/i.test(s)) return '请求超时'
  if (/network|fetch|socket|offline|ENOTFOUND|ECONN|WEBSOCKET/i.test(s)) return '网络不可达'
  if (/signin|password|SIGNIN_FAILED/i.test(s)) return '连接通道登录失败'
  return '云端暂时不可用'
}
const TOKEN_KEY = 'adc_staff_token'

// 课程演示用的身份入口：点哪个身份，就用对应的云端员工账号登录。
// 云端 staff.login 比对的是 scrypt 哈希，这里的口令与 seedStaff 里的 STAFF_PASSWORD 一致。
// 正式上线时应去掉这张表，改回由员工自己输入账号密码。
const STAFF_PASSWORD = 'Adc@Staff2026!Q4'
const IDENTITIES = [
  { username: 'desk',     role: 'DESK',       name: '周晓雯', label: '前台 · 天河店' },
  { username: 'desk2',    role: 'DESK',       name: '何嘉',   label: '前台 · 越秀店' },
  { username: 'dentist',  role: 'DENTIST',    name: '陈安',   label: '牙医 · 天河店' },
  { username: 'dentist2', role: 'DENTIST',    name: '李敏',   label: '牙医 · 天河店' },
  { username: 'dentist3', role: 'DENTIST',    name: '王强',   label: '牙医 · 越秀店' },
  { username: 'finance',  role: 'FINANCE',    name: '许静',   label: '财务' },
  { username: 'ops',      role: 'OPERATIONS', name: '梁俊',   label: '运营' },
  { username: 'manager',  role: 'MANAGER',    name: '黄立群', label: '总部经理' }
]

/* ------------------------------ 工具 ------------------------------ */

const $ = (id) => document.getElementById(id)
const ESC = (s) =>
  String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const money = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const pad = (n) => (n < 10 ? '0' + n : '' + n)
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const quarterOf = (s) => `${s.slice(0, 4)}Q${Math.ceil(Number(s.slice(5, 7)) / 3)}`
const uid = (p) => p + Math.random().toString(36).slice(2, 9)
const TODAY = ymd(new Date())
const THIS_Q = quarterOf(TODAY)

// 与云端 WORK_WINDOWS 一致的 30 分钟门诊格。改约只让选这些时间点，
// 避免手输 09:15 这种格子外时间被后端一句「不在门诊时段内」打回来。
const SLOT_TIMES = (() => {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const hhmm = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60)
  const out = []
  for (const [s, e] of [['09:00', '12:00'], ['14:00', '17:30']]) {
    for (let m = toMin(s); m + 30 <= toMin(e); m += 30) out.push(hhmm(m))
  }
  return out
})()
// 改约时间下拉：有排班数据时只列该牙医当天的出诊格，没有排班时沿用基础工作时间
// （与云端 assertBookable 同一口径，避免选出后端必然拒绝的时段）。
const toMinOf = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5))
const slotOptions = (date, current, dentistId, rows) => {
  let list = SLOT_TIMES
  if (Array.isArray(rows) && rows.length && dentistId) {
    const mine = rows.filter((r) => r.dentist_id === dentistId)
    list = SLOT_TIMES.filter((t) =>
      mine.some((r) => toMinOf(t) >= toMinOf(r.start) && toMinOf(t) + 30 <= toMinOf(r.end))
    )
  }
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const usable = list.filter((t) => (date !== TODAY ? true : toMinOf(t) > nowMin))
  const picked = usable.includes(current) ? current : (usable[0] || '')
  if (!usable.length) return '<option value="">当天没有可约时段</option>'
  return usable.map((t) => `<option value="${t}" ${t === picked ? 'selected' : ''}>${t}</option>`).join('')
}

const STATUS_TEXT = {
  PENDING: '待到诊', ARRIVED: '已到诊', DONE: '治疗完成', CANCELLED: '已取消',
  VOID: '诊所撤销', RESCHEDULED: '已改约', VERIFY: '待核实', NO_SHOW: '未到诊'
}
const STATUS_TAG = {
  PENDING: 'tag-blue', ARRIVED: 'tag-green', DONE: 'tag-green', CANCELLED: 'tag-gray',
  VOID: 'tag-gray', RESCHEDULED: 'tag-gray', VERIFY: 'tag-amber', NO_SHOW: 'tag-red'
}
const ROLE_NAME = { DESK: '前台', DENTIST: '牙医', FINANCE: '财务', OPERATIONS: '运营', MANAGER: '总部经理' }
const COST_TYPE_TEXT = { SUPPLY: '耗材', OPEX: '运营费', UNALLOCATED: '待分摊' }
const VISIT_STATUS_TEXT = { OPEN: '就诊中', DONE: '治疗完成', INVOICED: '已开单' }

let toastTimer = null
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800)
}
function busy(on) { $('loading').classList.toggle('hidden', !on) }

const withTimeout = (p, ms) => {
  let timer = null
  const timed = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('请求超时，请检查网络')), ms)
  })
  // 请求一旦结束就清掉定时器，避免每个请求都留下一个悬挂计时器。
  return Promise.race([Promise.resolve(p), timed]).finally(() => clearTimeout(timer))
}

/* ------------------------------ 云连接 ------------------------------ */

let cbApp = null
let ONLINE = false
let degraded = false
let lastRecoverAt = 0

// 页面只有一个数据源：云端。连不上就明确报错并给重连入口，不拿本地假数据糊过去。
const CLOUD_TIMEOUT = 15000
// 降级后自动重连的节流间隔：避免每次点击都做一次完整的登录 + 探活。
const RECOVER_GAP = 12000

async function signInChannel() {
  const auth = cbApp.auth({ persistence: 'local' })
  const r = await withTimeout(auth.signInWithPassword({ ...CONFIG.channel }), CLOUD_TIMEOUT)
  if (r && r.error) {
    throw new Error(`${r.error.status || r.error.code || 'SIGNIN_FAILED'} ${r.error.message || ''}`)
  }
  return true
}

async function probeCloud() {
  const res = await withTimeout(
    cbApp.callFunction({ name: 'api', data: { action: 'meta.bootstrap', payload: {} } }), CLOUD_TIMEOUT
  )
  const pr = (res && res.result) || {}
  if (pr.code !== 0) throw new Error(`探活返回 ${pr.code} ${pr.msg || ''}`)
  return true
}

async function initCloud() {
  if (!CONFIG.envId) { cloudErr = '未配置云环境 ID'; return false }
  if (typeof cloudbase === 'undefined') {
    cloudErr = 'Web SDK 未加载（CDN 不可达或被网络策略拦截）'
    return false
  }
  try {
    cbApp = cbApp || cloudbase.init({ env: CONFIG.envId })
    // 不信任本地缓存的登录态：access_token 可能已过期，每次都重新签票。
    // 旧逻辑用 hasLoginState() 短路，页面放久后首次请求会被网关拒绝并降级。
    await signInChannel()
    // 先探活：云函数确实调得通，才对外宣布「云端已连接」
    await probeCloud()
    cloudErr = ''
    degraded = false
    return true
  } catch (e) {
    cloudErr = fmtErr(e)
    console.warn('CloudBase 初始化失败：', cloudErr)
    return false
  }
}

// 降级不再是一次性锁存：重新签票 + 探活，成功就回到云端。
// 首次初始化失败时也会重试完整初始化；普通调用按 12 秒节流，force 用于切回页面。
async function recoverCloud(force) {
  const now = Date.now()
  if (!force && now - lastRecoverAt < RECOVER_GAP) return false
  lastRecoverAt = now
  try {
    if (!ONLINE) {
      if (!(await initCloud())) return false
      ONLINE = true
    } else {
      await signInChannel()
      await probeCloud()
    }
    degraded = false
    cloudErr = ''
    updateEnvBadge()
    const banner = $('banner')
    if (banner) banner.classList.add('hidden')
    return true
  } catch (e) {
    cloudErr = fmtErr(e)
    updateEnvBadge()
    return false
  }
}

// 业务错误 = 云端明确拒绝了这次请求（参数不对、无权限、状态不允许、记录不存在、时段被占）。
// 这类错误只该提示用户改一下再试，绝不能因此把整页真实数据换成演示数据。
const BIZ_CODES = [400, 401, 403, 404, 409, 422]
// 少数旧 action 只有文字没有 code，按措辞兜底判定。这些措辞全是「请求本身不合规」，
// 与网络抖动（socket hang up / timeout / network）不会混淆。
const BIZ_TEXT = /不存在|已被删除|无权|不能|不允许|请先|已占用|已约满|已结束|已经|重复|必填|格式|超出|未被占用|没有权限/
const isBizError = (e) => {
  if (!e) return false
  if (BIZ_CODES.includes(Number(e.code))) return true
  return BIZ_TEXT.test(String(e.message || ''))
}

// 探活：只有这一步也失败，才算「云端真的连不上」。
// 单条请求报错（函数内部异常、超时、参数错）不代表云端不可用，不能拿它当降级依据。
async function cloudReachable() {
  if (!ONLINE || !cbApp) return false
  try {
    await probeCloud()
    return true
  } catch (e) {
    cloudErr = fmtErr(e)
    return false
  }
}

// 会改动云端数据的 action：失败只报错，不重试、不假装成功。
// 用户必须知道「这次没改到」，否则会接着按错误的预期继续操作。
const CLOUD_WRITE_ACTS = new Set([
  'appointment.create', 'appointment.changeStatus', 'appointment.reschedule',
  'appointment.cancelSelf', 'appointment.rescheduleSelf',
  'visit.checkin', 'visitTreatment.add', 'visitTreatment.remove', 'visitTreatment.confirm',
  'invoice.create', 'cost.add', 'dict.upsert',
  'patient.create', 'patient.update', 'patient.bind',
  'patient.allergy.add', 'patient.allergy.remove', 'patient.allergy.confirm', 'patient.allergy.setInquiry',
  'schedule.upsert', 'schedule.remove', 'quarter.submit', 'quarter.approve', 'staff.upsert'
])
const isWriteAct = (action) => CLOUD_WRITE_ACTS.has(action)

// 页面数据只有一个来源：云端。掉线时给出明确提示与重连入口，不伪造数据。
let reloading = false

async function reloadCurrent() {
  if (reloading) return
  reloading = true
  try { await ensureData(state.view); renderView(state.view) } finally { reloading = false }
}

// 单次调用。业务码非 0 时抛出带 code 的错误，交给上层区分业务拒绝与网络故障。
async function callOnce(action, data) {
  const res = await withTimeout(
    cbApp.callFunction({ name: 'api', data: { action, payload: data } }), CLOUD_TIMEOUT
  )
  const r = (res && res.result) || {}
  if (r.code === 0) return r.data
  const e = new Error(r.msg || '请求失败')
  e.code = r.code
  throw e
}

async function api(action, payload = {}) {
  const data = { ...payload, __token: state.token }
  // 未连上或已掉线时，本次操作先尝试重连；成功则这次请求直接走云端，无需刷新页面。
  if (!ONLINE || degraded) {
    if (!(await recoverCloud())) {
      const e = new Error('云端连接中断，本次操作没有生效；点右上角「重连云端」后重试')
      e.code = 503
      throw e
    }
  }
  try {
    return await callOnce(action, data)
  } catch (e) {
    // 业务拒绝原样抛给用户：绿色提示条照常，顶栏仍然是「云端已连接」。
    if (isBizError(e)) throw e

    const detail = fmtErr(e, '请求失败')
    const down = !(await cloudReachable())
    const write = isWriteAct(action)

    // 写操作失败只报错：改没改到数据必须说清楚，也不能让用户以为已保存。
    if (write) {
      const err = new Error(
        (down ? '云端连接中断' : '这次操作没有生效') + '：' + detail + '；本次没有改到任何数据，请重试'
      )
      err.code = 503
      throw err
    }

    // 读操作：探活成功说明云端是通的，只是这一条查询出错 —— 先自动重试一次，
    // 仍失败才提示；页面已有数据一律保留。
    if (!down) {
      try {
        return await callOnce(action, data)
      } catch (e2) {
        const err = new Error('读取失败：' + fmtErr(e2, detail) + '，请重试')
        err.code = 500
        throw err
      }
    }

    cloudErr = detail
    degraded = true
    // 置 0 让下一次操作必定尝试重连，不受节流限制。
    lastRecoverAt = 0
    updateEnvBadge()
    showBanner(`云端连接中断（${friendlyErr(cloudErr)}）。当前页面数据保持不变；点右上角「重连云端」可恢复。`, false)
    const err = new Error('云端连接中断：' + detail + '；当前数据保持不动，请点右上角「重连云端」')
    err.code = 503
    throw err
  }
}

// 从后台切回页面时主动重连一次（真实浏览器才有 visibilitychange）。
if (typeof document !== 'undefined' && document.addEventListener) {
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !ONLINE || !degraded) return
      recoverCloud(true).then((ok) => {
        if (ok && state.staff && typeof refreshView === 'function') refreshView().catch(() => {})
      })
    })
  } catch (e) { /* 忽略：不影响主流程 */ }
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  staff: null,
  view: '',
  dashboard: null, meta: null, report: null,
  appts: [], patients: null, patientHistory: null,
  clinic: { appt: null, detail: null, pendingAppt: null },
  billing: { appt: null, detail: null },
  costs: [], catalogTab: 'clinics', edits: {},
  staffRows: [],
  apptQuery: { date: TODAY, phone: '', clinicId: '' },
  // 改约用的当天排班缓存：{ date, rows }，用来把时段限制在该牙医真实出诊时间内
  schDay: null
}

const VIEWS = [
  { id: 'desk', name: '今日看板' }, { id: 'appointments', name: '预约管理' },
  { id: 'patients', name: '患者档案' }, { id: 'clinic', name: '诊间治疗' },
  { id: 'billing', name: '结算开单' }, { id: 'costs', name: '成本与费用' },
  { id: 'report', name: '季度报表' }, { id: 'catalog', name: '门店与牙医' },
  { id: 'treatments', name: '诊疗项目' },
  { id: 'schedules', name: '出诊排班' }, { id: 'audit', name: '操作记录' },
  { id: 'quarter', name: '核算审批' }, { id: 'staff', name: '员工账号' }
]
const ROLE_MENU = {
  DESK: ['desk', 'appointments', 'patients', 'clinic', 'schedules', 'audit'],
  DENTIST: ['clinic', 'patients', 'schedules'],
  FINANCE: ['billing', 'costs', 'report', 'quarter', 'audit'],
  OPERATIONS: ['appointments', 'costs', 'catalog', 'treatments', 'schedules', 'audit', 'quarter'],
  MANAGER: VIEWS.map((v) => v.id)
}

function showBanner(text, info) {
  const b = $('banner')
  b.className = 'banner' + (info ? ' info' : '')
  b.textContent = text
  b.classList.remove('hidden')
}
function updateEnvBadge() {
  const online = ONLINE && !degraded
  const b = $('env-badge')
  // 断开时写成可点的提示，让人知道是网络断了，而不是换了一套数据
  b.textContent = online ? '云端已连接' : '云端断开 · 重连'
  b.className = 'env-badge ' + (online ? 'online' : 'demo')
  b.title = online
    ? '已连通 CloudBase，数据与患者小程序共用'
    : (cloudErr ? '云端不可用：' + cloudErr + '（点这里重试连接）' : '正在连接云端…')
  const m = $('login-mode')
  if (m) m.textContent = online
    ? '数据来自云端 · 与患者小程序互通'
    : (cloudErr ? '云端未连通：' + friendlyErr(cloudErr) + '（可点右上角重试）' : '正在连接云端…')
}

// 手动重连：任何一次报错都不会伪造数据，恢复交给这个按钮。
async function retryCloud() {
  toast('正在重新连接云端…')
  let ok = false
  try {
    ok = await recoverCloud(true)
  } catch (e) { ok = false }
  if (!ok) {
    showBanner(`仍无法连接云端（${friendlyErr(cloudErr)}）。当前数据保持不变，请检查网络后点右上角重试。`, false)
    toast('重连失败：' + (cloudErr || '网络不可用'))
    return
  }
  $('banner').classList.add('hidden')
  toast('已重新连接云端')
  if (state.staff && state.view) {
    try { await refreshView() } catch (e) { /* 刷新失败只提示，不影响已恢复的连接 */ }
  }
}

/* ------------------------------ 登录 ------------------------------ */

// 身份入口：点一下就用对应员工账号登录云端，不需要手打账号密码。
function renderIdentityList() {
  const box = $('id-list')
  if (!box) return
  box.innerHTML = IDENTITIES.map((u) =>
    `<button type="button" class="id-item" data-user="${ESC(u.username)}">
        <span class="id-avatar">${ESC(ROLE_NAME[u.role] || u.role)}</span>
        <span class="id-main">
          <span class="id-name">${ESC(u.name)}</span>
          <span class="id-sub">${ESC(u.label)} · ${ESC(u.username)}</span>
        </span>
        <span class="id-go">进入</span>
      </button>`
  ).join('')
}

function showLogin(msg) {
  $('app').classList.add('hidden')
  $('login').classList.remove('hidden')
  const box = $('login-error')
  if (msg) { box.textContent = msg; box.classList.remove('hidden') }
  else box.classList.add('hidden')
  document.querySelectorAll('#id-list .id-go').forEach((el) => { el.textContent = '进入' })
  updateEnvBadge()
}

function clearToken() {
  state.token = ''
  state.staff = null
  localStorage.removeItem(TOKEN_KEY)
  // 旧版本留过一个演示身份缓存，顺手清掉，免得占着本地存储
  localStorage.removeItem('adc_demo_staff')
}

async function doLogin(username) {
  const d = await api('staff.login', { username, password: STAFF_PASSWORD })
  state.token = d.token
  state.staff = d.staff
  localStorage.setItem(TOKEN_KEY, d.token)
  enterApp()
}

async function restore() {
  if (!state.token) return false
  try {
    const d = await api('staff.session', {})
    state.staff = d.staff
    return true
  } catch (e) {
    clearToken()
    return false
  }
}

async function doLogout() {
  try { await api('staff.logout', {}) } catch (e) { /* 忽略 */ }
  clearToken()
  showLogin()
}

/* ------------------------------ 进入应用 / 路由 ------------------------------ */

function enterApp() {
  $('login').classList.add('hidden')
  $('app').classList.remove('hidden')
  $('who-name').textContent = state.staff.name
  $('role-badge').textContent = state.staff.role_name
  $('side-user').innerHTML = `${ESC(state.staff.name)}<small>${ESC(state.staff.role_name)} · ${ESC(state.staff.clinic_name || '总部')}</small>`
  updateEnvBadge()
  $('banner').classList.add('hidden')
  renderMenu()
  go((ROLE_MENU[state.staff.role] || ['desk'])[0])
}

function renderMenu() {
  const menu = ROLE_MENU[state.staff.role] || []
  $('nav').innerHTML = VIEWS.filter((v) => menu.includes(v.id)).map((v) =>
    `<button class="nav-item ${state.view === v.id ? 'active' : ''}" data-view="${v.id}">${ESC(v.name)}</button>`
  ).join('')
}

async function ensureData(view) {
  const jobs = {
    desk: [['report.dashboard', {}, 'dashboard']],
    appointments: [['appointment.list', { ...state.apptQuery }, 'appts'], ['meta.bootstrap', {}, 'meta']],
    clinic: [['report.dashboard', {}, 'dashboard'], ['meta.bootstrap', {}, 'meta']],
    billing: [['report.dashboard', {}, 'dashboard'], ['meta.bootstrap', {}, 'meta'], ['invoice.list', { period: THIS_Q }, 'invoices']],
    costs: [['cost.list', { period: THIS_Q }, 'costs'], ['meta.bootstrap', {}, 'meta']],
    report: [['report.quarter', { period: THIS_Q }, 'report'], ['report.dashboard', {}, 'dashboard']],
    catalog: [['clinic.list', {}, '_clinics'], ['dentist.list', {}, '_dentists'], ['qual.list', {}, '_quals']],
    treatments: [['meta.bootstrap', {}, 'meta'], ['qual.list', {}, '_quals']],
    patients: [['patient.list', {}, '_patientRows']],
    schedules: [['schedule.list', { date: state.schDate || TODAY }, '_schedules'], ['meta.bootstrap', {}, 'meta']],
    audit: [['audit.list', { limit: 100 }, '_audits']],
    quarter: [['quarter.list', { period: THIS_Q }, '_quarters'], ['report.quarter', { period: THIS_Q }, 'report']],
    staff: [['staff.list', {}, '_staffRows']]
  }
  for (const [action, payload, key] of (jobs[view] || [])) {
    try {
      const d = await api(action, payload)
      if (key.startsWith('_')) state[key.slice(1)] = d
      else state[key] = d
    } catch (e) {
      toast(action + '：' + e.message)
    }
  }
}

async function go(view) {
  const menu = ROLE_MENU[state.staff.role] || []
  if (!menu.includes(view)) view = menu[0]
  state.view = view
  renderMenu()
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'))
  // 菜单与容器分开维护，漏写一个 section 不该让整页白屏
  const box = $('view-' + view)
  if (box) box.classList.remove('hidden')
  else toast('页面结构缺少「' + (VIEWS.find((v) => v.id === view) || {}).name + '」区块，请联系维护者')
  await ensureData(view)
  renderView(view)
  window.scrollTo(0, 0)
}

async function refreshView() {
  busy(true)
  try { await ensureData(state.view); renderView(state.view) }
  finally { busy(false) }
}

function renderView(view) {
  const map = {
    desk: renderDesk, appointments: renderAppointments, patients: renderPatients,
    clinic: renderClinic, billing: renderBilling, costs: renderCosts,
    report: renderReport, catalog: renderCatalog, treatments: renderTreatments,
    schedules: renderSchedules, audit: renderAudit, quarter: renderQuarter, staff: renderStaff
  }
  const fn = map[view]
  if (fn) $('body-' + view).innerHTML = fn() || ''
  bindDynamic(view)
}

/* ------------------------------ 组件片段 ------------------------------ */

function kpi(label, value, unit, cls) {
  return `<div class="kpi ${cls || ''}"><div class="kpi-label">${ESC(label)}</div>
    <div class="kpi-value">${value}${unit ? `<small>${ESC(unit)}</small>` : ''}</div></div>`
}
function card(title, body, hint) {
  return `<div class="card"><div class="card-head"><h2>${ESC(title)}</h2>${hint ? `<span class="hint">${ESC(hint)}</span>` : ''}</div>${body}</div>`
}
function statusTag(s) {
  return `<span class="tag ${STATUS_TAG[s] || 'tag-gray'}">${ESC(STATUS_TEXT[s] || s || '—')}</span>`
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h, i) =>
    `<th${h.num ? ' class="num"' : ''}>${ESC(h.t || h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="empty">暂无数据</td></tr>`}</tbody></table></div>`
}
function invoiceHtml(inv, fetched) {
  return `<div class="hint" style="margin-bottom:12px">单号 <strong>${ESC(inv.invoice_no)}</strong>　${ESC(inv.biz_date || '')}　
    ${inv.reused || fetched ? '<span class="tag tag-green">已开单</span>' : ''}</div>
    ${table(['项目', { t: '单位', num: 1 }, { t: '单价（快照）', num: 1 }, { t: '小计', num: 1 }],
      (inv.lines || []).map((l) => `<tr><td>${ESC(l.name)}</td><td class="num">${l.units}</td>
      <td class="num">${money(l.unit_price)}</td><td class="num">${money(l.subtotal)}</td></tr>`))}
    <div class="total-line"><span>合计</span><span class="big">${money(inv.total)}</span></div>
    <div class="hint" style="margin-top:12px">就诊结算单，不等同税务发票。收款不在本期范围。</div>`
}

/* ------------------------------ 视图：今日看板 ------------------------------ */

function renderDesk() {
  const d = state.dashboard
  if (!d) return '<div class="card"><div class="empty">看板数据加载失败</div></div>'
  $('desk-sub').textContent = `${d.today} · ${ONLINE && !degraded ? '云端实时数据' : '云端断开，数据未刷新'}`
  const list = (d.today_list || []).slice().sort((a, b) => (a.start > b.start ? 1 : -1))
  const kpis = `<div class="kpis">${[
    kpi('今日预约', list.length, '条'),
    kpi('已到诊', (d.counts.ARRIVED || 0) + (d.counts.DONE || 0), '条'),
    kpi('待到诊', d.counts.PENDING || 0, '条'),
    kpi('取消率', d.cancel_rate === null ? '—' : d.cancel_rate, d.cancel_rate === null ? '' : '%', 'warn'),
    kpi('未到诊率', d.no_show_rate === null ? '—' : d.no_show_rate, d.no_show_rate === null ? '' : '%', 'bad')
  ].join('')}</div>`
  const canDesk = state.staff.role === 'DESK' || state.staff.role === 'MANAGER'
  const rows = list.map((a) => {
    const canCheckin = canDesk && (a.status === 'PENDING' || a.status === 'VERIFY')
    const canCancel = canDesk && a.status === 'PENDING'
    return `<tr><td>${ESC(a.start)} - ${ESC(a.end || '')}</td>
      <td>${ESC(a.patient_name)}<div class="hint">${ESC(a.patient_phone)}</div></td>
      <td>${ESC(a.dentist_name)}</td><td>${ESC(a.clinic_name || '')}</td><td>${ESC(a.need || '—')}</td>
      <td>${statusTag(a.status)}</td>
      <td>${canCheckin ? `<button class="act btn-sm" data-act="checkin" data-id="${a._id}">到诊登记</button>` : ''}
          ${canCancel ? `<button class="act btn-sm danger" data-act="cancel" data-id="${a._id}">取消</button>` : ''}</td></tr>`
  })
  return kpis + card('今日预约', table(['时段', '患者', '牙医', '门店', '需求', '状态', '操作'], rows),
    '到诊 ≠ 治疗完成；取消、未到诊、待核实分开记')
}

/* ------------------------------ 视图：预约管理 ------------------------------ */

// 取某天排班，用于把「改约」的牙医与时段限制在真实出诊范围内。
// 取不到（无权限 / 断网）时退回基础工作时间，只是少一层约束，不影响改约本身。
async function loadDaySchedule(date) {
  if (!date) return
  try {
    const rows = await api('schedule.list', { date })
    state.schDay = { date, rows: Array.isArray(rows) ? rows : [] }
  } catch (e) {
    state.schDay = { date, rows: [] }
  }
  if (state.view === 'appointments') renderView('appointments')
}

function renderAppointments() {
  const q = state.apptQuery
  const clinics = (state.meta && state.meta.clinics) || []
  const canWrite = ['DESK', 'OPERATIONS', 'MANAGER'].includes(state.staff.role)
  const toolbar = `<div class="toolbar">
    <input id="appt-date" type="date" value="${ESC(q.date)}" data-filter="date" />
    <input id="appt-phone" type="text" placeholder="患者手机号" value="${ESC(q.phone)}" data-filter="phone" />
    <select data-filter="clinicId"><option value="">全部门店</option>
      ${clinics.map((c) => `<option value="${c._id}" ${q.clinicId === c._id ? 'selected' : ''}>${ESC(c.name)}</option>`).join('')}</select>
    <button class="btn primary" data-act="appt-search">查询</button>
    <span class="hint">共 ${state.appts.length} 条</span></div>`
  const rows = state.appts.map((a) => `<tr>
    <td>${ESC(a.date)} ${ESC(a.start)}</td>
    <td>${ESC(a.patient_name)}<div class="hint">${ESC(a.patient_phone)}</div></td>
    <td>${ESC(a.dentist_name)}</td><td>${ESC(a.clinic_name || '')}</td>
    <td>${ESC(a.need || '—')}</td><td>${statusTag(a.status)}</td>
    <td>${canWrite && (a.status === 'PENDING' || a.status === 'VERIFY')
      ? `<button class="act btn-sm" data-act="reschedule-open" data-id="${a._id}">改约</button>` : ''}
      ${canWrite && a.status === 'PENDING' ? `<button class="act btn-sm" data-act="set-status" data-id="${a._id}" data-to="VERIFY">待核实</button>
      <button class="act btn-sm" data-act="set-status" data-id="${a._id}" data-to="NO_SHOW">未到诊</button>
      <button class="act btn-sm danger" data-act="set-status" data-id="${a._id}" data-to="VOID">诊所撤销</button>` : ''}</td></tr>`)
  const edit = state.edits.reschedule
  // 当天排班：有数据就按排班限制牙医与时段，没有就退回基础工作时间
  const dayRows = (state.schDay && edit && state.schDay.date === edit.date) ? state.schDay.rows : null
  const allDentists = ((state.meta && state.meta.dentists) || [])
    .filter((d) => !edit || !edit.clinic_id || (d.clinic_ids || []).includes(edit.clinic_id))
  const scheduled = (Array.isArray(dayRows) && dayRows.length)
    ? allDentists.filter((d) => dayRows.some((r) => r.dentist_id === d._id))
    : allDentists
  const editDentists = scheduled.length ? scheduled : allDentists
  const pickDentistId = edit && editDentists.some((d) => d._id === edit.dentist_id)
    ? edit.dentist_id
    : ((editDentists[0] || {})._id || '')
  const editor = edit ? card('改约 · ' + ESC(edit.patient_name) + ' · ' + ESC(edit.clinic_name || ''), `
    <div class="form-grid">
      <label><span>日期</span><input id="rs-date" type="date" min="${ESC(TODAY)}" value="${ESC(edit.date)}" /></label>
      <label><span>时间</span><select id="rs-start">${slotOptions(edit.date, edit.start, pickDentistId, dayRows)}</select></label>
      <label><span>牙医</span><select id="rs-dentist">${editDentists.map((d) =>
        `<option value="${d._id}" ${d._id === pickDentistId ? 'selected' : ''}>${ESC(d.name)}${ESC(d.title ? ' · ' + d.title : '')}</option>`).join('')}</select></label>
      <div class="form-actions"><button class="btn primary" data-act="reschedule-save">保存改约</button>
        <button class="btn" data-act="reschedule-cancel">放弃</button>
        <span class="hint">只能改到同一门店、该牙医当天排班内的未过期时段；原记录保留为「已改约」，时段释放后可被重新预约</span></div>
    </div>`) : ''
  return toolbar + editor + card('预约列表', table(['日期 / 时段', '患者', '牙医', '门店', '需求', '状态', '操作'], rows))
}

/* ------------------------------ 视图：患者档案 ------------------------------ */

function renderPatients() {
  const canWrite = ['DESK', 'MANAGER'].includes(state.staff.role)
  const canConfirm = ['DESK', 'DENTIST', 'MANAGER'].includes(state.staff.role)
  const toolbar = `<div class="toolbar">
    <input id="pt-phone" class="grow" type="text" placeholder="输入手机号查档，如 13800000001" value="${ESC(state.edits.ptPhone || '')}" />
    <button class="btn primary" data-act="patient-search">查档</button>
    ${canWrite ? '<button class="btn" data-act="patient-create-open">新建档案</button>' : ''}</div>`
  const p = state.patients
  const hist = state.patientHistory
  let detail = ''
  if (p === null) detail = '<div class="empty">输入手机号查询，或新建一个患者档案</div>'
  else if (!p) detail = '<div class="empty">未找到该手机号的档案</div>'
  else {
    const allergies = (p.allergies || []).map((a) =>
      `<span class="tag ${a.confirmed ? 'tag-red' : 'tag-amber'}" style="margin-right:6px">${ESC(a.name)}${a.confirmed ? '' : '（待核实）'}</span>
       ${canConfirm && !a.confirmed ? `<button class="act btn-sm" data-act="allergy-confirm" data-name="${ESC(a.name)}">核实</button>` : ''}`).join('')
    const visits = (hist && hist.visits) || []
    detail = `<div class="form-grid">
        <label><span>姓名</span><input value="${ESC(p.name)}" readonly /></label>
        <label><span>手机号</span><input value="${ESC(p.phone)}" readonly /></label>
        <label><span>出生日期</span><input value="${ESC(p.dob || '')}" readonly /></label>
        <label><span>邮箱（可空）</span><input value="${ESC(p.email || '')}" readonly /></label>
        <label><span>账单地址</span><input value="${ESC(p.billing_address || '')}" readonly /></label>
        <label><span>紧急联系人</span><input value="${ESC(p.emergency_name || '')} ${ESC(p.emergency_phone || '')}" readonly /></label>
        <label class="full"><span>过敏（逐项记录，逐项核实）</span><div>${allergies || '<span class="hint">尚未询问或未登记过敏 —— 与「已询问无过敏」不是一回事</span>'}</div></label>
      </div>
      <div style="margin-top:16px">${card('就诊历史', table(['就诊号', '日期', '接诊牙医', '状态', '结算单'],
        visits.map((v) => `<tr><td>${ESC(v.visit_no)}</td><td>${ESC(v.biz_date || '')}</td><td>${ESC(v.dentist_name)}</td>
        <td>${ESC(VISIT_STATUS_TEXT[v.status] || v.status)}</td><td>${v.invoice ? ESC(v.invoice.invoice_no) : '<span class="hint">未开单</span>'}</td></tr>`)))}</div>`
  }
  const create = state.edits.createOpen ? card('新建患者档案（UC01）', `<div class="form-grid">
      <label><span>姓名 *</span><input id="pc-name" /></label>
      <label><span>手机号 *</span><input id="pc-phone" /></label>
      <label><span>出生日期</span><input id="pc-dob" type="date" /></label>
      <label><span>邮箱（可空）</span><input id="pc-email" /></label>
      <label><span>账单地址</span><input id="pc-address" /></label>
      <label><span>紧急联系人 / 电话</span><input id="pc-emergency" placeholder="姓名 电话" /></label>
      <div class="form-actions"><button class="btn primary" data-act="patient-create-save">保存档案</button>
        <button class="btn" data-act="patient-create-cancel">取消</button>
        <span class="hint">同名同手机号同出生日期视为同一人；同号不同姓名拒绝合并，需前台人工核对</span></div>
    </div>`) : ''
  const rows = state.patientRows || []
  const allCard = card(`全部患者档案（${rows.length} 位）`, rows.length
    ? table(['姓名', '手机号', '出生日期', '过敏登记', '操作'], rows.map((r) => `<tr>
        <td>${ESC(r.name)}</td><td>${ESC(r.phone)}</td><td>${ESC(r.dob || '')}</td>
        <td>${(r.allergies || []).length
          ? (r.allergies || []).map((a) => ESC(a.name) + (a.confirmed ? '' : '（待核实）')).join('、')
          : '<span class="hint">未登记</span>'}</td>
        <td><button class="act btn-sm" data-act="patient-pick" data-phone="${ESC(r.phone)}">查档</button></td></tr>`))
    : '<div class="empty">暂无患者档案</div>')
  return toolbar + create + card('档案详情', detail) + allCard
}

/* ------------------------------ 视图：诊间治疗 ------------------------------ */

function renderClinic() {
  const meta = state.meta || {}
  // 牙医账号只看本人接诊的预约，避免看到隔壁椅位的患者
  const self = state.staff.role === 'DENTIST'
    ? (meta.dentists || []).find((x) => x.emp_no && x.emp_no === state.staff.emp_no)
    : null
  const all = ((state.dashboard && state.dashboard.today_list) || [])
    .filter((a) => !self || a.dentist_id === self._id)
  const arrived = all.filter((a) => a.status === 'ARRIVED' || a.status === 'DONE')
  // 一条到诊记录都没有时，把今日预约列出来（带状态），避免整个页面看起来像没有数据。
  const shown = arrived.length ? arrived : all
  const left = shown.length ? `<div class="list">${shown.map((a) => `
    <div class="li ${state.clinic.appt === a._id ? 'active' : ''}" data-act="clinic-open" data-id="${a._id}">
      <div class="li-title">${ESC(a.start)} ${ESC(a.patient_name)} ${arrived.length ? '' : statusTag(a.status)}</div>
      <div class="li-sub">${ESC(a.dentist_name)} · ${ESC(a.need || '')}</div></div>`).join('')}</div>`
    : `<div class="empty">${self ? '今天没有排给你的预约' : '今天还没有预约记录'}</div>`
  const hint = !arrived.length && all.length
    ? `<div class="hint">今日共 ${all.length} 条预约，尚未有到诊登记。点左侧任一条可查看预约详情并登记到诊；登记后才会生成就诊记录、可以开治疗单。</div>`
    : ''
  const canWrite = ['DENTIST', 'MANAGER'].includes(state.staff.role)
  let right = '<div class="empty">左侧选择一条预约或就诊记录</div>'
  const d = state.clinic.detail
  const pa = state.clinic.pendingAppt
  if (d) {
    const p = d.patient || {}
    const allergies = p.allergies || []
    const allergyHtml = allergies.length
      ? `<div class="allergy"><strong>已知过敏</strong>　${allergies.map((a) => ESC(a.name) + (a.confirmed ? '' : '（待核实）')).join('、')}</div>`
      : '<div class="allergy pending">尚未询问或未登记过敏 —— 与「已询问无过敏」不是一回事，需牙医核实</div>'
    const lines = d.lines || []
    const total = lines.reduce((s, l) => s + Number(l.subtotal), 0)
    const editable = canWrite && d.visit.status !== 'INVOICED'
    const hasDraft = lines.some((l) => l.status === 'DRAFT')
    const treatOpts = ((state.meta && state.meta.treatments) || []).map((t) =>
      `<option value="${t._id}">${ESC(t.name)} · ${money(t.unit_price)}</option>`).join('')
    right = `<div class="hint" style="margin-bottom:12px">就诊号 ${ESC(d.visit.visit_no)}　患者 ${ESC(p.name || d.visit.patient_name)}　接诊 ${ESC(d.visit.dentist_name)}</div>
      ${allergyHtml}<div class="hint" style="margin-bottom:12px">特殊需求：${ESC(d.visit.special_need || '无')}</div>
      ${table(['治疗项目', { t: '单位', num: 1 }, { t: '单价（快照）', num: 1 }, { t: '小计', num: 1 }, '状态', ''],
        lines.map((l) => `<tr><td>${ESC(l.name)}</td><td class="num">${l.units}</td><td class="num">${money(l.unit_price)}</td>
        <td class="num">${money(l.subtotal)}</td><td><span class="tag ${l.status === 'CONFIRMED' ? 'tag-green' : 'tag-blue'}">${l.status === 'CONFIRMED' ? '已签署' : '草稿'}</span></td>
        <td>${l.status === 'DRAFT' && editable ? `<button class="act btn-sm danger" data-act="line-del" data-id="${l._id}">删除</button>` : ''}</td></tr>`))}
      <div class="total-line"><span>本次合计</span><span class="big">${money(total)}</span></div>
      ${editable ? `<div class="form-row" style="margin-top:14px">
          <select id="treat-sel">${treatOpts}</select>
          <input id="treat-units" type="number" value="1" min="1" />
          <label>单位</label>
          <button class="act primary" data-act="line-add">追加治疗</button>
          <button class="act" data-act="visit-confirm" ${hasDraft ? '' : 'disabled'}>签署确认</button></div>
        <div class="hint">单价在追加时写入快照，之后调价不影响这一行（T06）</div>`
        : '<div class="hint" style="margin-top:14px">已开结算单 / 无编辑权限，明细锁定</div>'}`
  }
  // 还没登记到诊的预约：给出预约详情，前台/经理可直接在此登记到诊
  if (!d && pa) {
    const canCheckin = ['DESK', 'MANAGER'].includes(state.staff.role)
      && (pa.status === 'PENDING' || pa.status === 'VERIFY')
    const note = pa.status === 'CANCELLED' || pa.status === 'VOID'
      ? `<div class="allergy pending">该预约已${pa.status === 'CANCELLED' ? '取消' : '被门店撤销'}，不能登记到诊，也不能开治疗单。</div>`
      : pa.status === 'NO_SHOW'
        ? '<div class="allergy pending">该预约已记为「未到诊」，如需接诊请让患者重新预约。</div>'
        : canCheckin
          ? '<div class="hint">这是预约信息，还没有就诊记录。点「到诊登记」后才会生成就诊号，然后才能追加治疗、签署和开单。</div>'
          : '<div class="hint">这条预约还没登记到诊。到诊登记由前台或总部经理操作，登记完成后这里会出现可开单的就诊记录。</div>'
    right = `<div class="hint" style="margin-bottom:12px">预约标识 ${ESC(String(pa._id).slice(-6).toUpperCase())}　状态 ${statusTag(pa.status)}</div>
      ${table(['项目', '内容'], [
        `<tr><td>患者</td><td>${ESC(pa.patient_name)}　<span class="hint">${ESC(pa.patient_phone || '')}</span></td></tr>`,
        `<tr><td>时段</td><td>${ESC(pa.date || '')} ${ESC(pa.start)} - ${ESC(pa.end || '')}</td></tr>`,
        `<tr><td>门店 / 牙医</td><td>${ESC(pa.clinic_name || '')} · ${ESC(pa.dentist_name)}</td></tr>`,
        `<tr><td>主诉需求</td><td>${ESC(pa.need || '—')}</td></tr>`,
        `<tr><td>特殊需求</td><td>${ESC(pa.special_need || '无')}</td></tr>`,
        `<tr><td>预约来源</td><td>${ESC(pa.source === 'MINI' ? '小程序' : pa.source === 'PHONE' ? '电话' : pa.source === 'WALKIN' ? '到店' : (pa.source || '柜台'))}</td></tr>`
      ])}
      ${note}
      <div style="margin-top:14px"><button class="act primary" data-act="checkin" data-id="${ESC(pa._id)}"
        ${canCheckin ? '' : 'disabled'}>到诊登记</button></div>`
  }
  return `<div class="split">${card(arrived.length ? `今日已到诊（${arrived.length}）` : `今日预约（${all.length}）`, hint + left)}${card('就诊详情', right)}</div>`
}

/* ------------------------------ 视图：结算开单 ------------------------------ */

function renderBilling() {
  const list = ((state.dashboard && state.dashboard.today_list) || []).filter((a) => a.status === 'ARRIVED' || a.status === 'DONE')
  const left = list.length ? `<div class="list">${list.map((a) => `
    <div class="li ${state.billing.appt === a._id ? 'active' : ''}" data-act="bill-open" data-id="${a._id}">
      <div class="li-title">${ESC(a.start)} ${ESC(a.patient_name)}</div>
      <div class="li-sub">${ESC(a.dentist_name)} · ${ESC(STATUS_TEXT[a.status] || a.status)}</div></div>`).join('')}</div>`
    : '<div class="empty">今天没有可结算的就诊</div><div class="hint">结算以「已登记到诊」的就诊为前提：先在「今日看板」点「到诊登记」，或在「诊间治疗」里点开预约登记到诊。</div>'
  const canWrite = ['FINANCE', 'MANAGER'].includes(state.staff.role)
  let right = '<div class="empty">左侧选择一次就诊</div>'
  const d = state.billing.detail
  if (d) {
    if (d.invoice) right = invoiceHtml(d.invoice, true)
    else {
      const confirmed = (d.lines || []).filter((l) => l.status === 'CONFIRMED')
      const drafts = (d.lines || []).filter((l) => l.status === 'DRAFT')
      const total = confirmed.reduce((s, l) => s + Number(l.subtotal), 0)
      right = `<div class="hint" style="margin-bottom:12px">就诊号 ${ESC(d.visit.visit_no)} · ${ESC(d.visit.patient_name)}</div>
        ${table(['项目', { t: '单位', num: 1 }, { t: '单价', num: 1 }, { t: '小计', num: 1 }],
          confirmed.map((l) => `<tr><td>${ESC(l.name)}</td><td class="num">${l.units}</td><td class="num">${money(l.unit_price)}</td><td class="num">${money(l.subtotal)}</td></tr>`))}
        <div class="total-line"><span>合计</span><span class="big">${money(total)}</span></div>
        ${drafts.length ? `<div class="allergy pending" style="margin-top:14px">还有 ${drafts.length} 行未签署，不能开单（UC06）</div>` : ''}
        <div style="margin-top:14px"><button class="btn primary" data-act="invoice-create"
          ${confirmed.length && !drafts.length && canWrite ? '' : 'disabled'}>生成结算单</button></div>
        <div class="hint" style="margin-top:8px">重复点击会返回同一张单号，不会重复开单</div>`
    }
  }
  const invs = state.invoices || []
  const invList = card('本季度结算单', table(['单号', '牙医', '金额', '期间'],
    invs.map((i) => `<tr><td>${ESC(i.invoice_no)}</td><td>${ESC(i.dentist_name || '')}</td>
      <td class="num">${money(i.total)}</td><td>${ESC(i.period)}</td></tr>`)), `共 ${invs.length} 张有效结算单`)
  return `<div class="split">${card('待开单', left, '治疗已签署的就诊')}${card('结算单', right)}</div>${invList}`
}

/* ------------------------------ 视图：成本与费用 ------------------------------ */

function renderCosts() {
  const canWrite = ['FINANCE', 'OPERATIONS', 'MANAGER'].includes(state.staff.role)
  const dentists = (state.meta && state.meta.dentists) || []
  const rows = state.costs.map((c) => `<tr><td>${ESC(c.period)}</td>
    <td><span class="tag ${c.type === 'UNALLOCATED' ? 'tag-amber' : c.type === 'SUPPLY' ? 'tag-blue' : 'tag-gray'}">${ESC(COST_TYPE_TEXT[c.type] || c.type)}</span></td>
    <td class="num">${money(c.amount)}</td>
    <td>${ESC(dentists.find((d) => d._id === c.dentist_id)?.name || (c.type === 'UNALLOCATED' ? '待分摊' : '—'))}</td>
    <td>${ESC(c.note || '')}</td><td>${ESC(c.voucher || '')}</td></tr>`)
  const form = canWrite ? card('录入成本 / 费用', `<div class="form-grid">
      <label><span>期间</span><input id="cost-period" value="${ESC(THIS_Q)}" /></label>
      <label><span>类型</span><select id="cost-type"><option value="SUPPLY">耗材</option>
        <option value="OPEX">运营费</option><option value="UNALLOCATED">待分摊（暂不归属牙医）</option></select></label>
      <label><span>金额</span><input id="cost-amount" type="number" min="1" placeholder="如 3000" /></label>
      <label><span>归属牙医</span><select id="cost-dentist"><option value="">未指定（仅待分摊可用）</option>
        ${dentists.map((d) => `<option value="${d._id}">${ESC(d.name)}</option>`).join('')}</select></label>
      <label><span>凭证号</span><input id="cost-voucher" /></label>
      <label><span>说明</span><input id="cost-note" /></label>
      <div class="form-actions"><button class="btn primary" data-act="cost-add">保存</button>
        <span class="hint">存在待分摊费用时，季度激励基金显示「待确认」，不发布可分配结果（T09）</span></div></div>`) : ''
  return form + card('费用明细 · ' + THIS_Q, table(['期间', '类型', '金额', '归属', '说明', '凭证'], rows))
}

/* ------------------------------ 视图：季度报表 ------------------------------ */

function renderReport() {
  const r = state.report
  if (!r) return '<div class="card"><div class="empty">报表数据加载失败</div></div>'
  const kpis = `<div class="kpis">${[
    kpi('季度收入', money(r.total.revenue)), kpi('耗材成本', money(r.total.supply)),
    kpi('运营费用', money(r.total.opex)), kpi('净利润', money(r.total.net), '', 'good'),
    kpi('激励基金 (10%)', r.fund === null ? '待确认' : money(r.fund), '', r.fund === null ? 'warn' : '')
  ].join('')}</div>`
  const rows = r.rows.map((x) => `<tr><td>${ESC(x.dentist_name)}<div class="hint">${ESC(x.emp_no)}</div></td>
    <td class="num">${money(x.revenue)}</td><td class="num">${money(x.supply)}</td><td class="num">${money(x.opex)}</td>
    <td class="num">${money(x.net)}</td><td class="num">${x.invoice_count}</td>
    <td>${x.pending_items ? `<span class="tag tag-amber">${x.pending_items} 项</span>` : '<span class="tag tag-gray">无</span>'}</td></tr>`)
  const totalRow = `<tr style="font-weight:600"><td>合计</td><td class="num">${money(r.total.revenue)}</td>
    <td class="num">${money(r.total.supply)}</td><td class="num">${money(r.total.opex)}</td>
    <td class="num">${money(r.total.net)}</td><td></td><td></td></tr>`
  const d = state.dashboard
  const rate = d ? `<div class="rate-box">
    <div>过期有效预约（分母）<strong>${d.denominator || 0}</strong> 条；未来待到诊 <strong>${d.future_pending || 0}</strong> 条<strong>不进分母</strong></div>
    <div>患者取消 <strong>${d.counts.CANCELLED || 0}</strong> 条 → 取消率 <strong>${d.cancel_rate === null ? '—（分母为 0）' : d.cancel_rate + '%'}</strong></div>
    <div>已核实未到诊 <strong>${d.counts.NO_SHOW || 0}</strong> 条 → 未到诊率 <strong>${d.no_show_rate === null ? '—' : d.no_show_rate + '%'}</strong></div>
    <div>待核实 <strong>${d.counts.VERIFY || 0}</strong> 条，单列，不并入取消</div>
    <div class="hint">口径：<code>是否到诊 = false</code> 可表示「还没到日期 / 患者取消 / 没来」，不能把全部 false 都算成取消。</div></div>`
    : ''
  return kpis + card('牙医贡献 · ' + ESC(r.period) + ' · ' + ESC(r.payable),
    table(['牙医', { t: '收入', num: 1 }, { t: '耗材', num: 1 }, { t: '运营费', num: 1 },
      { t: '净利润', num: 1 }, { t: '结算单', num: 1 }, '待分摊'], [...rows, totalRow]) +
    (r.unattributed_count
      ? `<div class="allergy pending" style="margin-top:12px">另有 ${r.unattributed_count} 笔耗材 / 运营费未填归属牙医，已计入合计，但不会出现在任何牙医行。</div>`
      : '')) +
    card('取消率口径', rate)
}

/* ------------------------------ 视图：门店与牙医 ------------------------------ */

function renderCatalog() {
  const tab = state.catalogTab
  const tabs = `<div class="tabs">${[['clinics', '门店'], ['dentists', '牙医'], ['quals', '资质目录']].map(([k, n]) =>
    `<button class="tab ${tab === k ? 'active' : ''}" data-act="catalog-tab" data-tab="${k}">${ESC(n)}</button>`).join('')}</div>`
  const canWrite = ['OPERATIONS', 'MANAGER'].includes(state.staff.role)
  let rows = []
  if (tab === 'clinics') {
    rows = (state.clinics || []).map((c) => `<tr><td>${ESC(c.code)}</td><td>${ESC(c.name)}</td>
      <td>${ESC(c.address || '')}</td><td>${ESC(c.manager || '')}</td><td>${ESC(c.phone || '')}</td>
      <td class="num">${ESC(c.area || '')}</td>
      <td>${c.active === false ? '<span class="tag tag-gray">已停用</span>' : '<span class="tag tag-green">营业中</span>'}</td></tr>`)
  } else if (tab === 'dentists') {
    rows = (state.dentists || []).map((d) => `<tr><td>${ESC(d.emp_no)}</td><td>${ESC(d.name)}</td>
      <td>${ESC((d.clinic_ids || []).map((id) => (state.clinics || []).find((c) => c._id === id)?.name || id).join('、'))}</td>
      <td>${ESC((d.qual_names || []).join('、'))}</td>
      <td>${d.active === false ? '<span class="tag tag-gray">已停用</span>' : '<span class="tag tag-green">在职</span>'}</td></tr>`)
  } else {
    rows = (state.quals || []).map((q) => `<tr><td>${ESC(q.code)}</td><td>${ESC(q.name)}</td></tr>`)
  }
  const heads = tab === 'clinics' ? ['编码', '门店', '地址', '主管', '电话', { t: '面积㎡', num: 1 }, '状态']
    : tab === 'dentists' ? ['工号', '姓名', '出诊门店（可多店）', '资质', '状态'] : ['编码', '资质名称']
  const form = canWrite && tab !== 'quals' ? card(tab === 'clinics' ? '新增门店' : '新增牙医', `<div class="form-grid">
      <label><span>${tab === 'clinics' ? '门店名称' : '姓名'}</span><input id="dict-name" /></label>
      <label><span>${tab === 'clinics' ? '编码' : '工号'}</span><input id="dict-code" /></label>
      <label><span>${tab === 'clinics' ? '主管' : '出诊门店（可多选）'}</span>
        ${tab === 'clinics' ? '<input id="dict-extra" />'
          : `<select id="dict-clinics" multiple size="3">${(state.clinics || []).map((c) =>
              `<option value="${ESC(c._id)}" selected>${ESC(c.name)}</option>`).join('')}</select>`}</label>
      <div class="form-actions"><button class="btn primary" data-act="dict-save">保存</button>
        <span class="hint">这里只做新增；停用或改名请先在下方列表核对，避免重复建档（同一工号 / 编码只建一次）。</span></div></div>`) : ''
  return tabs + form + card(tab === 'clinics' ? `门店列表（${(state.clinics || []).length} 家）`
    : tab === 'dentists' ? `牙医列表（${(state.dentists || []).length} 位）`
    : `资质目录（${(state.quals || []).length} 项）`, table(heads, rows))
}

/* ------------------------------ 视图：诊疗项目 ------------------------------ */

function renderTreatments() {
  const canWrite = ['OPERATIONS', 'MANAGER'].includes(state.staff.role)
  const rows = ((state.meta && state.meta.treatments) || []).map((t) => `<tr>
    <td>${ESC(t.name)}</td><td class="num">${money(t.unit_price)}</td>
    <td>${t.active === false ? '<span class="tag tag-gray">已停用</span>' : '<span class="tag tag-green">启用中</span>'}</td>
    <td>${canWrite ? `<button class="act btn-sm" data-act="treat-edit" data-id="${t._id}" data-price="${t.unit_price}">改价</button>` : ''}</td></tr>`)
  const edit = state.edits.treat
  const form = edit ? card('调整单价 · ' + ESC(edit.name), `<div class="form-grid">
      <label><span>新单价</span><input id="treat-price" type="number" min="1" value="${ESC(edit.price)}" /></label>
      <div class="form-actions"><button class="btn primary" data-act="treat-save">保存</button>
        <button class="btn" data-act="treat-cancel">取消</button>
        <span class="hint">调价只影响之后新开的治疗行；历史结算单里的单价快照不变（T06）</span></div></div>`) : ''
  return form + card('诊疗项目价目表', table(['项目', { t: '单价', num: 1 }, '状态', '操作'], rows)) +
    card('资质目录', table(['编码', '名称'], (state.quals || []).map((q) =>
      `<tr><td>${ESC(q.code)}</td><td>${ESC(q.name)}</td></tr>`)))
}

/* ------------------------------ 动态绑定 ------------------------------ */

function bindDynamic(view) {
  if (view === 'appointments') {
    const date = $('appt-date'), phone = $('appt-phone')
    if (date) date.onchange = (e) => (state.apptQuery.date = e.target.value)
    if (phone) phone.oninput = (e) => (state.apptQuery.phone = e.target.value)
    // 改到「今天」时，上午的格子要收起来：换日期就重算可选的 30 分钟时段
    const rsDate = $('rs-date')
    if (rsDate) {
      rsDate.onchange = (e) => {
        const ed = state.edits.reschedule
        if (!ed) return
        ed.date = e.target.value
        state.schDay = null
        renderView('appointments')
        loadDaySchedule(ed.date)
      }
    }
    // 换牙医也要重算：不同牙医当天的出诊时段不一样
    const rsDentist = $('rs-dentist')
    if (rsDentist) {
      rsDentist.onchange = (e) => {
        const ed = state.edits.reschedule
        if (!ed) return
        ed.dentist_id = e.target.value
        renderView('appointments')
      }
    }
  }
  document.querySelectorAll('[data-filter="clinicId"]').forEach((s) => {
    s.onchange = (e) => (state.apptQuery.clinicId = e.target.value)
  })
}

/* ------------------------------ 事件委托 ------------------------------ */

async function act(t) {
  const a = t.dataset.act
  const id = t.dataset.id
  const role = state.staff.role
  const guard = (roles) => {
    if (!roles.includes(role)) { toast('当前角色无此操作权限'); return false }
    return true
  }
  const needConfirm = (m) => (typeof confirm === 'function' ? confirm(m) : true)
  const CONFIRM_ACTS = {
    cancel: '确定取消这条预约吗？取消后时段会释放给其他患者。',
    'line-del': '确定删除这一行治疗明细吗？',
    'visit-confirm': '签署后治疗明细将锁定，不能再修改。确定签署吗？',
    'invoice-create': '确定按当前治疗明细生成结算单吗？',
    'reschedule-save': '确定改为这个新时段吗？原记录会保留并标记为「已改约」。'
  }
  let confirmMsg = CONFIRM_ACTS[a]
  if (a === 'set-status' && (t.dataset.to === 'VOID' || t.dataset.to === 'NO_SHOW')) {
    confirmMsg = '确定把这条预约标记为「' + (t.dataset.to === 'VOID' ? '诊所撤销' : '未到诊') + '」吗？该状态会影响季度统计。'
  }
  try {
    if (confirmMsg && !needConfirm(confirmMsg)) return
    if (ENH_ACTS.has(a)) return await enhancedAct(a, t)
    switch (a) {
      case 'checkin': {
        if (!guard(['DESK', 'MANAGER'])) return
        const visit = await api('visit.checkin', { appointmentId: id })
        toast('已登记到诊，就诊号 ' + (visit && visit.visit_no ? visit.visit_no : '已生成'))
        // 在诊间视图里登记完，直接打开这次就诊，省得再点一次
        if (state.view === 'clinic') {
          await ensureData('clinic')
          state.clinic.appt = id
          state.clinic.pendingAppt = null
          state.clinic.detail = visit && visit._id ? await api('visit.get', { visitId: visit._id }) : null
          return renderView('clinic')
        }
        return refreshView()
      }
      case 'cancel': {
        if (!guard(['DESK', 'MANAGER'])) return
        await api('appointment.changeStatus', { appointmentId: id, to: 'CANCELLED', reason: '患者电话取消', by: 'DESK' })
        toast('已取消，时段已释放')
        return refreshView()
      }
      case 'set-status': {
        if (!guard(['DESK', 'OPERATIONS', 'MANAGER'])) return
        const labels = { VERIFY: '待核实', NO_SHOW: '未到诊', VOID: '诊所撤销' }
        await api('appointment.changeStatus', { appointmentId: id, to: t.dataset.to, reason: '前台标记 ' + (labels[t.dataset.to] || ''), by: 'DESK' })
        toast('状态已更新为「' + (labels[t.dataset.to] || t.dataset.to) + '」')
        return refreshView()
      }
      case 'reschedule-open': {
        const ap = state.appts.find((x) => x._id === id)
        if (!ap) return
        state.edits.reschedule = { ...ap }
        state.schDay = null
        renderView('appointments')
        await loadDaySchedule(ap.date)
        return
      }
      case 'reschedule-cancel': { state.edits.reschedule = null; return renderView('appointments') }
      case 'reschedule-save': {
        const e = state.edits.reschedule
        const date = $('rs-date').value, start = $('rs-start').value, dentistId = $('rs-dentist').value
        if (!date || !start) return toast('请填写日期和时间')
        await api('appointment.reschedule', { appointmentId: e._id, date, start, dentistId })
        state.edits.reschedule = null
        toast('改约成功')
        return refreshView()
      }
      case 'appt-search': {
        const d = $('appt-date'), ph = $('appt-phone')
        state.apptQuery.date = d ? d.value : TODAY
        state.apptQuery.phone = ph ? ph.value.trim() : ''
        return refreshView()
      }
      case 'patient-search': {
        const phone = ($('pt-phone') && $('pt-phone').value.trim()) || ''
        state.edits.ptPhone = phone
        if (!phone) return toast('请输入手机号')
        busy(true)
        try {
          state.patients = await api('patient.me', { phone })
          state.patientHistory = await api('visit.listByPhone', { phone })
        } finally { busy(false) }
        return renderView('patients')
      }
      case 'patient-pick': {
        const phone = t.dataset.phone || ''
        state.edits.ptPhone = phone
        busy(true)
        try {
          state.patients = await api('patient.me', { phone })
          state.patientHistory = await api('visit.listByPhone', { phone })
        } finally { busy(false) }
        return renderView('patients')
      }
      case 'patient-create-open': { state.edits.createOpen = true; return renderView('patients') }
      case 'patient-create-cancel': { state.edits.createOpen = false; return renderView('patients') }
      case 'patient-create-save': {
        if (!guard(['DESK', 'MANAGER'])) return
        const v = (x) => ($(x) && $(x).value.trim()) || ''
        const emergency = v('pc-emergency').split(/\s+/)
        await api('patient.create', {
          name: v('pc-name'), phone: v('pc-phone'), dob: v('pc-dob'), email: v('pc-email'),
          billing_address: v('pc-address'), emergency_name: emergency[0] || '', emergency_phone: emergency[1] || ''
        })
        state.edits.createOpen = false
        state.edits.ptPhone = v('pc-phone')
        state.patients = await api('patient.me', { phone: v('pc-phone') })
        state.patientHistory = await api('visit.listByPhone', { phone: v('pc-phone') })
        toast('档案已建立')
        return renderView('patients')
      }
      case 'allergy-confirm': {
        if (!guard(['DESK', 'DENTIST', 'MANAGER'])) return
        if (!state.patients) return
        await api('patient.allergy.confirm', { patientId: state.patients._id, name: t.dataset.name })
        state.patients = await api('patient.me', { phone: state.patients.phone })
        toast('已核实该过敏项')
        return renderView('patients')
      }
      case 'clinic-open': {
        state.clinic.appt = id
        const v = await api('visit.byAppointment', { appointmentId: id })
        if (!v) {
          // 还没登记到诊：右侧显示预约详情 + 到诊登记入口，避免点了没有任何反馈
          const list = (state.dashboard && state.dashboard.today_list) || []
          state.clinic.detail = null
          state.clinic.pendingAppt = list.find((a) => a._id === id) || null
        } else {
          state.clinic.pendingAppt = null
          state.clinic.detail = await api('visit.get', { visitId: v._id })
        }
        return renderView('clinic')
      }
      case 'line-add': {
        if (!guard(['DENTIST', 'MANAGER'])) return
        const d = state.clinic.detail
        const sel = $('treat-sel'), units = Number(($('treat-units') && $('treat-units').value) || 1)
        if (!sel || !sel.value) return toast('请选择诊疗项目')
        await api('visitTreatment.add', { visitId: d.visit._id, treatmentId: sel.value, units })
        state.clinic.detail = await api('visit.get', { visitId: d.visit._id })
        toast('已追加 1 行治疗')
        return renderView('clinic')
      }
      case 'line-del': {
        if (!guard(['DENTIST', 'MANAGER'])) return
        await api('visitTreatment.remove', { lineId: id })
        state.clinic.detail = await api('visit.get', { visitId: state.clinic.detail.visit._id })
        return renderView('clinic')
      }
      case 'visit-confirm': {
        if (!guard(['DENTIST', 'MANAGER'])) return
        await api('visitTreatment.confirm', { visitId: state.clinic.detail.visit._id })
        state.clinic.detail = await api('visit.get', { visitId: state.clinic.detail.visit._id })
        toast('已签署，明细锁定，可以开结算单')
        return renderView('clinic')
      }
      case 'bill-open': {
        state.billing.appt = id
        const v = await api('visit.byAppointment', { appointmentId: id })
        state.billing.detail = v ? await api('visit.get', { visitId: v._id }) : null
        return renderView('billing')
      }
      case 'invoice-create': {
        if (!guard(['FINANCE', 'MANAGER'])) return
        const inv = await api('invoice.create', { visitId: state.billing.detail.visit._id })
        toast(inv.reused ? `已存在有效结算单 ${inv.invoice_no}` : `已生成 ${inv.invoice_no}`)
        state.billing.detail = await api('visit.get', { visitId: state.billing.detail.visit._id })
        return renderView('billing')
      }
      case 'cost-add': {
        if (!guard(['FINANCE', 'OPERATIONS', 'MANAGER'])) return
        const v = (x) => ($(x) && $(x).value.trim()) || ''
        const ctype = $('cost-type').value
        const did = $('cost-dentist').value
        if (!(Number(v('cost-amount')) > 0)) return toast('金额必须大于 0')
        if (ctype !== 'UNALLOCATED' && !did) return toast('耗材 / 运营费必须选择归属牙医，否则成本不会进任何牙医行')
        await api('cost.add', {
          period: v('cost-period') || THIS_Q, type: ctype,
          amount: Number(v('cost-amount')), dentistId: did,
          note: v('cost-note'), voucher: v('cost-voucher')
        })
        toast('费用已录入；如有待分摊项，激励基金将显示「待确认」')
        return refreshView()
      }
      case 'catalog-tab': { state.catalogTab = t.dataset.tab; return renderView('catalog') }
      case 'dict-save': {
        if (!guard(['OPERATIONS', 'MANAGER'])) return
        const tab = state.catalogTab
        const name = ($('dict-name') && $('dict-name').value.trim()) || ''
        const code = ($('dict-code') && $('dict-code').value.trim()) || ''
        if (!name || !code) return toast(tab === 'clinics' ? '门店名称和编码都要填' : '姓名和工号都要填')
        let doc
        if (tab === 'clinics') {
          doc = { name, code, manager: ($('dict-extra') && $('dict-extra').value.trim()) || '', active: true }
        } else {
          const sel = $('dict-clinics')
          const ids = sel && sel.selectedOptions ? Array.from(sel.selectedOptions).map((o) => o.value) : []
          if (!ids.length) return toast('请选择至少一家出诊门店')
          doc = { name, emp_no: code, clinic_ids: ids, active: true }
        }
        await api('dict.upsert', { coll: tab, doc })
        toast('已保存')
        return refreshView()
      }
      case 'treat-edit': {
        state.edits.treat = { id, name: t.closest('tr').children[0].textContent, price: t.dataset.price }
        return renderView('treatments')
      }
      case 'treat-cancel': { state.edits.treat = null; return renderView('treatments') }
      case 'treat-save': {
        if (!guard(['OPERATIONS', 'MANAGER'])) return
        const price = Number($('treat-price').value)
        if (!price || price <= 0) return toast('单价必须大于 0')
        await api('dict.upsert', { coll: 'treatments', doc: { _id: state.edits.treat.id, unit_price: price } })
        state.edits.treat = null
        toast('单价已更新（历史单不受影响）')
        return refreshView()
      }
      default: return
    }
  } catch (e) {
    if (e.code === 401) { doLogout(); return }
    toast(e.message || '操作失败')
    // 「记录不存在」说明页面上这条是旧的（小程序或别的窗口已改/已删），顺手刷成最新
    if (e.code === 404 && state.view) refreshView().catch(() => {})
  }
}

/* ------------------------------ 启动 ------------------------------ */

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]')
  if (nav) { go(nav.dataset.view); return }
  const idBtn = e.target.closest('[data-user]')
  if (idBtn) {
    const go = idBtn.querySelector('.id-go')
    if (go) go.textContent = '进入中…'
    $('login-error').classList.add('hidden')
    doLogin(idBtn.dataset.user).catch((err) => showLogin(err.message || '登录失败'))
    return
  }
  const t = e.target.closest('[data-act]')
  if (t) { e.preventDefault(); act(t) }
})

$('btn-logout').addEventListener('click', () => doLogout())

// 顶栏徽标本身就是重连入口：断开时点一下即可恢复，不用重开页面。
if ($('env-badge') && $('env-badge').addEventListener) {
  $('env-badge').addEventListener('click', () => {
    if (!ONLINE || degraded) retryCloud()
  })
}

/* ---------------------- 云端连通性自检 ---------------------- */
// 仅 ?diag=1 触发：把浏览器里每一步的真实结果直接画出来，
// 不用看顶栏徽标、不用悬停，截图即可定位，避免「只能靠人工确认」。
const wantDiag = () => typeof location !== 'undefined' &&
  /(?:^|[?&])diag=1(?:&|$)/.test(String(location.search || ''))

function diagLine(rows, name, ok, detail, ms) {
  rows.push('<div class="diag-row ' + (ok ? 'diag-ok' : 'diag-bad') + '">' +
    '<span class="diag-mark">' + (ok ? '✓' : '✕') + '</span>' +
    '<span class="diag-name">' + ESC(name) + '</span>' +
    '<span class="diag-ms">' + ms + 'ms</span>' +
    '<span class="diag-detail">' + ESC(detail) + '</span></div>')
}

async function runDiag() {
  let panel = $('diag-panel')
  if (!panel && document.createElement) {
    panel = document.createElement('div')
    panel.id = 'diag-panel'
    panel.className = 'diag-panel'
    if (document.body && document.body.appendChild) document.body.appendChild(panel)
  }
  if (!panel) return
  const rows = []
  const render = (summary) => {
    panel.innerHTML = '<div class="diag-title">云端连通性自检' +
      '<button class="diag-close" type="button" aria-label="关闭">×</button></div>' +
      rows.join('') +
      '<div class="diag-summary ' + (summary ? (summary.ok ? 'ok' : 'bad') : '') + '">' +
      ESC(summary ? summary.text : '正在检测…') + '</div>' +
      '<div class="diag-tip">结论为绿色即已与患者小程序共用同一份数据；截图发我即可定位。' +
      '正常使用时去掉 &diag=1。</div>'
    if (panel.querySelector) {
      const c = panel.querySelector('.diag-close')
      if (c) c.onclick = () => { if (panel.remove) panel.remove() }
    }
  }
  render(null)
  const step = async (name, fn, fmt) => {
    const t0 = Date.now()
    try {
      const v = await fn()
      diagLine(rows, name, true, fmt ? fmt(v) : '成功', Date.now() - t0)
      render(null)
      return { ok: true, v }
    } catch (e) {
      const msg = String((e && (e.code || e.status || e.message)) || e || '未知错误')
        .replace(/\s+/g, ' ').slice(0, 160)
      diagLine(rows, name, false, msg, Date.now() - t0)
      render(null)
      return { ok: false, msg }
    }
  }

  const s1 = await step('Web SDK 3.5.0 已加载', async () => {
    if (typeof cloudbase === 'undefined') throw new Error('cloudbase 全局未定义')
    return true
  }, () => '已内联，无外部 CDN 依赖')
  if (!s1.ok) { render({ ok: false, text: 'SDK 未加载：页面文件不完整，请重新发布' }); return }

  let app = null
  const s2 = await step('初始化云环境', async () => {
    app = cloudbase.init({ env: CONFIG.envId })
    if (!app) throw new Error('init 返回空')
    return CONFIG.envId
  }, (v) => v)
  if (!s2.ok) { render({ ok: false, text: '初始化失败：' + s2.msg }); return }

  const s3 = await step('通道账号登录（跨域）', async () => {
    const auth = app.auth({ persistence: 'none' })
    const r = await withTimeout(auth.signInWithPassword({ ...CONFIG.channel }), 10000)
    if (r && r.error) throw new Error((r.error.status || r.error.code) + ' ' + (r.error.message || ''))
    return true
  }, () => '网关放行，access_token 已签发')
  if (!s3.ok) { render({ ok: false, text: '通道登录失败：' + s3.msg }); return }

  const s4 = await step('云函数探活 meta.bootstrap', async () => {
    const r = await withTimeout(app.callFunction({ name: 'api', data: { action: 'meta.bootstrap', payload: {} } }), 12000)
    const d = (r && r.result) || {}
    if (d.code !== 0) throw new Error('code=' + d.code + ' ' + (d.msg || ''))
    return d.data || {}
  }, (d) => 'code 0 · ' + ((d.clinics || []).length) + ' 家门店 · ' +
    ((d.dentists || []).length) + ' 位牙医 · ' + ((d.treatments || []).length) + ' 个诊疗项目')
  if (!s4.ok) { render({ ok: false, text: '云函数不通：' + s4.msg }); return }

  const s5 = await step('员工登录 staff.login', async () => {
    const r = await withTimeout(app.callFunction({ name: 'api', data: { action: 'staff.login', payload: { username: 'manager', password: 'Adc@Staff2026!Q4' } } }), 12000)
    const d = (r && r.result) || {}
    if (d.code !== 0) throw new Error('code=' + d.code + ' ' + (d.msg || ''))
    return d.data || {}
  }, () => 'MANAGER 角色，token 已签发')
  if (!s5.ok) { render({ ok: false, text: '员工登录失败：' + s5.msg }); return }

  const token = (s5.v && s5.v.token) || ''
  const s6 = await step('业务数据 report.dashboard', async () => {
    const r = await withTimeout(app.callFunction({ name: 'api', data: { action: 'report.dashboard', payload: { __token: token } } }), 12000)
    const d = (r && r.result) || {}
    if (d.code !== 0) throw new Error('code=' + d.code + ' ' + (d.msg || ''))
    return d.data || {}
  }, (d) => '日期 ' + (d.today || '-') + ' · 到期有效预约 ' +
    (d.denominator === undefined ? '-' : d.denominator) +
    ' · 今日预约 ' + ((d.today_list || []).length) + ' 条')

  const text = s6.ok
    ? '✅ 云端已连接：6 步全部通过，本页面读取的是患者小程序写入的同一份数据'
    : '❌ 未连通：' + s6.msg
  render({ ok: s6.ok, text })
  try { localStorage.setItem('adc_diag_result', (s6.ok ? 'PASS ' : 'FAIL ') + text) } catch (e) { /* 忽略 */ }
}

// 首次进入时云函数可能正好冷启动，一次失败不代表连不上：隔 1.2 秒再试一次。
async function initCloudWithRetry(times = 2) {
  for (let i = 0; i < times; i++) {
    if (i) await new Promise((r) => setTimeout(r, 800))
    if (await initCloud()) return true
  }
  return false
}

;(async function boot() {
  ONLINE = await initCloudWithRetry()
  updateEnvBadge()
  renderIdentityList()
  if (typeof wantDiag === 'function' && wantDiag()) {
    showLogin()
    await runDiag()
    return
  }
  // 上次登录还在有效期内就直接进工作台；过期则退回身份选择。
  const ok = await restore()
  if (ok) enterApp()
  else showLogin()
})()

/* =====================================================================
 * 需求符合性补强视图
 * 对应《ADC 拟开发项目与业务需求说明》UC01 / UC02 / UC07 / UC08 / UC10 / UC12
 * 与云函数 cloudfunctions/api/enhance.js 一一对应。
 * ===================================================================== */

const INQUIRY_LABEL = { NOT_ASKED: '尚未询问', NO_KNOWN: '已询问，无已知过敏', REPORTED: '已报告过敏' }
const ENH_ACTS = new Set([
  'sch-save', 'sch-del', 'sch-filter', 'audit-search', 'quarter-submit',
  'quarter-approve', 'quarter-detail', 'inquiry-set', 'appt-export', 'qual-save',
  'staff-save', 'staff-reset-open', 'staff-reset-save', 'staff-toggle', 'staff-cancel'
])
const enhTime = (t) => t ? new Date(Number(t)).toLocaleString('zh-CN', { hour12: false }) : '—'
const enhVal = (id) => ($(id) && $(id).value.trim()) || ''
const csvCell = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"'

/* ---------------- 视图：出诊排班（UC08 / T07） ---------------- */
function renderSchedules() {
  const role = state.staff.role
  const canWrite = ['DENTIST', 'OPERATIONS', 'MANAGER'].includes(role)
  const meta = state.meta || {}
  const clinics = meta.clinics || []
  const dentists = meta.dentists || []
  // 牙医账号绑定本人在职门店：下拉只留本人，避免改到别人的出诊
  const self = role === 'DENTIST'
    ? dentists.find((d) => d.emp_no && d.emp_no === state.staff.emp_no)
    : null
  const formDentists = self ? [self] : dentists
  const formClinics = self
    ? clinics.filter((c) => (self.clinic_ids || []).includes(c._id))
    : clinics
  const rows = state.schedules || []
  const shownDate = state.schDate || TODAY
  const form = canWrite && formDentists.length && formClinics.length ? card('新增 / 调整出诊', `<div class="form-grid">
      <label><span>日期</span><input id="sch-date" type="date" value="${ESC(TODAY)}" /></label>
      <label><span>门店</span><select id="sch-clinic">${formClinics.map((c) => `<option value="${ESC(c._id)}">${ESC(c.name)}</option>`).join('')}</select></label>
      <label><span>牙医</span><select id="sch-dentist" ${self ? 'disabled' : ''}>${formDentists.map((d) => `<option value="${ESC(d._id)}">${ESC(d.name)} · ${ESC(d.emp_no || '')}</option>`).join('')}</select></label>
      <label><span>开始</span><input id="sch-start" type="time" value="09:00" /></label>
      <label><span>结束</span><input id="sch-end" type="time" value="12:00" /></label>
      <label><span>备注</span><input id="sch-note" placeholder="轮转安排 / 替代接诊" /></label>
      <div class="form-actions"><button class="btn primary" data-act="sch-save">保存排班</button>
        <span class="hint">${self ? '当前为牙医账号，只能维护本人排班。' : ''}同一牙医同一天跨店时段重叠会直接拒绝；相邻时段会提示转场需人工核实</span></div>
    </div>`) : (canWrite ? card('新增 / 调整出诊', '<div class="empty">未读取到与当前账号匹配的牙医档案，无法新增排班，请联系运营维护工号。</div>') : '')
  const filter = `<div class="toolbar">
      <input id="sch-filter-date" type="date" value="${ESC(shownDate)}" />
      <button class="btn" data-act="sch-filter">按日期查询</button>
      <span class="hint">${ESC(shownDate)} 共 ${rows.length} 条</span></div>`
  const body = rows.length ? table(['日期', '门店', '牙医', '时段', '备注', '操作'], rows.map((r) => {
    const mine = !self || r.dentist_id === self._id
    return `<tr>
      <td>${ESC(r.date)}</td><td>${ESC(r.clinic_name || '')}</td><td>${ESC(r.dentist_name || '')}</td>
      <td>${ESC(r.start)}–${ESC(r.end)}</td><td>${ESC(r.note || '')}</td>
      <td>${canWrite && mine ? `<button class="act btn-sm danger" data-act="sch-del" data-id="${ESC(r._id)}">删除</button>` : '<span class="hint">只读</span>'}</td></tr>`
  })) : `<div class="empty">${ESC(shownDate)} 暂无排班。${canWrite ? '可在上方新增；没有排班时预约页沿用 09:00–12:00 / 14:00–17:30 的基础工作时间。' : '请等待运营排班。'}</div>`
  const roster = card(`在册牙医（${dentists.length} 位）`, dentists.length
    ? table(['工号', '姓名', '职称', '出诊门店'], dentists.map((d) => `<tr>
        <td>${ESC(d.emp_no || '')}</td><td>${ESC(d.name)}</td><td>${ESC(d.title || '')}</td>
        <td>${ESC((d.clinic_ids || []).map((id) => (clinics.find((c) => c._id === id) || {}).name || id).join('、'))}</td></tr>`))
    : '<div class="empty">未读取到牙医资料</div>')
  return form + filter + card('排班清单', body) + roster + card('排班怎样影响预约', `<div class="hint">
    录入任意排班后，「预约」页的可约时段以该门店当天排班为准：没排班的牙医不会出现，排班外的时段不可选。
    一条排班都没录时，沿用系统固定的工作时间（09:00–12:00、14:00–17:30）。
    删除排班时若时段内已有有效预约，会要求先改约或安排替代牙医，不允许直接删掉让预约失去出诊依据。
    牙医账号只能维护本人的排班；跨店冲突与转场间隔由云端统一校验。</div>`)
}

/* ---------------- 视图：员工账号（总部经理） ---------------- */
function renderStaff() {
  const rows = state.staffRows || []
  const roles = Object.keys(ROLE_NAME)
  const form = card('新增员工账号', `<div class="form-grid">
      <label><span>登录账号</span><input id="staff-username" placeholder="小写字母开头，如 desk2" /></label>
      <label><span>姓名</span><input id="staff-name" placeholder="如 何嘉" /></label>
      <label><span>角色</span><select id="staff-role">${roles.map((r) => `<option value="${r}">${ESC(ROLE_NAME[r])}</option>`).join('')}</select></label>
      <label><span>门店 / 部门</span><input id="staff-clinic" placeholder="如 ADC 安德鲁牙科·越秀店" /></label>
      <label><span>工号（牙医必填）</span><input id="staff-emp" placeholder="如 D-DEMO-02" /></label>
      <label><span>初始密码</span><input id="staff-password" type="password" placeholder="至少 8 位" /></label>
      <div class="form-actions"><button class="btn primary" data-act="staff-save">创建账号</button>
        <span class="hint">同一角色可以开多个账号，各自独立登录、共享本角色的业务权限；牙医账号必须填与「门店与牙医」一致的工号，否则排班和诊间无法按本人过滤。</span></div>
    </div>`)
  const reset = state.edits.staffPwd ? card('重置密码 · ' + ESC(state.edits.staffPwd), `<div class="form-grid">
      <label><span>新密码</span><input id="staff-pwd" type="password" placeholder="至少 8 位" /></label>
      <div class="form-actions"><button class="btn primary" data-act="staff-reset-save" data-id="${ESC(state.edits.staffPwd)}">保存新密码</button>
        <button class="btn" data-act="staff-cancel">取消</button>
        <span class="hint">改完密码后该账号已登录的会话不会立刻失效，下次登录用新密码。</span></div>
    </div>`) : ''
  const count = {}
  rows.forEach((r) => (count[r.role] = (count[r.role] || 0) + 1))
  const summary = roles.map((r) => `${ROLE_NAME[r]} ${count[r] || 0}`).join(' · ')
  const body = table(['账号', '姓名', '角色', '门店 / 部门', '工号', '状态', '操作'], rows.map((r) => `<tr>
      <td><code>${ESC(r.username)}</code></td><td>${ESC(r.name)}</td>
      <td>${ESC(r.role_name || ROLE_NAME[r.role] || r.role)}</td>
      <td>${ESC(r.clinic_name || '—')}</td><td>${ESC(r.emp_no || '—')}</td>
      <td>${r.active === false ? '<span class="tag tag-gray">已停用</span>' : '<span class="tag tag-green">启用中</span>'}</td>
      <td><button class="act btn-sm" data-act="staff-reset-open" data-id="${ESC(r.username)}">重置密码</button>
        ${r.username === state.staff.username ? '<span class="hint">当前账号</span>'
          : `<button class="act btn-sm ${r.active === false ? '' : 'danger'}" data-act="staff-toggle" data-id="${ESC(r.username)}">${r.active === false ? '启用' : '停用'}</button>`}</td></tr>`))
  return form + reset + card(`员工账号（${rows.length} 位）`, body, summary) + card('角色与数据范围', `<div class="hint">
    前台：预约 / 到诊 / 患者档案 / 诊间 / 排班（只读）/ 操作记录；牙医：只看本人诊间与本人排班；财务：结算 / 成本 / 报表 / 核算提交；
    运营：跨店排班、门店与牙医、诊疗项目、成本；总部经理：全部页面 + 员工账号 + 季度审批。
    账号是「人」，角色是「权限」——同一角色开多个账号，看到的数据范围相同，操作记录里按姓名区分。</div>`)
}

/* ---------------- 视图：操作记录（UC12 / T10） ---------------- */
function renderAudit() {
  const rows = state.audits || []
  const toolbar = `<div class="toolbar">
      <input id="audit-kw" class="grow" placeholder="按操作、操作者、业务编号或原因搜索" value="${ESC(state.auditKw || '')}" />
      <select id="audit-result"><option value="">全部结果</option>
        <option value="OK" ${state.auditResult === 'OK' ? 'selected' : ''}>成功</option>
        <option value="FAIL" ${state.auditResult === 'FAIL' ? 'selected' : ''}>失败 / 越权</option></select>
      <button class="btn primary" data-act="audit-search">查询</button>
      <span class="hint">共 ${rows.length} 条</span></div>`
  const body = table(['时间', '操作者', '操作', '业务编号', '结果', '原因 / 说明'], rows.map((r) => `<tr>
      <td>${ESC(enhTime(r.at))}</td><td>${ESC(r.operator || '')}</td><td><code>${ESC(r.action || '')}</code></td>
      <td>${ESC(r.biz_no || '') || '<span class="hint">—</span>'}</td>
      <td>${r.result === 'OK' ? '<span class="tag tag-green">成功</span>' : '<span class="tag tag-red">失败 / 越权</span>'}</td>
      <td>${ESC([r.reason, r.message].filter(Boolean).join(' · ') || '—')}</td></tr>`))
  return toolbar + card('最近业务变更', body) + card('留痕口径', `<div class="hint">
    每次新增或变更都会记录操作者、时间、原因与业务编号；越权请求也会被拒绝并单独留一条失败记录。
    可按业务编号追查一条预约从建档、到诊、治疗到结算的完整链路（T10）。</div>`)
}

/* ---------------- 视图：季度核算审批（UC10 / T09 / T08） ---------------- */
function renderQuarter() {
  const qs = state.quarters || []
  const r = state.report || null
  const canSubmit = ['FINANCE', 'MANAGER'].includes(state.staff.role)
  const canApprove = state.staff.role === 'MANAGER'
  const head = r ? `<div class="kpis">${[
    kpi('本季净利润', money(r.total.net)),
    kpi('激励基金 10%', r.fund === null ? '待确认' : money(r.fund), '', r.fund === null ? 'warn' : 'good'),
    kpi('核算状态', r.payable, '', r.payable === '待确认' ? 'warn' : ''),
    kpi('已审批版本', r.approved_version ? 'v' + r.approved_version : '无', '', r.approved_version ? 'good' : 'warn')
  ].join('')}</div>` : ''
  const actions = `<div class="toolbar">
      ${canSubmit ? '<button class="btn primary" data-act="quarter-submit">提交本季度核算</button>' : ''}
      <button class="btn" data-act="quarter-detail" data-id="">查看当前报表来源</button>
      <span class="hint">财务提交 → 经理审批；存在待分摊费用时不能提交</span></div>`
  const versions = table(['版本', '期间', '状态', '提交人 / 时间', '审批人 / 时间', '操作'], qs.map((q) => `<tr>
      <td>v${ESC(q.version)}</td><td>${ESC(q.period)}</td>
      <td>${q.status === 'APPROVED' ? '<span class="tag tag-green">已审批</span>' : '<span class="tag tag-amber">待审批</span>'}</td>
      <td>${ESC(q.submitted_by || '')}<div class="hint">${ESC(enhTime(q.submitted_at))}</div></td>
      <td>${q.status === 'APPROVED' ? ESC(q.approved_by || '') + `<div class="hint">${ESC(enhTime(q.approved_at))}</div>` : '<span class="hint">—</span>'}</td>
      <td><button class="act btn-sm" data-act="quarter-detail" data-id="${ESC(q._id)}">下钻</button>
        ${canApprove && q.status !== 'APPROVED' ? `<button class="act btn-sm primary" data-act="quarter-approve" data-id="${ESC(q._id)}">审批</button>` : ''}</td></tr>`))
  const src = r && r.sources ? `<div class="hint">来源结算单 ${r.sources.invoice_nos.length} 张：${ESC(r.sources.invoice_nos.slice(0, 8).join('、')) || '—'}${r.sources.invoice_nos.length > 8 ? ' …' : ''}<br />
    来源费用凭证 ${r.sources.cost_vouchers.length} 张：${ESC(r.sources.cost_vouchers.slice(0, 8).join('、')) || '—'}${r.sources.cost_vouchers.length > 8 ? ' …' : ''}</div>` : ''
  const detail = state.quarterDetail ? card('版本快照 · ' + ESC(state.quarterDetail.period || '') + ' · v' + ESC(state.quarterDetail.version || ''),
    `<div class="hint">净利润 ${money((state.quarterDetail.snapshot || {}).total ? state.quarterDetail.snapshot.total.net : 0)}　
     基金 ${money((state.quarterDetail.snapshot || {}).fund || 0)}　状态 ${ESC(state.quarterDetail.status)}</div>` +
    table(['牙医', { t: '收入', num: 1 }, { t: '耗材', num: 1 }, { t: '运营费', num: 1 }, { t: '净利润', num: 1 }],
      ((state.quarterDetail.snapshot || {}).rows || []).map((x) => `<tr><td>${ESC(x.dentist_name)}</td>
        <td class="num">${money(x.revenue)}</td><td class="num">${money(x.supply)}</td>
        <td class="num">${money(x.opex)}</td><td class="num">${money(x.net)}</td></tr>`))) : ''
  return head + actions + detail + card('核算版本链（更正生成新版本，不覆盖已批准结果）', versions) +
    card('来源下钻', src || '<div class="hint">切换到本页后加载</div>')
}

/* ---------------- 患者档案：过敏询问状态（UC01 / UC04） ---------------- */
const _origRenderPatients = renderPatients
renderPatients = function () {
  const html = _origRenderPatients()
  const p = state.patients
  if (!p || !p._id) return html
  const cur = p.allergy_inquiry_status || 'NOT_ASKED'
  const canSet = ['DESK', 'DENTIST', 'MANAGER'].includes(state.staff.role)
  const btns = Object.keys(INQUIRY_LABEL).map((k) => `<button class="btn ${k === cur ? 'primary' : ''}"
      data-act="inquiry-set" data-status="${k}" data-id="${ESC(p._id)}" ${canSet ? '' : 'disabled'}>${ESC(INQUIRY_LABEL[k])}</button>`).join('')
  return html + card('过敏询问状态', `<div class="toolbar">${btns}
      <span class="hint">当前：<strong>${ESC(INQUIRY_LABEL[cur])}</strong>${p.allergy_inquiry_at ? ' · ' + ESC(enhTime(p.allergy_inquiry_at)) : ''}</span></div>
      <div class="hint">「尚未询问」和「已询问，无已知过敏」是两件事，不能都显示为空（UC04）。
      标记为「已报告过敏」前必须先登记至少一条过敏原。患者自报的过敏只能由员工端核实。</div>`)
}

/* ---------------- 季度报表：版本与来源提示（UC10） ---------------- */
const _origRenderReport = renderReport
renderReport = function () {
  const html = _origRenderReport()
  const r = state.report
  if (!r) return html
  const inv = (r.sources && r.sources.invoice_nos) || []
  const vos = (r.sources && r.sources.cost_vouchers) || []
  return html + card('核算版本与可核查来源', `<div class="hint">
    当前期间 <strong>${ESC(r.period)}</strong>；已审批版本 <strong>${r.approved_version ? 'v' + ESC(r.approved_version) : '无'}</strong>；
    可下钻结算单 <strong>${inv.length}</strong> 张、费用凭证 <strong>${vos.length}</strong> 张。
    财务提交与经理审批请到「核算审批」页；10% 是公司激励基金，不自动分给个人（T09）。</div>`)
}

/* ---------------- 诊疗项目：所需资质配置（UC07 / UC02） ---------------- */
const _origRenderTreatments = renderTreatments
renderTreatments = function () {
  const html = _origRenderTreatments()
  const ts = (state.meta && state.meta.treatments) || []
  const qs = state.quals || []
  const canWrite = ['OPERATIONS', 'MANAGER'].includes(state.staff.role)
  const rows = ts.map((t) => {
    const need = t.required_qual_ids || []
    const mode = t.qual_match_mode || 'ANY'
    return `<tr><td>${ESC(t.name)}</td>
      <td>${qs.map((q) => `<label style="margin-right:8px;white-space:nowrap"><input type="checkbox" class="qc-${ESC(t._id)}" value="${ESC(q._id)}" ${need.includes(q._id) ? 'checked' : ''} ${canWrite ? '' : 'disabled'} /> ${ESC(q.name)}</label>`).join('') || '<span class="hint">未配置</span>'}</td>
      <td><select id="qm-${ESC(t._id)}" ${canWrite ? '' : 'disabled'}>
        <option value="ANY" ${mode === 'ANY' ? 'selected' : ''}>任一符合</option>
        <option value="ALL" ${mode === 'ALL' ? 'selected' : ''}>全部符合</option></select></td>
      <td>${canWrite ? `<button class="act btn-sm" data-act="qual-save" data-id="${ESC(t._id)}">保存</button>` : ''}</td></tr>`
  })
  return html + card('治疗项目所需资质（UC07）', table(['项目', '所需资质（可多选）', '匹配模式', '操作'], rows) +
    `<div class="hint">配置后，「预约」按治疗需求查询候选牙医时会自动过滤掉资质不满足的牙医；
     「任一符合」= 持有其中一项即可，「全部符合」= 必须持有全部。资质核实状态由运营经理维护，历史治疗不受停用影响。</div>`)
}

/* ---------------- 预约管理：导出（受角色菜单约束） ---------------- */
const _origRenderAppointments = renderAppointments
renderAppointments = function () {
  const html = _origRenderAppointments()
  const rows = state.appts || []
  return html + card('数据导出', `<div class="toolbar">
      <button class="btn" data-act="appt-export">导出当前查询结果 CSV</button>
      <span class="hint">共 ${rows.length} 条；导出内容与当前角色可见范围一致，操作会记入「操作记录」</span></div>`)
}

function exportAppointmentsCsv() {
  const rows = state.appts || []
  const head = ['预约号', '患者', '手机号', '门店', '牙医', '日期', '时段', '状态', '来源']
  const lines = [head.map(csvCell).join(',')].concat(rows.map((a) => [
    a._id, a.patient_name, a.patient_phone, a.clinic_name, a.dentist_name,
    a.date, `${a.start}-${a.end || ''}`, STATUS_TEXT[a.status] || a.status, a.source
  ].map(csvCell).join(',')))
  try {
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ADC_预约_' + TODAY + '.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast('已导出 ' + rows.length + ' 条预约')
  } catch (e) { toast('导出失败：' + e.message) }
}

/* ---------------- 新增操作分发 ---------------- */
async function enhancedAct(a, t) {
  const id = t.dataset.id
  try {
    switch (a) {
      case 'sch-filter': {
        state.schDate = enhVal('sch-filter-date') || TODAY
        state.schedules = await api('schedule.list', { date: state.schDate })
        return renderView('schedules')
      }
      case 'sch-save': {
        const payload = {
          dentistId: enhVal('sch-dentist'), clinicId: enhVal('sch-clinic'),
          date: enhVal('sch-date') || TODAY, start: enhVal('sch-start'),
          end: enhVal('sch-end'), note: enhVal('sch-note')
        }
        const r = await api('schedule.upsert', payload)
        toast(r && r.warning ? r.warning : '排班已保存')
        return refreshView()
      }
      case 'sch-del': {
        if (typeof confirm === 'function' && !confirm('确定删除这条排班吗？时段内若已有有效预约会被拒绝。')) return
        await api('schedule.remove', { scheduleId: id })
        toast('排班已删除')
        return refreshView()
      }
      case 'staff-save': {
        if (!guard(['MANAGER'])) return
        await api('staff.upsert', {
          username: enhVal('staff-username'), name: enhVal('staff-name'),
          role: enhVal('staff-role'), clinic_name: enhVal('staff-clinic'),
          emp_no: enhVal('staff-emp'), password: enhVal('staff-password')
        })
        toast('员工账号已创建，可用新账号登录')
        return refreshView()
      }
      case 'staff-reset-open': {
        state.edits.staffPwd = id
        return renderView('staff')
      }
      case 'staff-reset-save': {
        if (!guard(['MANAGER'])) return
        const pwd = enhVal('staff-pwd')
        if (!pwd) return toast('请输入新密码')
        const row = (state.staffRows || []).find((x) => x.username === id) || {}
        await api('staff.upsert', {
          username: id, name: row.name, role: row.role, clinic_name: row.clinic_name,
          emp_no: row.emp_no, password: pwd
        })
        state.edits.staffPwd = ''
        toast('密码已重置，请通知该员工用新密码登录')
        return refreshView()
      }
      case 'staff-toggle': {
        if (!guard(['MANAGER'])) return
        const row = (state.staffRows || []).find((x) => x.username === id)
        if (!row) return
        const next = !(row.active !== false)
        if (typeof confirm === 'function' &&
          !confirm(`确定${next ? '启用' : '停用'}账号「${row.username}」吗？`)) return
        await api('staff.upsert', {
          username: row.username, name: row.name, role: row.role,
          clinic_name: row.clinic_name, emp_no: row.emp_no, active: next
        })
        toast(next ? '账号已启用' : '账号已停用')
        return refreshView()
      }
      case 'staff-cancel': {
        state.edits.staffPwd = ''
        return renderView('staff')
      }
      case 'audit-search': {
        state.auditKw = enhVal('audit-kw')
        state.auditResult = enhVal('audit-result')
        state.audits = await api('audit.list', { keyword: state.auditKw, result: state.auditResult, limit: 100 })
        return renderView('audit')
      }
      case 'quarter-submit': {
        await api('quarter.submit', { period: THIS_Q, note: '财务提交季度核算，请经理审批' })
        toast('核算版本已提交，等待经理审批')
        return refreshView()
      }
      case 'quarter-approve': {
        if (typeof confirm === 'function' && !confirm('确定审批通过这一版季度核算吗？审批后版本不可覆盖。')) return
        await api('quarter.approve', { quarterId: id, note: '经理审批通过' })
        toast('已审批，版本留存')
        return refreshView()
      }
      case 'quarter-detail': {
        if (!id) {
          const r = state.report
          state.quarterDetail = r ? { period: r.period, version: '当前实时', status: r.payable, snapshot: r } : null
        } else {
          state.quarterDetail = await api('quarter.detail', { quarterId: id })
        }
        return renderView('quarter')
      }
      case 'inquiry-set': {
        const status = t.dataset.status
        const r = await api('patient.allergy.setInquiry', { patientId: id, status, note: '前台 / 牙医复核' })
        state.patients = { ...(state.patients || {}), ...r }
        toast('已更新为「' + (INQUIRY_LABEL[status] || status) + '」')
        return renderView('patients')
      }
      case 'qual-save': {
        const ids = Array.from(document.querySelectorAll('.qc-' + id + ':checked')).map((x) => x.value)
        const mode = ($('qm-' + id) && $('qm-' + id).value) || 'ANY'
        await api('dict.upsert', { coll: 'treatments', doc: { _id: id, required_qual_ids: ids, qual_match_mode: mode } })
        toast('所需资质已保存')
        return refreshView()
      }
      case 'appt-export': return exportAppointmentsCsv()
      default: return
    }
  } catch (e) {
    toast(e.message || '操作失败')
  }
}
