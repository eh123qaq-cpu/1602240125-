/** 切换 tab 页时同步自定义 tabBar 的高亮，页面 onShow 里调一次 */
module.exports = function syncTab(page, index) {
  if (!page || typeof page.getTabBar !== 'function') return

  const apply = () => {
    const bar = page.getTabBar()
    if (bar && bar.setData) bar.setData({ selected: index })
  }

  apply()
  // 首次进入时 tabBar 实例可能还没挂载，补一次
  setTimeout(apply, 60)
}
