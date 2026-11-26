const auth = require('../../utils/auth')
const { call, toast } = require('../../utils/api')
const config = require('../../config')

Page({
  data: {
    brand: config.brandShort,
    appName: config.appName,
    list: [],
    loading: true,
    agreed: false,
    entering: '',
    error: ''
  },

  onLoad() {
    // 已登录直接放行，避免回退到登录页时卡住
    auth
      .getSession()
      .then((s) => {
        if (s && s.bound) this.back()
      })
      .catch(() => {})
    this.load()
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const d = await call('patient.demoList', {}, { retry: 0 })
      this.setData({ list: (d && d.list) || [], loading: false })
    } catch (e) {
      this.setData({ loading: false, error: (e && e.message) || '演示身份加载失败' })
    }
  },

  toggleAgree() {
    this.setData({ agreed: !this.data.agreed })
  },

  openPolicy() {
    wx.navigateTo({ url: '/pages/consent/index' })
  },

  async pick(e) {
    if (!this.data.agreed) return toast(new Error('请先勾选演示须知'))
    const id = e.currentTarget.dataset.id
    if (!id || this.data.entering) return
    this.setData({ entering: id })
    try {
      await auth.demoLogin(id)
      auth.agreePolicy()
      this.back()
    } catch (err) {
      toast(err)
    }
    this.setData({ entering: '' })
  },

  back() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack({
        fail: () => wx.switchTab({ url: '/pages/home/index' })
      })
    } else {
      wx.switchTab({ url: '/pages/home/index' })
    }
  }
})
