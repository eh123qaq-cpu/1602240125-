/**
 * 员工账号初始化（受限）
 *
 * 只写 staff / staff_sessions 两张表，**绝不触碰 patients / appointments /
 * invoices / wechat_users 等业务集合** —— 所以可以在小程序体验版已经跑通之后
 * 单独执行，不会把患者端的登录绑定和演示数据清掉。
 *
 * ⚠️ 网页已公开发布，因此本云函数默认停用：调用时必须带本地初始化密钥
 *    __seedKey，否则直接返回 403。密钥只保存在本地源码与项目 README 中。
 *    员工密码为 STAFF_PASSWORD，与前端演示模式使用的 adc123456 不同：
 *    云端 staff.login 在云函数里比对 scrypt 哈希，前端硬编码的演示密码
 *    在云端模式下无效，公开链接无法据此登录真云端。
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const STAFF_PASSWORD = 'Adc@Staff2026!Q4'
const SEED_KEY = 'adc-seed-7f3c9d21b8e4'

const SEED = [
  { username: 'desk',     name: '周晓雯', role: 'DESK',       clinic_name: 'ADC 安德鲁牙科·天河店', emp_no: 'E-DESK-01' },
  { username: 'desk2',    name: '何嘉',   role: 'DESK',       clinic_name: 'ADC 安德鲁牙科·越秀店', emp_no: 'E-DESK-02' },
  { username: 'dentist',  name: '陈安',   role: 'DENTIST',    clinic_name: 'ADC 安德鲁牙科·天河店', emp_no: 'D-DEMO-01' },
  { username: 'dentist2', name: '李敏',   role: 'DENTIST',    clinic_name: 'ADC 安德鲁牙科·天河店', emp_no: 'D-DEMO-02' },
  { username: 'dentist3', name: '王强',   role: 'DENTIST',    clinic_name: 'ADC 安德鲁牙科·越秀店', emp_no: 'D-DEMO-03' },
  { username: 'finance',  name: '许静',   role: 'FINANCE',    clinic_name: '总部',       emp_no: 'E-FIN-01' },
  { username: 'ops',      name: '梁俊',   role: 'OPERATIONS', clinic_name: '总部',       emp_no: 'E-OPS-01' },
  { username: 'manager',  name: '黄立群', role: 'MANAGER',    clinic_name: '总部',       emp_no: 'E-MGR-01' }
]

const hashPwd = (pwd, salt) => crypto.scryptSync(pwd, salt, 32).toString('hex')

const ensure = async (name) => {
  try {
    await db.createCollection(name)
    return name + ': created'
  } catch (e) {
    const m = String((e && (e.errMsg || e.message)) || e)
    if (/exist/i.test(m)) return name + ': already exists'
    try {
      await db.collection(name).limit(1).get()
      return name + ': get ok'
    } catch (e2) { /* 继续用 add 触发建集合 */ }
    try {
      const r = await db.collection(name).add({ data: { __probe: 1 } })
      await db.collection(name).doc(r._id).remove()
      return name + ': add-trigger created'
    } catch (e3) {
      return name + ': FAILED ' + String((e3 && (e3.errMsg || e3.message)) || e3).slice(0, 100)
    }
  }
}

const clear = async (name) => {
  try {
    const r = await db.collection(name).limit(200).get()
    for (const d of r.data) await db.collection(name).doc(d._id).remove()
    return r.data.length
  } catch (e) {
    return -1
  }
}

exports.main = async (event = {}) => {
  if (String((event && event.__seedKey) || '') !== SEED_KEY) {
    return { code: 403, msg: 'seedStaff 已停用：需提供本地初始化密钥（见项目 README）' }
  }
  try {
    const collections = [await ensure('staff'), await ensure('staff_sessions')]
    const removedAccounts = await clear('staff')
    const removedSessions = await clear('staff_sessions')

    const now = Date.now()
    for (const s of SEED) {
      const salt = crypto.randomBytes(16).toString('hex')
      await db.collection('staff').add({
        data: {
          ...s,
          salt,
          password_hash: hashPwd(STAFF_PASSWORD, salt),
          active: true,
          created_at: now
        }
      })
    }

    return {
      code: 0,
      data: {
        collections,
        removedAccounts,
        removedSessions,
        accounts: SEED.map((s) => ({ username: s.username, role: s.role, name: s.name })),
        note: '员工密码见项目 README；本函数默认停用，需 __seedKey 才能再次执行。'
      }
    }
  } catch (e) {
    return { code: 500, msg: e.message || 'seedStaff 执行失败', where: String(e.stack || '').slice(0, 300) }
  }
}
