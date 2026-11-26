const { call, toast } = require('../../utils/api')
const auth = require('../../utils/auth')
const F = require('../../utils/format')

Page({
  data: {
    loading: true,
    bound: false,
    patient: null,
    allergies: [],
    visits: []
  },

  onShow() {
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
    if (!fromPull) this.setData({ loading: this.data.visits.length === 0 })
    try {
      const d = await call('visit.mine', {}, { retry: 0 })
      const visits = (d.visits || []).map((v) => {
        const total = (v.lines || []).reduce((s, l) => s + Number(l.subtotal || 0), 0)
        return {
          ...v,
          dateText: F.ymd(new Date(v.created_at || Date.now())),
          lines: (v.lines || []).map((l) => ({ ...l, subtotalText: F.money(l.subtotal) })),
          totalText: F.money(total),
          stateText: v.invoice ? '已结算' : '处理中',
          stateTone: v.invoice ? 'green' : 'blue'
        }
      })
      this.setData({
        loading: false,
        bound: true,
        patient: d.patient,
        allergies: (d.patient && d.patient.allergies) || [],
        visits
      })
    } catch (e) {
      this.setData({ loading: false })
      toast(e)
    }
  },

  openInvoice(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/invoice/index?id=${id}` })
  },

  addAllergy() {
    wx.showModal({
      title: '登记备注标签',
      editable: true,
      placeholderText: '请输入标签内容',
      success: async (r) => {
        if (!r.confirm) return
        const name = (r.content || '').trim()
        if (!name) return
        try {
          const p = await call('patient.allergy.add', { name }, { loading: true })
          await auth.refresh()
          this.setData({ allergies: p.allergies || [] })
          wx.showToast({ title: '已登记，待核实' })
        } catch (e) {
          toast(e)
        }
      }
    })
  },

  removeAllergy(e) {
    const name = e.currentTarget.dataset.name
    const item = this.data.allergies.find((a) => a.name === name)
    if (item && item.confirmed) {
      return toast(new Error('已核实的记录不能自行删除'))
    }
    wx.showModal({
      title: '删除备注标签',
      content: `确认删除「${name}」？`,
      success: async (r) => {
        if (!r.confirm) return
        try {
          const p = await call('patient.allergy.remove', { name }, { loading: true })
          await auth.refresh()
          this.setData({ allergies: p.allergies || [] })
        } catch (e) {
          toast(e)
        }
      }
    })
  },

  goBooking() {
    wx.switchTab({ url: '/pages/booking/index' })
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' })
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/index' })
  }
})
