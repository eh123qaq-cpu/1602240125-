/* 回归测试：云端降级后可自动恢复，不再一次失败就永久锁在演示模式。
 *
 * 覆盖用户反馈过的「同一个链接有时候云端、过会就变演示数据」：
 *   1) 一次网络抖动 → 降级到演示数据，但保留重连能力
 *   2) 下一次操作 → 自动重连成功，本次直接读回云端数据，顶栏恢复
 *   3) 业务 401 仍然原样抛出，不被降级吞掉
 *   4) 演示模式（无 ?cloud=1）完全不发起云端调用
 *
 * 运行：node tests/web-cloud-recover.js
 */
const fs = require('fs')
const vm = require('vm')
const path = require('path')

const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' -> ' + extra : '')) }
}

function makeEl() {
  const classes = new Set()
  return {
    id: '', innerHTML: '', textContent: '', value: '', disabled: false, title: '',
    dataset: {},
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, f) => {
        if (f === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c) }
        else { f ? classes.add(c) : classes.delete(c) }
      }
    },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)) },
    get className() { return [...classes].join(' ') },
    addEventListener() {}, querySelectorAll() { return [] }, querySelector() { return null },
    appendChild() {}, closest() { return null }, remove() {}, scrollTo() {}
  }
}

function makeEnv(opts) {
  const els = {}
  const get = id => els[id] || (els[id] = makeEl())
  const store = {}
  const cloud = { failCall: false, failProbe: false, biz401: false, biz404: false, body500: false, biz500text: false, signIns: 0, calls: [] }
  const sdk = {
    init() {
      return {
        auth() {
          return {
            hasLoginState() { return false },
            signInWithPassword() { cloud.signIns++; return Promise.resolve({}) }
          }
        },
        callFunction(p) {
          const action = p && p.data && p.data.action
          cloud.calls.push(action)
          if (action === 'meta.bootstrap') {
            if (cloud.failProbe) return Promise.reject(new Error('network down'))
            return Promise.resolve({ result: { code: 0, data: { clinics: [] } } })
          }
          if (cloud.failCall) { cloud.failCall = false; return Promise.reject(new Error('socket hang up')) }
          if (cloud.body500) {
            cloud.body500 -= 1
            return Promise.resolve({ result: { code: 500, msg: '服务异常：Cannot read properties of undefined' } })
          }
          if (cloud.biz500text) {
            cloud.biz500text = false
            return Promise.resolve({ result: { code: 500, msg: '预约不存在' } })
          }
          if (cloud.biz401) {
            cloud.biz401 = false
            return Promise.resolve({ result: { code: 401, msg: '账号或密码不正确' } })
          }
          if (cloud.biz404) {
            cloud.biz404 = false
            return Promise.resolve({ result: { code: 404, msg: '记录不存在或已被删除，请刷新页面后重试' } })
          }
          return Promise.resolve({ result: { code: 0, data: { from: 'cloud' } } })
        }
      }
    }
  }
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Date, Math, Number, String,
    Array, Object, JSON, RegExp, Error, isNaN, parseInt, parseFloat,
    document: {
      getElementById: get, addEventListener() {}, querySelectorAll() { return [] },
      createElement: () => makeEl(), body: { appendChild() {} }, head: { appendChild() {} }
    },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: k => { delete store[k] }
    },
    window: { scrollTo() {} },
    location: { search: opts.search || '' },
    cloudbase: sdk
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx, { filename: 'app.js' })
  return { ctx, get, cloud, run: expr => vm.runInContext(expr, ctx) }
}

const tick = () => new Promise(r => setTimeout(r, 1600))

async function main() {
  const e = makeEnv({ search: '?cloud=1' })
  await tick()

  check('1 云端模式初始化成功', e.run('ONLINE === true && degraded === false'))
  const signIns0 = e.cloud.signIns
  check('1 启动时强制签票', signIns0 >= 1, 'signIns=' + signIns0)

  // 真正的断网（连探活都失败）：请求直接报错，不返回任何假数据
  e.cloud.failCall = true
  e.cloud.failProbe = true
  let c2 = 0
  let m2 = ''
  try { await e.run('api("report.dashboard", {})') } catch (err) { c2 = err && err.code; m2 = String(err && err.message) }
  check('2 断网时请求报错且不返回假数据', c2 === 503, 'code=' + c2)
  check('2 徽标提示可重连', /重连/.test(String(e.get('env-badge').textContent)), e.get('env-badge').textContent)
  check('2 提示数据保持不动', /保持不动|保持不变/.test(m2), m2)

  e.cloud.failProbe = false
  e.cloud.failCall = false
  const cloudResult = await e.run('api("report.dashboard", {})')
  check('3 下次操作自动重连成功', e.run('degraded === false && ONLINE === true'))
  check('3 本次请求读回云端数据', !!cloudResult && cloudResult.from === 'cloud', JSON.stringify(cloudResult))
  check('3 徽标恢复云端已连接', e.get('env-badge').textContent === '云端已连接')
  check('3 重连时重新签票', e.cloud.signIns > signIns0)

  e.cloud.biz401 = true
  let code = 0
  try { await e.run('api("staff.login", {})') } catch (err) { code = err && err.code }
  check('4 业务 401 原样抛出且不降级', code === 401 && e.run('degraded === false'), 'code=' + code)

  // 用户反馈「改约时提示云端暂不可用然后变成演示数据」：写失败绝不能降级
  e.cloud.failCall = true
  let wcode = 0
  let wmsg = ''
  try { await e.run('api("appointment.reschedule", { appointmentId: "x1", date: "2026-12-01", start: "09:00" })') }
  catch (err) { wcode = err && err.code; wmsg = String(err && err.message) }
  check('6 写操作失败只报错不降级', wcode === 503 && e.run('degraded === false'), 'code=' + wcode)
  check('6 写失败明确告知没有改动数据', /没有改到任何数据/.test(wmsg), wmsg)

  // 恢复连接后写操作直接落到云端（页面里已经没有"演示 ID"这一层）
  e.run('degraded = true; lastRecoverAt = 0')
  const before7 = e.cloud.calls.length
  let w7 = 0
  try { await e.run('api("appointment.changeStatus", { appointmentId: "a3", to: "CANCELLED" })') }
  catch (err) { w7 = (err && err.code) || 1 }
  const wrote7 = e.cloud.calls.slice(before7).filter(a => a === 'appointment.changeStatus')
  check('7 恢复后写操作正常发出', w7 === 0 && wrote7.length === 1, 'code=' + w7 + ' calls=' + wrote7.join(','))

  // 记录不存在（云端 404）是业务错误，不能触发整页降级
  e.cloud.biz404 = true
  let c404 = 0
  try { await e.run('api("appointment.changeStatus", { appointmentId: "zz", to: "CANCELLED" })') }
  catch (err) { c404 = err && err.code }
  check('8 记录不存在按业务错误处理', c404 === 404 && e.run('degraded === false'), 'code=' + c404)

  check('9 横幅能显示 SDK 对象错误的原因',
    e.run('fmtErr({ errCode: -1, errMsg: "document.get:fail" })').indexOf('document.get:fail') >= 0)

  // 用户反馈「一有错误比如预约不存在，右上角就跳演示数据」：
  // 单条请求报错但云端探活正常 → 只提示，不降级、不换数据。
  e.run('degraded = false; state.source = "cloud"')
  // 单次异常：自动重试一次即恢复，用户看不到报错
  e.cloud.body500 = 1
  const retried = await e.run('api("report.dashboard", {})')
  check('10 单次异常自动重试成功', !!retried && e.run('degraded === false'))
  // 连续异常：重试后仍失败才提示
  e.cloud.body500 = 2
  let code10 = 0
  let msg10 = ''
  try { await e.run('api("report.dashboard", {})') }
  catch (err) { code10 = err && err.code; msg10 = String(err && err.message) }
  check('10 单条查询异常不降级', code10 === 500 && e.run('degraded === false'), 'code=' + code10)
  check('10 提示读取失败可重试', /读取失败/.test(msg10) && /重试/.test(msg10), msg10)
  check('10 徽标仍显示云端已连接', e.get('env-badge').textContent === '云端已连接')

  // 只有文字没有 code 的业务拒绝，同样按「请求不合规」处理，不能算云端坏了
  e.cloud.biz500text = true
  let code11 = 0
  let msg11 = ''
  try { await e.run('api("appointment.reschedule", { appointmentId: "zz", date: "2026-12-01", start: "09:00" })') }
  catch (err) { code11 = err && err.code; msg11 = String(err && err.message) }
  check('11 文字型业务错误直接透出', /预约不存在/.test(msg11) && e.run('degraded === false'), msg11)

  // 已经在看云端真实数据时断网：守住数据，绝不再偷偷换成演示数据
  e.cloud.failCall = true
  e.cloud.failProbe = true
  let code12 = 0
  let msg12 = ''
  let got12 = null
  try { got12 = await e.run('api("appointment.list", {})') }
  catch (err) { code12 = err && err.code; msg12 = String(err && err.message) }
  check('12 断网时不返回演示数据', code12 === 503 && got12 === null, 'code=' + code12)
  check('12 告知数据保持不变', /保持不动|保持不变/.test(msg12), msg12)
  check('12 横幅说明数据未被替换', /保持不变/.test(String(e.get('banner').textContent)))

  // 点徽标重连：恢复后徽标回到云端已连接，横幅收起
  e.cloud.failProbe = false
  e.cloud.failCall = false
  await e.run('retryCloud()')
  check('13 手动重连成功', e.run('degraded === false && ONLINE === true'))
  check('13 徽标恢复云端已连接', e.get('env-badge').textContent === '云端已连接')
  check('13 横幅自动收起', e.get('banner').classList.contains('hidden'))

  // 不带任何 URL 参数也必须连云端（以前要 ?cloud=1）
  const d = makeEnv({ search: '' })
  await tick()
  const before = d.cloud.calls.length
  await d.run('api("report.dashboard", {})')
  check('5 不带参数也连云端', d.run('ONLINE === true') && d.cloud.calls.length > before, 'calls=' + (d.cloud.calls.length - before))

  console.log('\n' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error('测试异常：', err); process.exit(1) })
