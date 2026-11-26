Component({
  properties: {
    rows: { type: Number, value: 3 },
    // card：卡片骨架（默认）；line：纯文本行骨架
    type: { type: String, value: 'card' }
  },

  data: {
    list: []
  },

  lifetimes: {
    attached() {
      const rows = this.properties.rows || 3
      this.setData({ list: Array.from({ length: rows }).map((_, i) => i) })
    }
  }
})
