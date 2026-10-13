--[[
  includes/callouts.lua —— 让 `:::` 容器在 LaTeX 路线上也有排版效果。

  为什么需要这个文件：

  HTML 路线（浏览器预览、PNG、HTML 导出）走的是本项目的 markdown-it 插件，
  `::: 定理 勾股定理 … :::` 会被渲染成带图标与标题样式的卡片。

  但 LaTeX 路线是 pandoc 直接读 Markdown 的，而 **pandoc 的 fenced div 简写只接受
  单独的类名**——`::: note` 能认，`::: note 标题` 会退化成普通段落，三个冒号原样
  印进 PDF。于是同一份文档在网页里是卡片、在 PDF 里是一串冒号。

  这个过滤器做两件事：
    1. 把 pandoc 认出来的 `Div.note / .tip / .theorem …`（即 `::: note` 形式）转成
       LaTeX 环境；
    2. 把 pandoc **没**认出来的 `Para[Str ":::", …]` 序列按本项目的语法重新组装成
       容器（这样 `::: 定理 勾股定理` 这种带标题的写法也能生效）。

  只对 LaTeX 输出改写；其它格式原样放行，以免影响 HTML 产出。
--]]

-- 容器种类 → 中文标签。与 shared/markdown.mjs 的 CALLOUT_META 保持一致。
local LABEL = {
  note = '注', info = '信息', tip = '提示', important = '重要',
  warning = '注意', warn = '注意', danger = '危险', error = '危险',
  success = '结论', quote = '引用',
  theorem = '定理', lemma = '引理', proposition = '命题', corollary = '推论',
  definition = '定义', axiom = '公理', proof = '证明', remark = '评注',
  example = '例', exercise = '练习', algorithm = '算法', solution = '解',
}

-- 中文别名 → 规范类名
local ALIAS = {
  ['注'] = 'note', ['注记'] = 'note', ['备注'] = 'note', ['说明'] = 'note',
  ['信息'] = 'info',
  ['提示'] = 'tip', ['技巧'] = 'tip',
  ['重要'] = 'important',
  ['警告'] = 'warning', ['注意'] = 'warning',
  ['危险'] = 'danger', ['错误'] = 'danger',
  ['成功'] = 'success', ['结论'] = 'success',
  ['引用'] = 'quote',
  ['定理'] = 'theorem', ['引理'] = 'lemma', ['命题'] = 'proposition',
  ['推论'] = 'corollary', ['定义'] = 'definition', ['公理'] = 'axiom',
  ['证明'] = 'proof', ['证'] = 'proof', ['评注'] = 'remark',
  ['例'] = 'example', ['例子'] = 'example', ['例题'] = 'example',
  ['练习'] = 'exercise', ['习题'] = 'exercise',
  ['算法'] = 'algorithm', ['解'] = 'solution', ['解答'] = 'solution',
}

local function canon(name)
  if not name then return nil end
  return LABEL[name] and name or ALIAS[name]
end

-- 把一行内联内容里开头的 "kind [标题…]" 拆出来
local function split_header(inlines)
  -- inlines[1] 是 ":::"，其后是 Space 与若干内联
  local i = 2
  while i <= #inlines and (inlines[i].t == 'Space' or inlines[i].t == 'SoftBreak') do i = i + 1 end
  if i > #inlines then return nil end
  local head = inlines[i]
  if head.t ~= 'Str' then return nil end
  local kind = canon(head.text)
  if not kind then return nil end
  i = i + 1
  while i <= #inlines and (inlines[i].t == 'Space' or inlines[i].t == 'SoftBreak') do i = i + 1 end
  local title = {}
  for j = i, #inlines do title[#title + 1] = inlines[j] end
  return kind, title
end

-- 这一段是不是"容器结束行"（整段只有一个 :::）
local function is_close(blk)
  if blk.t ~= 'Para' and blk.t ~= 'Plain' then return false end
  local c = blk.content
  return #c == 1 and c[1].t == 'Str' and c[1].text == ':::'
end

--[[
  单段形式：`::: 定理 标题` 与正文之间**没有空行**时，pandoc 根本不会把它当成围栏
  （简写只认单独类名），于是开、体、闭三部分被并成**同一个段落**：

      Para[ Str ":::", Space, Str "定理", Space, Str "标题", SoftBreak,
            Str "正文…", SoftBreak, Str ":::" ]

  这种必须先拆开才能认出容器。返回 kind、标题内联、正文块列表。
--]]
local function split_inline_callout(blk)
  if blk.t ~= 'Para' and blk.t ~= 'Plain' then return nil end
  local c = blk.content
  if #c < 3 then return nil end
  if not (c[1].t == 'Str' and c[1].text == ':::') then return nil end
  local last = c[#c]
  if not (last.t == 'Str' and last.text == ':::') then return nil end

  local kind, title = split_header(c)
  if not kind then return nil end

  -- split_header 把"kind 之后的全部"当标题；这里标题只到第一个换行为止，其余是正文
  local title_out, body_inlines, seen_break = {}, {}, false
  local started = false
  for i = 3, #c - 1 do
    local x = c[i]
    if not started then
      if x.t == 'Str' and canon(x.text) == kind then started = true end
    elseif x.t == 'SoftBreak' or x.t == 'LineBreak' or x.t == 'Space' then
      if x.t ~= 'Space' then seen_break = true end
      if seen_break then body_inlines[#body_inlines + 1] = x end
      if not seen_break then title_out[#title_out + 1] = pandoc.Space() end
    elseif seen_break then
      body_inlines[#body_inlines + 1] = x
    else
      title_out[#title_out + 1] = x
    end
  end
  -- 去掉标题尾部多余空格
  while #title_out > 0 and title_out[#title_out].t == 'Space' do
    table.remove(title_out)
  end
  -- 正文按换行拆成段
  local body, cur = {}, {}
  for _, x in ipairs(body_inlines) do
    if x.t == 'SoftBreak' or x.t == 'LineBreak' then
      if #cur > 0 then body[#body + 1] = pandoc.Plain(cur); cur = {} end
    else
      cur[#cur + 1] = x
    end
  end
  if #cur > 0 then body[#body + 1] = pandoc.Plain(cur) end
  if #body == 0 then return nil end

  local title_clean = {}
  for _, x in ipairs(title_out) do
    if x.t ~= 'Space' or #title_clean > 0 then title_clean[#title_clean + 1] = x end
  end
  return kind, title_clean, body
end

-- 这一段是不是"容器开始行"
local function is_open(blk)
  if blk.t ~= 'Para' and blk.t ~= 'Plain' then return false end
  local c = blk.content
  return #c >= 1 and c[1].t == 'Str' and c[1].text == ':::'
end

-- 把内联序列写成 LaTeX 源码（不含首尾空白）
local function to_tex(inlines)
  return (pandoc.write(pandoc.Pandoc({ pandoc.Plain(inlines) }), 'latex'):gsub('%s+$', ''))
end

-- 把若干块包成容器（LaTeX 环境；其它格式退化为带类的 Div，保持内容不丢）
local function wrap(kind, title, body)
  local label = LABEL[kind] or kind

  if FORMAT:match 'latex' or FORMAT:match 'beamer' then
    -- 标签加粗、标题正体，两者之间用**显式间距**而不是空格：
    -- xeCJK 默认会吃掉中日韩字符之间的空格，写空格在 PDF 里等于没写。
    local head_tex = '\\textbf{' .. to_tex({ pandoc.Str(label) }) .. '}'
    if title and #title > 0 then
      head_tex = head_tex .. '\\hspace{0.6em}' .. to_tex(title)
    end
    local out = { pandoc.RawBlock('latex', '\\begin{mdpcallout}{' .. head_tex .. '}') }
    for _, b in ipairs(body) do out[#out + 1] = b end
    out[#out + 1] = pandoc.RawBlock('latex', '\\end{mdpcallout}')
    return out
  end

  local head = pandoc.Inlines({ pandoc.Str(label) })
  for _, x in ipairs(title or {}) do head:insert(x) end
  local div_body = { pandoc.Plain(head) }
  for _, b in ipairs(body) do div_body[#div_body + 1] = b end
  return { pandoc.Div(div_body, pandoc.Attr('', { 'mdp-callout', kind })) }
end

-- 走一遍块列表：处理「pandoc 没认出来的 ::: 序列」
local function rewrite_blocks(blocks)
  local out, i = {}, 1
  while i <= #blocks do
    local blk = blocks[i]
    local ikind, ititle, ibody = split_inline_callout(blk)
    if ikind then
      -- 单段形式（开、体、闭挤在同一段里）—— 先处理它，否则会被当成普通段落
      for _, x in ipairs(wrap(ikind, ititle, rewrite_blocks(ibody))) do
        out[#out + 1] = x
      end
      i = i + 1
    elseif is_open(blk) then
      local kind, title = split_header(blk.content)
      if kind then
        -- 找到与之配对的结束行
        local j, body = i + 1, {}
        while j <= #blocks and not is_close(blocks[j]) do
          body[#body + 1] = blocks[j]
          j = j + 1
        end
        if j <= #blocks then
          -- 结束行后面如果紧跟空白/其它内容，照常继续
          for _, x in ipairs(wrap(kind, title, rewrite_blocks(body))) do
            out[#out + 1] = x
          end
          i = j + 1
        else
          -- 没有结束行：不猜，原样放回去
          out[#out + 1] = blk
          i = i + 1
        end
      else
        out[#out + 1] = blk
        i = i + 1
      end
    elseif blk.t == 'Div' then
      -- 第二遍：`::: note` 这种只需类名的写法，pandoc 已经解析成 Div 了
      local kind = blk.classes and blk.classes[1]
      local c = canon(kind)
      if c and not (blk.classes and blk.classes[2] == 'mdp-callout') then
        for _, x in ipairs(wrap(c, {}, rewrite_blocks(blk.content))) do
          out[#out + 1] = x
        end
      else
        blk.content = rewrite_blocks(blk.content)
        out[#out + 1] = blk
      end
      i = i + 1
    else
      out[#out + 1] = blk
      i = i + 1
    end
  end
  return out
end

function Pandoc(doc)
  doc.blocks = rewrite_blocks(doc.blocks)
  return doc
end
