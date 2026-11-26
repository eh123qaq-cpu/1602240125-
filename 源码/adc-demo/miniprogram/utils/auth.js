/**
 * 登录态
 *
 * 发布级做法：身份来自云函数里的 OPENID，前端拿不到也改不了。
 * 本地演示模式（config.envId 为空）下用 wx.storage 模拟一个已绑定手机号。
 */
const { call } = require('./api')
const config = require('../config')

const POLICY_KEY = 'adc_policy_agreed'

let session = null
let inflight = null

const cache = (s) => {
  session = s
  return s
}

/** 取当前登录态，带缓存 */
const getSession = (force = false) => {
  if (session && !force) return Promise.resolve(session)
  if (inflight) return inflight
  inflight = call('patient.session', {}, { retry: 0 })
    .then((d) => {
      inflight = null
      return cache(d)
    })
    .catch((e) => {
      inflight = null
      throw e
    })
  return inflight
}

const isBound = () => !!(session && session.bound && session.patient)

/**
 * 页面初始化守卫：
 *  - 未登录 → 跳登录页，返回 false
 *  - 已登录 → 返回 true
 * 页面写法：if (!(await auth.guard())) return
 */
async function guard() {
  try {
    const s = await getSession()
    if (s && s.bound) return true
  } catch (e) {
    // 网络异常时不硬跳登录页，交给页面显示错误态
    if (!e.needLogin) throw e
  }
  const pages = getCurrentPages()
  const cur = pages[pages.length - 1]
  const from = cur ? `/${cur.route}` : ''
  wx.navigateTo({ url: `/pages/login/index?from=${encodeURIComponent(from)}` })
  return false
}

/** 绑定手机号（历史接口，小程序端已改为选择演示身份） */
async function bind(name, phone) {
  const d = await call('patient.bind', { name, phone }, { loading: true })
  return cache(d)
}

/** 选择一个演示身份进入：不收集姓名手机号，只关联虚构档案与微信匿名标识 */
async function demoLogin(patientId) {
  const d = await call('patient.demoLogin', { patientId }, { loading: true })
  return cache(d)
}

async function logout() {
  try {
    await call('auth.logout', {}, { retry: 0 })
  } catch (e) {
    /* 本地模式或云端未实现时忽略 */
  }
  session = null
}

const patient = () => (session && session.patient) || null
const refresh = () => getSession(true)

/** 隐私政策是否已同意（版本变化会重新征询） */
const policyAgreed = () => {
  try {
    return wx.getStorageSync(POLICY_KEY) === config.policyVersion
  } catch (e) {
    return false
  }
}

const agreePolicy = () => {
  try {
    wx.setStorageSync(POLICY_KEY, config.policyVersion)
  } catch (e) {
    /* 忽略 */
  }
}

module.exports = {
  getSession,
  isBound,
  guard,
  bind,
  demoLogin,
  logout,
  patient,
  refresh,
  policyAgreed,
  agreePolicy
}
