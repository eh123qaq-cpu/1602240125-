/**
 * 统一请求层
 *
 * 所有页面只通过这里访问数据，好处：
 *  1. 只有一处决定走云端还是本地演示数据
 *  2. 错误文案、超时、重试、loading 统一处理，页面里不再写一堆 catch
 *  3. 需要登录的接口统一抛 needLogin，页面只处理一种分支
 */
const config = require('../config')
const mock = require('./mock')

const USE_MOCK = !config.envId
const TIMEOUT = 15000

/* ---------------------------- loading 计数 ---------------------------- */

let pending = 0
const begin = () => {
  if (pending === 0) {
    wx.showLoading({ title: '加载中', mask: true })
  }
  pending += 1
}
const end = () => {
  pending = Math.max(0, pending - 1)
  if (pending === 0) {
    try {
      wx.hideLoading()
    } catch (e) {
      /* 未显示时忽略 */
    }
  }
}

/* ---------------------------- 错误归一 ---------------------------- */

const makeError = (msg, code, extra) => {
  const e = new Error(msg)
  e.code = code
  if (extra) Object.assign(e, extra)
  return e
}

const NET_MSG = '网络不太顺畅，请稍后重试'

const normalize = (raw) => {
  if (!raw) return makeError(NET_MSG, -1)
  if (raw.code === 401 || raw.bizCode === 401) {
    return makeError(raw.msg || '请先登录', 401, { needLogin: true })
  }
  return makeError(raw.msg || '服务开小差了，请稍后重试', raw.code || 500)
}

/* ---------------------------- 云端调用 ---------------------------- */

const callCloud = (action, payload) =>
  new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(makeError('请求超时，请检查网络后重试', -1))
    }, TIMEOUT)

    wx.cloud.callFunction({
      name: 'api',
      data: { action, payload },
      success(res) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const r = res && res.result
        if (!r) return reject(makeError('服务无响应', -1))
        if (r.code === 0) resolve(r.data)
        return reject(normalize(r))
      },
      fail(e) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const msg = (e && e.errMsg) || ''
        if (/FunctionName|not found|env/i.test(msg)) {
          reject(makeError('云函数 api 未部署，请先在开发者工具里上传部署', -1))
        } else {
          reject(makeError(NET_MSG, -1))
        }
      }
    })
  })

/* ---------------------------- 对外接口 ---------------------------- */

/**
 * @param {string} action 云函数 action
 * @param {object} payload 入参
 * @param {object} opts { loading: 是否显示全局 loading, retry: 网络错误重试次数 }
 */
async function call(action, payload = {}, opts = {}) {
  const { loading = false, retry = 1 } = opts
  if (loading) begin()
  try {
    if (USE_MOCK) {
      await new Promise((r) => setTimeout(r, 120))
      return await mock.handle(action, payload)
    }
    let lastErr = null
    for (let i = 0; i <= retry; i += 1) {
      try {
        return await callCloud(action, payload)
      } catch (e) {
        lastErr = e
        // 业务错误不重试，只有网络类错误才重试
        if (e.code !== -1 || i === retry) throw e
      }
    }
    throw lastErr
  } finally {
    if (loading) end()
  }
}

/** 统一 Toast 文案，页面里 catch 之后调它就行 */
const toast = (e) => {
  const msg = (e && e.message) || '操作失败'
  wx.showToast({ title: msg, icon: 'none', duration: 2200 })
}

module.exports = {
  call,
  toast,
  USE_MOCK
}
