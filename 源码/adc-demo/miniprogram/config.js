/**
 * 小程序运行配置
 *
 * envId 是唯一需要改的地方：
 *   - 留空  → 走本地演示数据（utils/mock.js），开发者工具里直接就能点，不依赖云环境
 *   - 填写  → 走云开发真实接口（cloudfunctions/api）
 *
 * 发布前必须填写 envId，并在云开发控制台把 api / initData 两个云函数部署好。
 */
module.exports = {
  envId: 'patient-damselfly-d3di6275acf229',

  appName: 'ADC 数据建模演示',
  brandShort: 'ADC',
  version: '1.2.0',

  // 案例虚构号码：页面已声明「请勿拨打」，点击仅弹提示，不发起真实拨号
  servicePhone: '020-8888-0001',
  serviceHours: '09:00 - 18:00',

  // 隐私政策版本，用户同意后写入本地，版本变更会重新征询
  policyVersion: '2026-11-25',

  // 订阅消息模板 ID（公众平台 → 订阅消息 → 我的模板）
  // 留空则跳过订阅授权，不影响下单
  subscribeReminderTmpl: '',

  // 单次预约最多可提前多少天
  bookingDays: 14,

  // 一条预约允许的最晚到店时间（分钟），超时转"待核实"
  lateGraceMin: 30
}
