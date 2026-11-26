const { call, toast } = require('../../utils/api')
const F = require('../../utils/format')
const config = require('../../config')

Page({
  data: {
    target: null,
    dates: [],
    activeDate: '',
    groups: [],
    dentistIndex: 0,
    activeDentistId: '',
    slots: [],
    selected: null,
    loading: true,
    submitting: false
  },

  onLoad() {
    const target = wx.getStorageSync('adc_reschedule_target')
    if (!target || !target._id) {
      wx.showModal({
        title: '无法改约',
        content: '请从「我的预约」中进入改约',
        showCancel: false,
        success: () => wx.navigateBack()
      })
      return
    }
    const today = F.ymd(new Date())
    this.setData({
      target: {
        ...target,
        dateText: F.monthDay(target.date),
        weekText: F.weekday(target.date)
      },
      dates: F.dateStrip(config.bookingDays),
      activeDate: today
    })
    this.loadSlots()
  },

  onDate(e) {
    const date = e.currentTarget.dataset.date
    if (date === this.data.activeDate) return
    this.setData({ activeDate: date, selected: null, groups: [] })
    this.loadSlots()
  },

  onDentist(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i === this.data.dentistIndex) return
    const g = this.data.groups[i]
    this.setData({ dentistIndex: i, activeDentistId: g ? g.dentist_id : '', slots: g ? g.slots : [], selected: null })
  },

  async loadSlots() {
    const t = this.data.target
    this.setData({ loading: true })
    try {
      const raw = await call('appointment.availableSlots', { clinicId: t.clinic_id, date: this.data.activeDate })
      const groups = raw.map((g) => ({ ...g, initial: String(g.dentist_name || '医').slice(0, 1), free: g.slots.length }))
      // 优先定位到原牙医
      let idx = groups.findIndex((g) => g.dentist_id === t.dentist_id && g.slots.length)
      if (idx < 0) idx = groups.findIndex((g) => g.slots.length)
      if (idx < 0) idx = 0
      const g = groups[idx]
      this.setData({
        groups,
        loading: false,
        dentistIndex: idx,
        activeDentistId: g ? g.dentist_id : '',
        slots: g ? g.slots : []
      })
    } catch (e) {
      this.setData({ loading: false })
      toast(e)
    }
  },

  pickSlot(e) {
    const start = e.currentTarget.dataset.start
    const g = this.data.groups[this.data.dentistIndex]
    if (!g) return
    this.setData({ selected: { start, dentistId: g.dentist_id, dentistName: g.dentist_name } })
  },

  submit() {
    const { selected, target, activeDate, submitting } = this.data
    if (submitting) return
    if (!selected) return toast(new Error('请选择新的演示时段'))
    const oldText = `${target.dateText} ${target.weekText} ${target.start}`
    const newText = `${F.monthDay(activeDate)} ${F.weekday(activeDate)} ${selected.start}`
    wx.showModal({
      title: '确认改约',
      content: `原预约：${oldText}\n新预约：${newText}\n${selected.dentistName} 医生\n\n原记录会保留并标记为「已改约」`,
      confirmText: '确认改约',
      cancelText: '返回修改',
      success: (r) => {
        if (r.confirm) this.doSubmit()
      }
    })
  },

  async doSubmit() {
    const { selected, target, activeDate, submitting } = this.data
    if (submitting) return
    if (!selected) return toast(new Error('请选择新的演示时段'))

    this.setData({ submitting: true })
    try {
      await call(
        'appointment.rescheduleSelf',
        {
          appointmentId: target._id,
          date: activeDate,
          start: selected.start,
          dentistId: selected.dentistId
        },
        { loading: true }
      )
      wx.removeStorageSync('adc_reschedule_target')
      this.setData({ submitting: false })
      wx.showModal({
        title: '改约成功',
        content: `${F.monthDay(activeDate)} ${selected.start}\n${selected.dentistName} 医生`,
        showCancel: false,
        confirmText: '查看预约',
        success: () => wx.switchTab({ url: '/pages/appointments/index' })
      })
    } catch (e) {
      this.setData({ submitting: false })
      if (e.code === 409) this.loadSlots()
      toast(e)
    }
  },

  cancel() {
    wx.navigateBack()
  }
})
