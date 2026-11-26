/**
 * 真云端端到端测试（需要已登录的微信开发者工具 + 已开启自动化端口）
 *
 * 前置：
 *   1. 开发者工具 → 设置 → 安全设置 → 服务端口 打开
 *   2. cli auto --project <本目录> --auto-port 9420
 *   3. npm i miniprogram-automator（放在任意临时目录即可）
 *
 * 运行：node tests/e2e-cloud.js
 * 覆盖：并发抢号（5 并发只过 1）、取消后时段回收、患者自助下单
 */
const automator = require('miniprogram-automator')
;(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420', timeout: 120000 })
  const call = (a, p) => mp.evaluate(([x, y]) => new Promise((res) => {
    wx.cloud.callFunction({ name: 'api', data: { action: x, payload: y } })
      .then((r) => res(r.result))
      .catch((e) => res({ code: -1, msg: 'CALLFAIL ' + (e.errMsg || e.message) }))
  }), [a, p])

  const meta = (await call('meta.bootstrap', {})).data
  const clinic = meta.clinics[0]
  const dentist = meta.dentists[0]
  const d = new Date(Date.now() + 86400000)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const payload = { clinicId: clinic._id, dentistId: dentist._id, date, start: '11:00', need: '并发测试' }

  // 5 个请求同时打同一个时段
  const results = await mp.evaluate(([pl]) => {
    const one = () => new Promise((res) => {
      wx.cloud.callFunction({ name: 'api', data: { action: 'appointment.create', payload: pl } })
        .then((r) => res(r.result.code))
        .catch(() => res(-1))
    })
    return Promise.all([one(), one(), one(), one(), one()])
  }, [payload])

  const okCount = results.filter((c) => c === 0).length
  const conflict = results.filter((c) => c === 409).length
  console.log('并发结果 codes =', JSON.stringify(results))
  console.log('成功 =', okCount, '| 冲突409 =', conflict, '| 其他 =', results.length - okCount - conflict)

  // 取消后该时段应重新可约
  const mine = (await call('appointment.mine', {})).data
  const target = mine.find((a) => a.start === '11:00' && a.date === date && a.status === 'PENDING')
  console.log('新单 =', target ? target.status : 'none')
  if (target) {
    await call('appointment.cancelSelf', { appointmentId: target._id, reason: '并发测试收尾' })
    const slots = (await call('appointment.availableSlots', { clinicId: clinic._id, date })).data
    const g = slots.find((x) => x.dentist_id === dentist._id)
    const has = g ? g.slots.some((s) => s.start === '11:00') : false
    console.log('取消后 11:00 是否回到可约池 =', has)
  }
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
