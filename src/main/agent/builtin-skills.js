'use strict';

/**
 * 内置系统技能（Markdown 文档整理方向）
 *
 * 每条技能是一个带 frontmatter 的 md 文件，首次运行时落盘到
 * <userData>/agent/skills/，用户可直接编辑或新增；项目级技能放 <项目根>/.oskill/。
 * name/description/when/tools 为元数据，正文会原样注入系统提示。
 */

const BUILTIN_SKILLS = [
  {
    name: 'markdown-desk',
    title: 'Markdown 文档工作台',
    description: '对 .md 文档做新建、读取、编辑、保存、删除、改名、格式化、嵌入图片与内联资源。',
    when: ['markdown', 'md', '文档', '排版', '格式', '整理', '标题', '表格', '目录', '图片', '插图', '封面', 'frontmatter', '字数'],
    tools: ['list_directory', 'read_file', 'write_file', 'edit_file', 'replace_in_file', 'delete_file', 'move_file', 'format_markdown', 'insert_image', 'outline', 'add_toc', 'count_words', 'check_links'],
    body: `# Markdown 文档工作台

## 工作原则
1. 动手前先 \`list_directory\` 或 \`read_file\` 看清现状，不要凭猜测覆盖已有内容。
2. 只改用户要求的部分。格式化、补空行、对齐表格属于安全改动；删段、改标题层级、重排章节属于破坏性改动，先在回复里说明你打算怎么做。
3. 写回时保留原文换行风格与既有缩进；不要在正文里塞 HTML 注释当备忘。
4. 每次写文件后，用 \`read_file\` 抽查关键片段，确认落盘内容与预期一致，再向用户汇报。

## 常用套路
- 整理一篇长文：\`outline\` 看结构 → \`format_markdown\`（规范化空格/空行/列表符号/表格）→ \`add_toc\` 生成目录 → \`count_words\` 报告规模。
- 调整层级：把「## 小节」升为「# 章」时，其下所有标题同步升降一级，别只改一处。
- 插图：图片先 \`import_asset\` 复制进项目 \`assets/\`，再 \`insert_image\` 用相对路径引用；需要单文件分发时才用 base64 内联，并提醒用户体积会膨胀。
- 链接体检：\`check_links\` 找出失效的本地图片与相对链接，逐条列出修复建议。

## 汇报格式
结束时用 2–4 行说清：改了哪些文件、每个文件做了什么、验证结果、需要用户决定的点。不要复述全文。`
  },
  {
    name: 'doc-project',
    title: '文档项目管理（md / txt）',
    description: '管理由 .md 与 .txt 组成的文档项目：目录结构、命名规范、索引文件、批量重命名与归档。',
    when: ['项目', '目录结构', '归档', '批量', '重命名', '索引', 'README', '笔记', '整理文件夹', '移动'],
    tools: ['list_directory', 'tree', 'read_file', 'write_file', 'move_file', 'delete_file', 'create_directory', 'search_text', 'outline'],
    body: `# 文档项目管理

## 结构约定
- 一个项目一个根目录，根下必须有 README.md 说明用途与目录约定。
- 正文类放 \`docs/\`，按主题分子目录；素材放 \`assets/\`（图片按 \`assets/<文档名>/\` 归组）；导出物放 \`dist/\`；草稿放 \`drafts/\`。
- 文件名用小写字母、数字、连字符；中文标题可保留，但避免空格与 \`\\/:*?"<>|\`。
- 日期型笔记统一 \`YYYY-MM-DD-主题.md\`，需要排序时前缀即排序键。

## 批量操作守则
1. 先 \`tree\` 或 \`list_directory\` 列出受影响文件，把清单告诉用户。
2. 批量重命名/移动用 \`move_file\` 逐个执行，一次一个，失败即停并报告，不要静默跳过。
3. 删除永远先列清单；目录递归删除必须用户明确同意。
4. 完成后生成或更新 \`docs/INDEX.md\`：每个文档一行「路径 — 一句话摘要」。

## 检索
- 找内容用 \`search_text\`（支持 glob 过滤与正则），别整篇读文件浪费上下文。`
  },
  {
    name: 'data-doc',
    title: '数据文档管理（json / xml / csv）',
    description: '校验、美化、结构分析与改写 .json/.jsonc/.xml/.svg 数据文件。',
    when: ['json', 'xml', 'svg', '数据', '配置', '校验', 'schema', '字段', '格式化数据', 'yaml', 'csv'],
    tools: ['read_file', 'write_file', 'validate_json', 'tidy_json', 'validate_xml', 'tidy_xml', 'diff_text', 'search_text'],
    body: `# 数据文档管理

## 校验优先
- 任何 JSON 改写前先 \`validate_json\`；XML/SVG 先 \`validate_xml\`。原文件本身不合法时，先告诉用户错误在哪，再问是否修复。
- 写回前必须再次校验，确保没有把结构改坏。

## 改写守则
- JSON 统一 2 空格缩进、键序保持稳定、数组不做排序（顺序即语义）。
- 只增删用户点名的键；对不确定的字段类型，保持原类型而不是「顺手修正」。
- XML 注意命名空间前缀（\`xmlns:\`）与实体引用，XML 只允许 5 个预定义实体，别把 HTML 实体抄进来。
- 大文件（>1MB）不要整篇读入，用 \`search_text\` 定位后按片段改。

## 输出
用「路径 → 字段 → 变化」三段式描述改动，必要时给一个 5 行以内的 before/after 片段。`
  },
  {
    name: 'h5-project',
    title: '本地 H5 小项目',
    description: '在纯本地环境下编写 js / html / css 小页面并自检，不依赖构建工具。',
    when: ['h5', '页面', 'html', 'css', 'javascript', 'js', '小游戏', '原型', '前端', '网页', '可视化'],
    tools: ['create_directory', 'write_file', 'read_file', 'edit_file', 'scaffold_h5', 'list_directory', 'search_text', 'validate_html', 'open_in_browser', 'insert_image'],
    body: `# 本地 H5 小项目

## 最小结构
\`index.html\` + \`style.css\` + \`app.js\` 三件套即可，不要引入构建工具与 npm 依赖；确实需要第三方库时用 CDN \`<script src>\` 并在 README 里注明离线不可用的事实。

## 写法约定
- HTML：\`<!DOCTYPE html>\`、\`lang="zh-CN"\`、\`<meta charset="UTF-8">\`、\`<meta name="viewport">\` 一个都不能少。
- CSS：变量写在 \`:root\`，配色跟随系统 \`color-scheme\`；避免固定 px 宽度，用 \`max-width\` + 弹性布局。
- JS：\`addEventListener\` 统一在 \`DOMContentLoaded\` 之后注册；不写内联 \`onclick\`；状态集中在一个对象里，别散落成全局变量。

## 自检
1. \`validate_html\` 检查标签配对与关键 meta。
2. 交互类需求：把关键路径（点击→状态变化→DOM 更新）在 README 里写成清单。
3. 需要预览时用 \`open_in_browser\` 打开本地文件，不要起服务器端口除非用户要求。`
  },
  {
    name: 'web-search',
    title: '联网检索与来源核实',
    description: '免密钥多引擎搜索、正文抓取与来源交叉核实，用于补充文档资料与技术事实。',
    when: ['搜索', '查一下', '资料', '最新', '文档', '官网', '引用', '来源', '核实', 'search', '查资料'],
    tools: ['web_search', 'web_fetch', 'write_file', 'read_file', 'insert_image'],
    body: `# 联网检索与来源核实

## 检索策略
- 一次搜索不满意就换关键词，别重复同一个词。中文主题优先 Bing 中国，英文主题加 \`site:\` 或 \`intitle:\` 缩小范围。
- 需要事实性结论时至少看两个来源；只有一条来源就在回复里标注「单一来源」。
- 抓取正文后优先看官方文档/项目主页，其次才是博客与问答。

## 引用纪律
- 写进文档的每条外部结论后面附来源链接与访问日期。
- 搜索失败或正文为空（前端渲染站点常见）时如实说明，不要凭印象编造内容。
- 图片链接注意版权，优先公有领域或用户自备素材。`
  },
  {
    name: 'plan-act-reflect',
    title: '计划—执行—复盘工作法',
    description: '多步骤任务的标准工作方式：先出计划，再逐步执行，最后自查并沉淀记忆。',
    when: ['多步骤', '计划', '重构', '批量', '整套', '全流程', '帮我做', '方案'],
    tools: ['set_plan', 'update_plan_step', 'list_directory', 'read_file', 'write_file', 'memory_add', 'memory_search'],
    body: `# 计划—执行—复盘工作法

## Plan
- 任务包含 3 个以上动作或跨多个文件时，先 \`set_plan\` 写下步骤清单，每步一句话、可验证。
- 计划里必须包含一个「验证」步骤；不确定用户意图时，把疑问写进计划的最后一步而不是猜。

## Act
- 严格按序执行；每完成一步调 \`update_plan_step\`。
- 偏离计划时（发现前提不成立、需要新增步骤）先在回复里说明，再改计划，不要静默转向。

## Reflect
- 收尾自查：改动是否都在项目内、是否有半途失败的文件、用户的要求是否逐条满足。
- 把可长期复用的结论（命名约定、用户偏好、踩过的坑）用 \`memory_add\` 写进项目 \`.omemory/\`，一条一个事实，别写成长篇总结。`
  }
];

module.exports = { BUILTIN_SKILLS };
