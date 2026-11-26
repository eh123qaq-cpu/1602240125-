const { statusOf } = require('../../utils/format')

Component({
  properties: {
    status: { type: String, value: '' },
    // 允许外部直接传文案（比如演示记录的"已结算/处理中"）
    label: { type: String, value: '' },
    tone: { type: String, value: '' }
  },

  data: {
    text: '',
    color: 'gray'
  },

  lifetimes: {
    attached() {
      this.refresh()
    }
  },

  observers: {
    'status, label, tone'() {
      this.refresh()
    }
  },

  methods: {
    // attached 与 observer 都走这里，保证首次渲染也有内容
    refresh() {
      const { status, label, tone } = this.properties
      const meta = statusOf(status)
      this.setData({
        text: label || meta.text,
        color: tone || meta.tone
      })
    }
  }
})
