const config = require('./config')

App({
  onLaunch() {
    this.initCloud()
    this.checkUpdate()
    this.captureSystemInfo()
  },

  initCloud() {
    if (!wx.cloud) {
      console.error('[ADC] 基础库版本过低，请使用 2.2.3 以上版本')
      return
    }
    if (!config.envId) {
      // 未配置云环境：走本地演示数据，功能完整但不落库
      console.warn('[ADC] 未配置 config.envId，当前为本地演示模式')
      this.globalData.cloudReady = false
      return
    }
    wx.cloud.init({
      env: config.envId,
      traceUser: true
    })
    this.globalData.cloudReady = true
  },

  checkUpdate() {
    if (!wx.getUpdateManager) return
    const mgr = wx.getUpdateManager()
    mgr.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '更新后即可使用最新功能',
        confirmText: '立即重启',
        success: (r) => {
          if (r.confirm) mgr.applyUpdate()
        }
      })
    })
  },

  captureSystemInfo() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.globalData.statusBarHeight = info.statusBarHeight || 20
      this.globalData.windowWidth = info.windowWidth || 375
    } catch (e) {
      this.globalData.statusBarHeight = 20
      this.globalData.windowWidth = 375
    }
  },

  globalData: {
    cloudReady: false,
    statusBarHeight: 20,
    windowWidth: 375,
    config
  }
})
