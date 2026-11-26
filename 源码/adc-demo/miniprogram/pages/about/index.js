const config = require('../../config')

Page({
  data: {
    appName: config.appName,
    version: config.version,
    phone: config.servicePhone,
    hours: config.serviceHours,
    useMock: !config.envId
  },

  callClinic() {
    wx.showToast({ title: '虚构演示号码，请勿拨打', icon: 'none' })
  },

  goConsent() {
    wx.navigateTo({ url: '/pages/consent/index' })
  },
})
