const { call, toast } = require('../../utils/api')
const auth = require('../../utils/auth')
const syncTab = require('../../utils/tab')
const F = require('../../utils/format')
const config = require('../../config')

Page({
  data: {
    ready: false,
    patient: null,
    clinics: [],
    clinicIndex: 0,
    dates: [],
    activeDate: '',
    dateLabel: '',
    groups: [],
    dentistIndex: 0,
    activeDentistId: '',
    morning: [],
    afternoon: [],
    selected: null,
    treatments: [],
    needIndex: -1,
    needText: '',
    special: '',
    loadingSlots: false,
    submitting: false,
    slotTotal: 0,
    confirming: false,
    confirmInfo: null,
    versionText: ''
  },

  onLoad() {
    const today = F.ymd(new Date())
    this.setData({
      dates: F.dateStrip(config.bookingDays),
      activeDate: today,
      dateLabel: '今天',
      versionText: 'v' + config.version
    })
  },

  onShow() {
    syncTab(this, 1)
    this.bootstrap()
  },

  onPullDownRefresh() {
    this.bootstrap(true).then(() => wx.stopPullDownRefresh())
  },

  async bootstrap(force) {
    if (!(await auth.guard())) return
    try {
      const s = await auth.getSession()
      this.setData({
        patient: {
          ...s.patient,
          phoneMasked: F.maskPhone(s.patient.phone),
          initial: String(s.patient.name || '患').slice(0, 1)
        },
        ready: true
      })

      if (!this.data.clinics.length) {
        const [clinics, meta] = await Promise.all([call('clinic.list'), call('meta.bootstrap')])
        const cached = wx.getStorageSync('adc_booking_need')
        const treatments = (meta.treatments || []).map((t) => ({ _id: t._id, name: t.name, price: t.unit_price }))
        const idx = cached ? treatments.findIndex((t) => t.name === cached) : -1
        this.setData({
          clinics,
          treatments,
          needIndex: idx,
          needText: idx >= 0 ? treatments[idx].name : ''
        })
        if (cached) wx.removeStorageSync('adc_booking_need')
      }

      if (force || !this.data.groups.length) await this.loadSlots({ jump: true })
    } catch (e) {
      this.setData({ ready: true })
      toast(e)
    }
  },

  onClinic(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i === this.data.clinicIndex) return
    this.setData({ clinicIndex: i, selected: null, dentistIndex: 0, groups: [] })
    this.loadSlots()
  },

  onDate(e) {
    const date = e.currentTarget.dataset.date
    if (date === this.data.activeDate) return
    const today = F.ymd(new Date())
    this.setData({
      activeDate: date,
      dateLabel: F.dayLabel(date, today),
      selected: null,
      groups: []
    })
    this.loadSlots()
  },

  onDentist(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i === this.data.dentistIndex) return
    this.setData({ dentistIndex: i, selected: null })
    this.buildGrid(i)
  },

  async loadSlots(opts) {
    const clinic = this.data.clinics[this.data.clinicIndex]
    if (!clinic) return
    this.setData({ loadingSlots: true })
    try {
      const raw = await call('appointment.availableSlots', {
        clinicId: clinic._id,
        date: this.data.activeDate
      })
      const groups = raw.map((g) => ({
        ...g,
        initial: String(g.dentist_name || '医').slice(0, 1),
        free: g.slots.length
      }))
      const total = groups.reduce((s, g) => s + g.slots.length, 0)

      // 今天门诊时间已过 / 今天已约满：首次进入自动跳到下一个有号的日子，
      // 否则页面停在「共 0 个空位」会被误认为预约功能坏了。
      const today = F.ymd(new Date())
      if (opts && opts.jump && total === 0 && this.data.activeDate === today && this.data.dates.length > 1) {
        const next = this.data.dates[1].date
        this.setData({ activeDate: next, dateLabel: F.dayLabel(next, today), selected: null })
        return this.loadSlots()
      }

      // 默认停到当天第一个还有号的牙医
      let idx = groups.findIndex((g) => g.slots.length > 0)
      if (idx < 0) idx = 0
      this.setData({ groups, loadingSlots: false, slotTotal: total, dentistIndex: idx })
      this.buildGrid(idx)
    } catch (e) {
      this.setData({ loadingSlots: false })
      toast(e)
    }
  },

  buildGrid(idx) {
    const g = this.data.groups[idx]
    if (!g) {
      this.setData({ morning: [], afternoon: [], slotTotal: 0, activeDentistId: '' })
      return
    }
    const morning = g.slots.filter((s) => s.start < '12:00')
    const afternoon = g.slots.filter((s) => s.start >= '12:00')
    this.setData({ morning, afternoon, activeDentistId: g.dentist_id })
  },

  pickSlot(e) {
    const { start, period } = e.currentTarget.dataset
    const g = this.data.groups[this.data.dentistIndex]
    if (!g) return
    this.setData({
      selected: {
        start,
        period,
        dentistId: g.dentist_id,
        dentistName: g.dentist_name,
        title: g.title || '',
        qualNames: g.qual_names || []
      }
    })
  },

  onNeed(e) {
    const i = Number(e.detail.value)
    this.setData({
      needIndex: i,
      needText: this.data.treatments[i] ? this.data.treatments[i].name : ''
    })
  },

  onSpecial(e) {
    this.setData({ special: e.detail.value })
  },

  submit() {
    const { selected, clinics, clinicIndex, activeDate, needText, special, patient, submitting } = this.data
    if (submitting) return
    if (!selected) return toast(new Error('请先选择演示时段'))
    const clinic = clinics[clinicIndex] || {}
    this.setData({
      confirming: true,
      confirmInfo: {
        clinicName: clinic.short_name || clinic.name || '',
        dateText: `${F.monthDay(activeDate)} ${F.weekday(activeDate)}`,
        timeText: `${selected.period ? selected.period + ' ' : ''}${selected.start}`,
        dentistText: `${selected.dentistName} 医生${selected.title ? ' · ' + selected.title : ''}`,
        needText: needText || '未填写',
        specialText: special || '无',
        patientText: patient ? `${patient.name}（${patient.phoneMasked}）` : ''
      }
    })
  },

  closeConfirm() {
    if (this.data.submitting) return
    this.setData({ confirming: false })
  },

  async confirmSubmit() {
    if (this.data.submitting) return
    this.setData({ confirming: false })
    await this.doSubmit()
  },

  noop() {},

  async doSubmit() {
    const { selected, clinics, clinicIndex, activeDate, needText, special, submitting } = this.data
    if (submitting) return
    if (!selected) return toast(new Error('请先选择演示时段'))

    this.setData({ submitting: true, confirming: false })
    try {
      await call(
        'appointment.create',
        {
          clinicId: clinics[clinicIndex]._id,
          dentistId: selected.dentistId,
          date: activeDate,
          start: selected.start,
          need: needText,
          special_need: special,
          source: 'MINI'
        },
        { loading: true }
      )

      // 订阅消息授权（模板未配置时自动跳过）
      const tmpl = config.subscribeReminderTmpl
      if (tmpl) {
        wx.requestSubscribeMessage({ tmplIds: [tmpl], complete: () => {} })
      }

      this.setData({ submitting: false, selected: null, groups: [], confirming: false })
      wx.showModal({
        title: '预约成功',
        content: `${F.monthDay(activeDate)} ${selected.start}\n${selected.dentistName} 医生 · ${
          clinics[clinicIndex].short_name || clinics[clinicIndex].name
        }`,
        confirmText: '查看预约',
        showCancel: false,
        success: () => wx.switchTab({ url: '/pages/appointments/index' })
      })
    } catch (e) {
      this.setData({ submitting: false, confirming: false })
      // 时段被抢占：刷新时段让用户重选
      if (e.code === 409) this.loadSlots()
      toast(e)
    }
  },

  callClinic() {
    wx.showToast({ title: '虚构演示号码，请勿拨打', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: '演示预约 · ADC 课程演示', path: '/pages/booking/index' }
  }
})
