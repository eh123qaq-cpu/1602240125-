const { call, toast } = require('../../utils/api')

Page({
  data: {
    loading: true,
    clinic: null,
    dentists: []
  },

  onLoad(q) {
    this.clinicId = q.id
    this.load()
  },

  async load() {
    if (!this.clinicId) {
      this.setData({ loading: false })
      return
    }
    try {
      const d = await call('clinic.get', { clinicId: this.clinicId }, { retry: 0 })
      this.setData({
        loading: false,
        clinic: d.clinic,
        dentists: (d.dentists || []).map((x) => ({ ...x, initial: String(x.name || '医').slice(0, 1) }))
      })
      wx.setNavigationBarTitle({ title: d.clinic.short_name || d.clinic.name })
    } catch (e) {
      this.setData({ loading: false })
      toast(e)
    }
  },

  navTo() {
    const c = this.data.clinic
    if (!c || !c.lat) return toast(new Error('暂未维护门店坐标'))
    wx.openLocation({
      latitude: Number(c.lat),
      longitude: Number(c.lng),
      name: c.name,
      address: c.address,
      scale: 17
    })
  },

  callClinic() {
    wx.showToast({ title: '虚构演示号码，请勿拨打', icon: 'none' })
  },

  openDentist(e) {
    wx.navigateTo({ url: `/pages/dentist/index?id=${e.currentTarget.dataset.id}` })
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  },

  onShareAppMessage() {
    const c = this.data.clinic
    return { title: c ? c.name : 'ADC 课程演示', path: `/pages/clinic/index?id=${this.clinicId}` }
  }
})
