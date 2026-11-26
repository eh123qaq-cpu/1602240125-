Component({
  properties: {
    text: { type: String, value: '暂无数据' },
    sub: { type: String, value: '' },
    action: { type: String, value: '' },
    icon: { type: String, value: 'box' }
  },
  methods: {
    onAction() {
      this.triggerEvent('action')
    }
  }
})
