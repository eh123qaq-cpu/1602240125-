const TABS = [
  { pagePath: '/pages/home/index', text: '首页', icon: 'home' },
  { pagePath: '/pages/booking/index', text: '预约', icon: 'calendar' },
  { pagePath: '/pages/appointments/index', text: '我的预约', icon: 'list' },
  { pagePath: '/pages/profile/index', text: '我的', icon: 'user' }
]

Component({
  data: {
    selected: 0,
    list: TABS
  },

  methods: {
    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index)
      const item = TABS[index]
      if (!item) return
      if (index === this.data.selected) return
      wx.switchTab({ url: item.pagePath })
    }
  }
})
