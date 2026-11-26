const { call, toast } = require('../../utils/api')
const auth = require('../../utils/auth')
const F = require('../../utils/format')
const config = require('../../config')

Page({
  data: {
    loading: true,
    error: false,
    inv: null,
    clinic: null
  },

  onLoad(q) {
    this.invoiceId = q.id || q.invoiceId
    this.load()
  },

  async load() {
    if (!this.invoiceId) {
      this.setData({ loading: false, error: true })
      return
    }
    if (!(await auth.guard())) {
      this.setData({ loading: false })
      return
    }
    try {
      const inv = await call('invoice.mine', { invoiceId: this.invoiceId }, { retry: 0 })
      const lines = (inv.lines || []).map((l) => ({
        ...l,
        priceText: F.money(l.unit_price),
        subtotalText: F.money(l.subtotal)
      }))
      this.setData({
        loading: false,
        inv: { ...inv, lines, totalText: F.money(inv.total) }
      })
      wx.setNavigationBarTitle({ title: `结算单 ${inv.invoice_no}` })
    } catch (e) {
      this.setData({ loading: false, error: true })
      toast(e)
    }
  },

  callClinic() {
    wx.showToast({ title: '虚构演示号码，请勿拨打', icon: 'none' })
  },

  onShareAppMessage() {
    return {
      title: `结算单 ${this.data.inv ? this.data.inv.invoice_no : ''}`,
      path: '/pages/home/index'
    }
  }
})
