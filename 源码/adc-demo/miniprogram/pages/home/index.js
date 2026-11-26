const { call, toast } = require('../../utils/api')
const auth = require('../../utils/auth')
const syncTab = require('../../utils/tab')
const F = require('../../utils/format')
const config = require('../../config')

const greeting = () => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

Page({
  data: {
    loading: true,
    error: false,
    bound: false,
    patient: null,
    next: null,
    clinics: [],
    services: [],
    greet: greeting(),
    servicePhone: config.servicePhone,
    serviceHours: config.serviceHours
  },

  onShow() {
    syncTab(this, 0)
    this.ensureIdentity()
    this.load()
  },

  // 首次进入没有演示身份时，引导去选一个（点一下即可，不需要注册）
  async ensureIdentity() {
    if (this.identityChecked) return
    this.identityChecked = true
    try {
      const s = await auth.getSession()
      if (s && !s.bound) {
        wx.navigateTo({ url: '/pages/login/index?from=%2Fpages%2Fhome%2Findex' })
      }
    } catch (e) {
      /* 网络异常时留在首页，页面自身会显示错误态 */
    }
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  async load(fromPull) {
    if (!fromPull) this.setData({ loading: this.data.clinics.length === 0 })
    try {
      const [clinics, meta] = await Promise.all([
        call('clinic.list', {}, { retry: 0 }),
        call('meta.bootstrap', {}, { retry: 0 })
      ])

      let bound = false
      let patient = null
      let next = null

      try {
        const s = await auth.getSession()
        if (s && s.bound) {
          bound = true
          patient = s.patient
          next = await call('appointment.mine.next', {}, { retry: 0 })
        }
      } catch (e) {
        // 未登录不阻塞首页浏览
      }

      this.setData({
        loading: false,
        error: false,
        bound,
        patient,
        next: next ? this.decorate(next) : null,
        clinics,
        services: (meta.treatments || []).slice(0, 6).map((t) => ({
          id: t._id,
          name: t.name,
          price: F.money(t.unit_price)
        }))
      })
    } catch (e) {
      this.setData({ loading: false, error: true })
      toast(e)
    }
  },

  decorate(a) {
    const today = F.ymd(new Date())
    return {
      ...a,
      dayText: F.dayLabel(a.date, today),
      dateText: F.monthDay(a.date),
      weekText: F.weekday(a.date),
      countdown: F.countdown(a.date, a.start)
    }
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  },

  goAppointments() {
    wx.switchTab({ url: '/pages/appointments/index' })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/records/index' })
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' })
  },

  openClinic(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/clinic/index?id=${id}` })
  },

  openNext() {
    wx.switchTab({ url: '/pages/appointments/index' })
  },

  navTo(e) {
    const { lat, lng, name, address } = e.currentTarget.dataset
    if (!lat || !lng) return toast(new Error('暂未维护门店坐标'))
    wx.openLocation({
      latitude: Number(lat),
      longitude: Number(lng),
      name,
      address,
      scale: 17
    })
  },

  callClinic() {
    wx.showToast({ title: '虚构演示号码，请勿拨打', icon: 'none' })
  },

  bookService(e) {
    const name = e.currentTarget.dataset.name
    wx.setStorageSync('adc_booking_need', name)
    wx.switchTab({ url: '/pages/booking/index' })
  },

  onShareAppMessage() {
    return {
      title: `${config.appName} · 演示预约与记录查询`,
      path: '/pages/home/index'
    }
  }
})
