/**
 * wx-server-sdk 本地测试桩（内存实现）
 *
 * 只实现 cloudfunctions 里真正用到的那部分接口：
 *   cloud.init / cloud.database / cloud.getWXContext
 *   db.collection().add / .doc().get|update|set|remove / .where().get|count|update|remove
 *   db.command 的 eq neq lt lte gt gte in nin，db.RegExp，db.serverDate
 *
 * 放在 tests/stub 下，由 tests/*.js 用 Module._resolveFilename 重定向，
 * 不依赖 node_modules，npm 安装别的东西也不会把它带走。
 */

let autoId = 0
const stores = new Map()

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const storeOf = (name) => {
  if (!stores.has(name)) stores.set(name, [])
  return stores.get(name)
}

const OP = (op, v) => ({ __op: op, v })
const command = {
  eq: (v) => OP('eq', v),
  neq: (v) => OP('neq', v),
  lt: (v) => OP('lt', v),
  lte: (v) => OP('lte', v),
  gt: (v) => OP('gt', v),
  gte: (v) => OP('gte', v),
  in: (v) => OP('in', v),
  nin: (v) => OP('nin', v),
  and: (...args) => OP('and', args),
  or: (...args) => OP('or', args),
  exists: (v) => OP('exists', v),
  inc: (v) => ({ __updateOp: 'inc', v }),
  mul: (v) => ({ __updateOp: 'mul', v }),
  push: (v) => ({ __updateOp: 'push', v }),
  pull: (v) => ({ __updateOp: 'pull', v }),
}
const _ = command

const isRegExpCfg = (c) => c && typeof c === 'object' && typeof c.regexp === 'string'

function matchOne(docVal, cond) {
  if (isRegExpCfg(cond)) {
    return new RegExp(cond.regexp, cond.options || '').test(String(docVal == null ? '' : docVal))
  }
  if (cond && typeof cond === 'object' && cond.__op) {
    const { v } = cond
    switch (cond.__op) {
      case 'eq': return sameValue(docVal, v)
      case 'neq': return !sameValue(docVal, v)
      case 'lt': return docVal < v
      case 'lte': return docVal <= v
      case 'gt': return docVal > v
      case 'gte': return docVal >= v
      case 'in': return (Array.isArray(v) ? v : [v]).some((x) => sameValue(docVal, x))
      case 'nin': return !(Array.isArray(v) ? v : [v]).some((x) => sameValue(docVal, x))
      case 'exists': return v ? docVal !== undefined : docVal === undefined
      case 'and': return v.every((c2) => matchOne(docVal, c2))
      case 'or': return v.some((c2) => matchOne(docVal, c2))
      default: return false
    }
  }
  return sameValue(docVal, cond)
}

function sameValue(a, b) {
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => sameValue(x, b))
  if (a === b) return true
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function matchDoc(doc, cond) {
  if (!cond || !Object.keys(cond).length) return true
  return Object.keys(cond).every((k) => {
    const c = cond[k]
    if (c && typeof c === 'object' && (c.__op === 'and' || c.__op === 'or')) return matchOne(doc[k], c)
    return matchOne(doc[k], c)
  })
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach((k) => {
    const v = data[k]
    if (v && typeof v === 'object' && v.__updateOp) {
      if (v.__updateOp === 'inc') doc[k] = (Number(doc[k]) || 0) + Number(v.v)
      else if (v.__updateOp === 'mul') doc[k] = (Number(doc[k]) || 0) * Number(v.v)
      else if (v.__updateOp === 'push') doc[k] = [].concat(doc[k] || [], v.v)
      else if (v.__updateOp === 'pull') doc[k] = (doc[k] || []).filter((x) => !sameValue(x, v.v))
      return
    }
    doc[k] = clone(v)
  })
}

function makeQuery(name, cond) {
  const state = { cond: cond || {}, limit: null, skip: 0, order: [] }
  const rows = () => {
    let list = storeOf(name).filter((d) => matchDoc(d, state.cond))
    state.order.forEach(([field, dir]) => {
      list = list.slice().sort((x, y) => {
        const a = x[field]
        const b = y[field]
        if (a === b) return 0
        const r = a > b ? 1 : -1
        return dir === 'desc' ? -r : r
      })
    })
    if (state.skip) list = list.slice(state.skip)
    if (state.limit !== null) list = list.slice(0, state.limit)
    return list
  }
  const api = {
    orderBy(field, dir) { state.order.push([field, dir || 'asc']); return api },
    limit(n) { state.limit = n; return api },
    skip(n) { state.skip = n; return api },
    field() { return api },
    async get() { return { data: clone(rows()) } },
    async count() { return { total: rows().length } },
    async update({ data }) {
      const list = rows()
      list.forEach((d) => applyUpdate(d, data))
      return { stats: { updated: list.length } }
    },
    async remove() {
      const list = rows()
      const del = new Set(list.map((d) => d._id))
      stores.set(name, storeOf(name).filter((d) => !del.has(d._id)))
      return { stats: { removed: list.length } }
    },
  }
  return api
}

function docApi(name, id) {
  const find = () => storeOf(name).find((d) => d._id === id)
  return {
    async get() {
      const d = find()
      if (!d) throw new Error('document.get:fail document does not exist')
      return { data: clone(d) }
    },
    async update({ data }) {
      const d = find()
      if (!d) return { stats: { updated: 0 } }
      applyUpdate(d, data)
      return { stats: { updated: 1 } }
    },
    async set({ data }) {
      const d = find()
      if (d) {
        Object.keys(d).forEach((k) => { if (k !== '_id') delete d[k] })
        applyUpdate(d, data)
        return { stats: { updated: 1, created: 0 } }
      }
      storeOf(name).push({ _id: id, ...clone(data) })
      return { stats: { updated: 0, created: 1 } }
    },
    async remove() {
      const before = storeOf(name).length
      stores.set(name, storeOf(name).filter((d) => d._id !== id))
      return { stats: { removed: before - storeOf(name).length } }
    },
  }
}

const db = {
  command: _,
  RegExp: ({ regexp, options }) => ({ regexp, options }),
  serverDate: () => ({ $date: new Date().toISOString() }),
  collection(name) {
    return {
      add: async ({ data }) => {
        const row = clone(data)
        if (!row._id) {
          autoId += 1
          row._id = `${name}_${String(autoId).padStart(4, '0')}`
        }
        const exist = storeOf(name).findIndex((d) => d._id === row._id)
        if (exist >= 0) storeOf(name)[exist] = row
        else storeOf(name).push(row)
        return { _id: row._id }
      },
      doc: (id) => docApi(name, id),
      where: (cond) => makeQuery(name, cond),
      count: async () => ({ total: storeOf(name).length }),
      get: async () => ({ data: clone(storeOf(name)) }),
      orderBy: (f, d) => makeQuery(name, {}).orderBy(f, d),
      limit: (n) => makeQuery(name, {}).limit(n),
    }
  },
}

const cloud = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() {},
  database: () => db,
  getWXContext: () => ({
    OPENID: 'test-openid-lin',
    APPID: 'wx583ee405799889c2',
    UNIONID: '',
  }),
}

module.exports = cloud
module.exports.default = cloud
module.exports.__reset = () => { stores.clear(); autoId = 0 }
