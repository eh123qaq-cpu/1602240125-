# 安德鲁牙科（ADC）· 患者小程序 + 员工工作台

Ivey 案例 W44694《Andrew's Dental Chain》与《ADC 拟开发项目与业务需求说明》的课程作业。按需求里建好的模型做了一个能跑起来的系统：患者端是微信小程序，员工端是网页工作台，两端调用同一个云函数 `api`、读写同一套集合，所以一边写入，另一边刷新就能看到。

## 现在是什么状态

- 小程序 **v1.2.0 已发布**，扫码即可打开，不需要注册。
- 网页只有一个入口，直接连云端，没有本地演示数据。打开后点一个身份就进，和小程序看的是同一份数据。

## 两端做什么

**患者小程序（12 个页面）**

首页看下次就诊和门店，预约页按门店、日期、牙医、时段下单，我的预约按状态筛选并自助改约或取消，就诊记录看每次的治疗明细，结算单看金额与单价快照。另有门店、牙医、档案、隐私须知、关于几个页面。

登录不再填姓名和手机号。打开后从四份虚构档案里选一个（林小雅 / 张家明 / 陈慧 / 黄志远），云端只把这个微信号和虚构档案关联，不接收个人信息。这是 v1.2.0 的调整，下面「小程序 v1.2.0」一节有细节。

**员工网页（5 个角色，13 个视图）**

前台、牙医、财务、运营、总部经理，菜单按角色生成：今日看板、预约管理、患者档案、诊间治疗、结算开单、成本与费用、季度报表、门店与牙医、诊疗项目、出诊排班、操作记录、核算审批、员工账号。预约、到诊、诊间录入、开单、结算、排班、季度核算这些流程都能走通。

## 目录

```
adc-demo/
├─ project.config.json              AppID wx583ee405799889c2
├─ miniprogram/                     小程序：12 个页面 + 自定义 tabBar
│  ├─ config.js                     envId、版本号、预约窗口
│  ├─ utils/api.js                  请求层：超时、重试、错误归一
│  ├─ utils/auth.js                 登录态与页面守卫（选身份进入）
│  └─ pages/                        home booking appointments profile
│                                   records invoice reschedule clinic
│                                   dentist login consent about
├─ cloudfunctions/
│  ├─ api/                          唯一业务入口，59 个 action，含角色 ACL
│  ├─ initData/                     重置并灌入演示数据
│  ├─ seedStaff/                    初始化员工账号（需 __seedKey）
│  └─ seedSchedules/                生成 30 天牙医排班（幂等）
├─ web/                             员工工作台
│  ├─ index.html                    单文件成品：CSS / SDK / JS 全内联
│  ├─ style.css  app.js             源文件，改完运行 node web/build.js
│  ├─ vendor/cloudbase.full.js      CloudBase Web SDK 3.5.0
│  └─ build.js  serve.js            打包脚本 / 本地预览服务
├─ docs/                            需求符合性检查
└─ tests/                           见下方「测试」
```

## 员工端网页

线上地址：https://patient-damselfly-d3di6275acf229-1540280749.tcloudbaseapp.com/

打开就是 8 个身份按钮，点谁就用谁的员工账号进云端，不需要输密码：

| 身份 | 账号 |
|---|---|
| 前台 · 天河店 | `desk` 周晓雯 |
| 前台 · 越秀店 | `desk2` 何嘉 |
| 牙医 · 天河店 | `dentist` 陈安 |
| 牙医 · 天河店 | `dentist2` 李敏 |
| 牙医 · 越秀店 | `dentist3` 王强 |
| 财务 | `finance` 许静 |
| 运营 | `ops` 梁俊 |
| 总部经理 | `manager` 黄立群 |

员工密码由 `seedStaff` 初始化，云函数里用 scrypt 存哈希、比对也在云函数里做，仓库文档不写明文。网页里另有一个界面上看不到的通道账号，只负责建立「浏览器 → 云函数」的调用通道；它不是员工账号，没有任何角色，读不到业务数据。

**网页只有云端一种数据源。** 页面里没有内存假数据，也没有 `?cloud=1` 之类的开关，读到的每一条都是云端记录。顶栏显示「云端已连接」；断网时会变成「云端断开 · 重连」，点一下重新签票并刷新当前页。读取偶发失败会自动重试一次，写操作失败会明确说「本次没有改到任何数据」，不会假装保存成功。

本地看页面：

```bash
cd adc-demo
node web/serve.js       # http://127.0.0.1:8765
```

改过 `web/app.js` 或 `web/style.css` 后运行 `node web/build.js` 重新生成单文件。`index.html` 把 CSS、SDK 和业务脚本都内联了，双击也能打开，不依赖 CDN。

## 云端与数据

- 云环境 `patient-damselfly-d3di6275acf229`（CloudBase，PostgreSQL 版，文档 API 由 pgdoc 承载）
- 云函数 `api` / `initData` / `seedStaff` / `seedSchedules`，超时统一 60 秒
- 集合 16 个：11 个业务集合（`clinics`、`qualifications`、`dentists`、`patients`、`appointments`、`visits`、`treatments`、`visit_treatments`、`invoices`、`costs`、`wechat_users`），加上 `staff`、`staff_sessions`、`schedules`、`audit_logs`、`quarter_closes`
- 唯一索引：`appointments.slot_key`、`visits.visit_no`、`invoices.invoice_no`、`wechat_users.openid`

患者端的身份是微信 OpenID：云函数用 `getWXContext().OPENID` 反查 `wechat_users`，再落到 `patients`，前端伪造不了。员工端是账号密码换 token，存 `staff_sessions`，角色判断全在云函数入口；网页只负责展示，写按钮按角色隐藏只是第二道保险。

部署命令：

```bash
# 云函数：在项目根目录（本 README 所在目录）执行，tcb 是 CloudBase CLI
tcb fn deploy api       --dir cloudfunctions/api       -e <envId>
tcb fn deploy initData  --dir cloudfunctions/initData  -e <envId>
tcb fn deploy seedStaff --dir cloudfunctions/seedStaff -e <envId>
tcb fn deploy seedSchedules --dir cloudfunctions/seedSchedules -e <envId>

# 网页：部署到静态托管
tcb hosting deploy web -e <envId>
# seedStaff 调用时要带部署者本地保存的 __seedKey，只写 staff / staff_sessions
```

## 小程序 v1.2.0

2026-11-25 晚的调整，目的有两个：上架时不用声明采集手机号，登录也不再需要建档。

- 登录页列出四份虚构档案，点一下进入，可随时切换；
- 新增 `patient.demoList` / `patient.demoLogin`，只做 OpenID 与虚构档案的映射；
- 删掉两处 `wx.setClipboardData`（结算单号、关于页版本号），改成文字长按选择，避免声明剪贴板用途；
- 隐私说明改成「我们不收集你的个人信息」，`policyVersion` 升到 `2026-11-25`；
- 员工端的 `patient.bind` 保留，网页仍按手机号查档，这是 UC05 的要求。

## 测试

不需要联网，也不需要云环境：

```bash
node tests/mp-lint.js           # 小程序静态校验：页面、JSON、WXML、事件绑定
node tests/mp-confirm.js        # 改约 / 取消的确认门槛（27）
node tests/mp-flow.js           # 小程序数据层全流程（42）
node tests/smoke.js             # 云函数业务规则（28）
node tests/enhance.js           # 增强模块：排班、留痕、核算审批、员工账号（38）
node tests/web-dom.js           # 网页静态结构：视图容器、构建是否最新（33）
node tests/web-flow.js          # 网页 13 个视图渲染 + 菜单权限（33）
node tests/web-boot.js          # 启动、身份入口、残留登录态（8）
node tests/web-login.js         # 身份登录、云端不可用、业务错误码（18）
node tests/web-cloud-recover.js # 断网报错、自动重试、手动重连（27）
node tests/web-selftest.js      # 单文件完整性：CSS/SDK/JS 内联一致（19）
```

当前全绿：`mp-lint` 0 警告，其余 273 条断言通过。

## 几个踩过的坑

1. **新环境没有文档数据库**：`wx.cloud.database()` 直接报 `-501001 resource not found`，换套餐没用，要开 pgdoc 插件。
2. **云函数默认 3 秒超时**：`initData` 顺序写几十条记录会被掐断，调到 60 秒。
3. **唯一索引锁死已取消的时段**：取消或改约必须把 `slot_key` 写成释放态（`原值#released:<id>`），否则那个时段永远约不上。
4. **云函数运行在 UTC**：直接用 `new Date()` 取「今天」，北京时间 0–8 点会差一天；现在统一按 UTC+8 算业务日期。
5. **网页登录态过期**：每次进页面重新签票，不做 `hasLoginState()` 短路；掉线后下一次操作自动重连。

## 说明

- 门店、牙医、患者、价格、结算单全部是虚构的，金额规则能跑通，但没有经过真实业务量检验。
- 原需求里患者通过电话和柜台办理，没有自助端。小程序这部分是对需求的延伸，主体业务仍在员工端；医保、税务发票、支付、工资发放按文档留作后续范围。
