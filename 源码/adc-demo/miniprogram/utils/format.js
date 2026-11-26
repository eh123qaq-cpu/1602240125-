/** 日期、金额、状态的统一格式化 —— 所有页面共用，避免各写一套 */

const pad = (n) => (n < 10 ? '0' + n : '' + n)

const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const parse = (s) => {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(y, m - 1, d)
}

const addDays = (d, n) => {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() + n)
  return x
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 2026-11-24 → 11月24日 */
const monthDay = (s) => {
  const d = parse(s)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 2026-11-24 → 周二 */
const weekday = (s) => `周${WEEK[parse(s).getDay()]}`

/** 相对今天的说法：今天 / 明天 / 周三 */
const dayLabel = (s, today) => {
  if (s === today) return '今天'
  if (s === ymd(addDays(parse(today), 1))) return '明天'
  return weekday(s)
}

/** 生成从今天起的 n 天 */
const dateStrip = (days) => {
  const today = ymd(new Date())
  return Array.from({ length: days }).map((_, i) => {
    const d = addDays(new Date(), i)
    const s = ymd(d)
    return { date: s, day: d.getDate(), week: i === 0 ? '今天' : WEEK[d.getDay()], label: dayLabel(s, today) }
  })
}

/** 2026-11-24 09:00 → 11月24日 周二 09:00 */
const fullTime = (date, start) => `${monthDay(date)} ${weekday(date)} ${start || ''}`.trim()

const money = (n) => {
  const v = Math.round(Number(n || 0) * 100) / 100
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/** 千分位，用于报表类金额 */
const thousands = (n) => money(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 距离预约还有多久 */
const countdown = (date, start) => {
  const now = new Date()
  const target = parse(date)
  const [h, m] = String(start || '00:00').split(':').map(Number)
  target.setHours(h, m, 0, 0)
  const diff = target.getTime() - now.getTime()
  if (diff <= 0) return ''
  const days = Math.floor(diff / 86400000)
  if (days >= 1) return `${days} 天后`
  const hours = Math.floor(diff / 3600000)
  if (hours >= 1) return `${hours} 小时后`
  return `${Math.max(1, Math.floor(diff / 60000))} 分钟后`
}

/** 掩码手机号 138****0001 */
const maskPhone = (p) => (p && p.length === 11 ? `${p.slice(0, 3)}****${p.slice(7)}` : p || '')

/**
 * 预约状态：文案 + 视觉语气
 * 注意 PENDING 与 VERIFY 必须分开显示 —— "未到诊"不等于"取消"
 */
const STATUS = {
  PENDING: { text: '待开始', tone: 'blue' },
  ARRIVED: { text: '已确认', tone: 'green' },
  DONE: { text: '已完成', tone: 'green' },
  CANCELLED: { text: '已取消', tone: 'gray' },
  VOID: { text: '演示撤销', tone: 'gray' },
  RESCHEDULED: { text: '已改约', tone: 'gray' },
  VERIFY: { text: '待核实', tone: 'amber' },
  NO_SHOW: { text: '未完成', tone: 'red' }
}

const statusOf = (s) => STATUS[s] || { text: s || '未知', tone: 'gray' }

/** 演示记录是否有可展示的结算单 */
const visitState = (v) => {
  if (v.invoice) return { text: '已结算', tone: 'green' }
  return { text: '处理中', tone: 'blue' }
}

const ago = (ts) => {
  if (!ts) return ''
  const diff = Date.now() - Number(ts)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

module.exports = {
  pad, ymd, parse, addDays, monthDay, weekday, dayLabel,
  dateStrip, fullTime, money, thousands, countdown, maskPhone,
  STATUS, statusOf, visitState, ago
}
