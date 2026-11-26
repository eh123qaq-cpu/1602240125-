/**
 * 小程序静态校验（不依赖微信开发者工具）
 *
 * 运行：node tests/mp-lint.js
 *
 * 覆盖开发者工具编译时最容易踩的几类问题：
 *   1. app.json 里的页面是否四个文件齐全
 *   2. 所有 .json 是否能解析、组件路径是否存在
 *   3. .js 语法是否合法（node --check）
 *   4. .wxml 标签是否闭合、{{ }} 是否配对
 *   5. 绑定的事件处理函数在页面 JS 里是否真的存在
 *   6. 页面间跳转的目标路径是否已注册
 *   7. wx:for 是否写了 wx:key
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', 'miniprogram')
const errors = []
const warns = []

const rel = (p) => path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/')

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const all = walk(ROOT)
const byExt = (ext) => all.filter((f) => f.endsWith(ext))

/* --------------------------- 1. app.json --------------------------- */

let app = null
try {
  app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
} catch (e) {
  errors.push(`app.json 解析失败：${e.message}`)
}

const pages = (app && app.pages) || []
const pageSet = new Set(pages)

pages.forEach((p) => {
  ;['js', 'json', 'wxml'].forEach((ext) => {
    const f = path.join(ROOT, `${p}.${ext}`)
    if (!fs.existsSync(f)) errors.push(`缺少文件：${rel(f)}（app.json 声明了 ${p}）`)
  })
  const wxss = path.join(ROOT, `${p}.wxss`)
  if (!fs.existsSync(wxss)) warns.push(`没有 wxss（可接受，但通常是漏了）：${rel(wxss)}`)
})

/* --------------------------- 2. JSON 与组件 --------------------------- */

byExt('.json').forEach((f) => {
  let j
  try {
    j = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    errors.push(`${rel(f)} JSON 解析失败：${e.message}`)
    return
  }
  const comps = Object.assign({}, (app && app.usingComponents) || {}, j.usingComponents || {})
  Object.entries(comps).forEach(([key, p]) => {
    const base = p.startsWith('/') ? path.join(ROOT, p.slice(1)) : path.resolve(path.dirname(f), p)
    if (!fs.existsSync(`${base}.wxml`)) errors.push(`${rel(f)} 引用的组件 ${key} 不存在：${p}`)
  })
})

/* --------------------------- 3. JS 语法 --------------------------- */

byExt('.js').forEach((f) => {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    const msg = String(e.stderr || e.message)
      .split('\n')
      .slice(0, 4)
      .join(' ')
    errors.push(`${rel(f)} 语法错误：${msg}`)
  }
})

/* --------------------------- 4/5/6/7. WXML --------------------------- */

const VOID = new Set(['image', 'input', 'import', 'include', 'wxs', 'icon', 'progress', 'switch', 'slider', 'checkbox', 'radio'])

const handlerList = (src) => {
  const out = []
  const re = /\b(?:bind|catch|mut-bind|capture-bind|capture-catch)[:]?[a-zA-Z]+\s*=\s*"([^"]*)"/g
  let m
  while ((m = re.exec(src))) out.push(m[1].trim())
  return out.filter((v) => v && !v.includes('{{'))
}

const jsHandlers = (jsSrc) => {
  const set = new Set()
  const re = /(?:^|[\s,{])(?:async\s+)?([a-zA-Z_$][\w$]*)\s*(?:\(|:\s*(?:async\s*)?function)/g
  let m
  while ((m = re.exec(jsSrc))) set.add(m[1])
  // 对象字面量里的简写方法：foo() {} / async foo() {}
  const re2 = /(?:^|[\n{,])\s*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/g
  while ((m = re2.exec(jsSrc))) set.add(m[1])
  return set
}

byExt('.wxml').forEach((f) => {
  const src = fs.readFileSync(f, 'utf8')
  const pageJs = f.replace(/\.wxml$/, '.js')

  // 4a. 标签闭合（先把 {{ }} 内容抹掉，避免表达式里的 > < 干扰）
  const masked = src.replace(/\{\{[\s\S]*?\}\}/g, '__EXP__')
  const stack = []
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  let t
  while ((t = tagRe.exec(masked))) {
    const closing = t[1] === '/'
    const name = t[2]
    const selfClose = t[4] === '/'
    if (closing) {
      const top = stack.pop()
      if (top !== name) {
        errors.push(`${rel(f)} 标签不匹配：</${name}> 对上的是 <${top || '空'}>`)
        return
      }
    } else if (!selfClose && !VOID.has(name)) {
      stack.push(name)
    }
  }
  if (stack.length) errors.push(`${rel(f)} 存在未闭合标签：${stack.join(' > ')}`)

  // 4b. {{ }} 配对
  const open = (src.match(/\{\{/g) || []).length
  const close = (src.match(/\}\}/g) || []).length
  if (open !== close) errors.push(`${rel(f)} {{ }} 不配对：${open} 个 {{，${close} 个 }}`)

  // 5. 事件处理函数是否存在
  if (fs.existsSync(pageJs)) {
    const js = fs.readFileSync(pageJs, 'utf8')
    const have = jsHandlers(js)
    handlerList(src).forEach((h) => {
      if (!have.has(h)) errors.push(`${rel(f)} 绑定了不存在的方法：${h}（${rel(pageJs)} 里没有）`)
    })
  }

  // 7. wx:for 缺 wx:key
  const forRe = /<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)>/g
  while ((t = forRe.exec(masked))) {
    const attrs = t[2] || ''
    if (/\swx:for=/.test(attrs) && !/\swx:key=/.test(attrs)) {
      warns.push(`${rel(f)} <${t[1]}> 有 wx:for 但没有 wx:key`)
    }
  }
})

/* --------------------------- 6. 跳转目标 --------------------------- */

byExt('.js').forEach((f) => {
  const src = fs.readFileSync(f, 'utf8')
  const re = /url:\s*[`'"]([^`'"]+)[`'"]/g
  let m
  while ((m = re.exec(src))) {
    const url = m[1].replace(/\$\{[^}]*\}/g, 'X')
    if (!url.startsWith('/pages/')) continue
    const target = url.slice(1).split('?')[0]
    if (!pageSet.has(target)) errors.push(`${rel(f)} 跳转到未注册的页面：${url}`)
  }
})

/* --------------------------- 输出 --------------------------- */

warns.forEach((w) => console.log(`WARN  ${w}`))
errors.forEach((e) => console.log(`FAIL  ${e}`))

const pageCount = pages.length
const wxmlCount = byExt('.wxml').length
console.log('')
console.log(`页面 ${pageCount} 个 · wxml ${wxmlCount} 个 · js ${byExt('.js').length} 个 · json ${byExt('.json').length} 个`)
console.log(errors.length ? `❌ ${errors.length} 个错误，${warns.length} 个警告` : `✅ 全部通过（${warns.length} 个警告）`)
process.exit(errors.length ? 1 : 0)
