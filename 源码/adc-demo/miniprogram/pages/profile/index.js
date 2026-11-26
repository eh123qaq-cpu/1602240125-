const { call, toast } = require('../../utils/api')
const auth = require('../../utils/auth')
const syncTab = require('../../utils/tab')
const F = require('../../utils/format')
const config = require('../../config')

Page({
  data: {
    bound: false,
    patient: null,
    stats: { visits: 0, pending: 0, spent: '0' },
    version: config.version,
    servicePhone: config.servicePhone,
    useMock: !config.envId
  },

  onShow() {
    syncTab(this, 3)
    this.load()
  },

  async load() {
    if (!(await auth.guard())) return
    try {
      const s = await auth.getSession()
      const patient = { ...s.patient, initial: String(s.patient.name || '患').slice(0, 1), phoneMasked: F.maskPhone(s.patient.phone) }

      let visits = 0
      let spent = 0
      let pending = 0
      try {
        const [apts, vs] = await Promise.all([
          call('appointment.mine', {}, { retry: 0 }),
          call('visit.mine', {}, { retry: 0 })
        ])
        pending = (apts || []).filter((a) => a.status === 'PENDING').length
        visits = (vs.visits || []).length
        spent = (vs.visits || []).reduce((sum, v) => sum + (v.invoice ? Number(v.invoice.total) : 0), 0)
      } catch (e) {
        /* 统计失败不影响主流程 */
      }

      this.setData({
        bound: true,
        patient,
        stats: { visits, pending, spent: F.thousands(spent) }
      })
    } catch (e) {
      toast(e)
    }
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/records/index' })
  },

  goAppointments() {
    wx.switchTab({ url: '/pages/appointments/index' })
  },

  goConsent() {
    wx.navigateTo({ url: '/pages/consent/index' })
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/index' })
  },

  callClinic() {
    wx.showToast({ title: '虚构演示号码，请勿拨打', icon: 'none' })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新用手机号登录才能查看预约与档案',
      success: async (r) => {
        if (!r.confirm) return
        await auth.logout()
        this.setData({ bound: false, patient: null, stats: { visits: 0, pending: 0, spent: '0' } })
        wx.reLaunch({ url: '/pages/home/index' })
      }
    })
  },

  resetDemo() {
    wx.showModal({
      title: '重置演示数据',
      content: '会清空本地演示数据并恢复初始状态，仅本地模式可用。',
      success: (r) => {
        if (!r.confirm) return
        call('demo.reset', {}, { retry: 0 })
          .then(async () => {
            await auth.logout()
            wx.reLaunch({ url: '/pages/login/index' })
          })
          .catch((e) => toast(e))
      }
    })
  }
})
