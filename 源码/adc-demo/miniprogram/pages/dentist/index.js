const { call, toast } = require('../../utils/api')

Page({
  data: {
    loading: true,
    dentist: null,
    clinics: []
  },

  onLoad(q) {
    this.dentistId = q.id
    this.load()
  },

  async load() {
    if (!this.dentistId) {
      this.setData({ loading: false })
      return
    }
    try {
      const d = await call('dentist.get', { dentistId: this.dentistId }, { retry: 0 })
      this.setData({
        loading: false,
        dentist: { ...d.dentist, initial: String(d.dentist.name || '医').slice(0, 1) },
        clinics: d.clinics || []
      })
      wx.setNavigationBarTitle({ title: `${d.dentist.name} 医生` })
    } catch (e) {
      this.setData({ loading: false })
      toast(e)
    }
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  },

  openClinic(e) {
    wx.navigateTo({ url: `/pages/clinic/index?id=${e.currentTarget.dataset.id}` })
  },
  onShareAppMessage() {
    const d = this.data.dentist
    return { title: d ? `${d.name} 医生 · ${d.title}` : 'ADC 课程演示', path: `/pages/dentist/index?id=${this.dentistId}` }
  }
})
