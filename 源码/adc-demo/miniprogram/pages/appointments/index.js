const { call, toast } = require('../../utils/api')
const auth = require('../../utils/auth')
const syncTab = require('../../utils/tab')
const F = require('../../utils/format')

const FILTERS = [
  { key: 'all', text: '全部' },
  { key: 'pending', text: '待到诊' },
  { key: 'done', text: '已完成' },
  { key: 'closed', text: '已取消' }
]

const GROUPS = {
  pending: ['PENDING', 'VERIFY'],
  done: ['ARRIVED', 'DONE'],
  closed: ['CANCELLED', 'VOID', 'NO_SHOW', 'RESCHEDULED']
}

Page({
  data: {
    filters: FILTERS,
    filter: 'all',
    all: [],
    items: [],
    loading: true,
    bound: false,
    error: false
  },

  onShow() {
    syncTab(this, 2)
    this.load()
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  async load(fromPull) {
    if (!(await auth.guard())) {
      this.setData({ loading: false })
      return
    }
    if (!fromPull) this.setData({ loading: this.data.all.length === 0 })
    try {
      const list = await call('appointment.mine', {}, { retry: 0 })
      const all = list.map((a) => ({
        ...a,
        dateText: F.monthDay(a.date),
        weekText: F.weekday(a.date),
        canCancel: a.canCancel !== undefined ? a.canCancel : a.status === 'PENDING',
        canReschedule: a.canReschedule !== undefined ? a.canReschedule : a.status === 'PENDING'
      }))
      this.setData({ all, loading: false, bound: true, error: false })
      this.applyFilter(this.data.filter)
    } catch (e) {
      this.setData({ loading: false, error: true })
      toast(e)
    }
  },

  switchFilter(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.filter) return
    this.setData({ filter: key })
    this.applyFilter(key)
  },

  applyFilter(key) {
    const { all } = this.data
    const items = key === 'all' ? all : all.filter((a) => (GROUPS[key] || []).includes(a.status))
    this.setData({ items })
  },

  cancel(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '取消预约',
      content: '取消后该时段会释放给其他演示账户，确定取消吗？',
      confirmText: '确定取消',
      confirmColor: '#BF4331',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await call('appointment.cancelSelf', { appointmentId: id, reason: '演示账户取消' }, { loading: true })
          wx.showToast({ title: '已取消' })
          this.load()
        } catch (err) {
          toast(err)
        }
      }
    })
  },

  reschedule(e) {
    const item = this.data.all.find((a) => a._id === e.currentTarget.dataset.id)
    if (!item) return
    wx.setStorageSync('adc_reschedule_target', item)
    wx.navigateTo({ url: '/pages/reschedule/index' })
  },

  openClinic(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/clinic/index?id=${id}` })
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' })
  }
})
