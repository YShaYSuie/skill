# md-to-word

文档标准化与 Word 生成 Skill。

## 介绍

将 Markdown 或已有 Word 文档标准化为符合指定 Word 模板规范的 `.docx` 文件。输入文档负责内容与逻辑结构，Word 模板负责视觉样式与最终自动编号，AI 只做必要的理解和安全结构判断。

## 功能

- Markdown 转 Word：检查结构、生成 `.docx`
- Word 样式标准化：保留内容，统一标题、正文、表格、编号和页面样式
- Word 结构标准化：分析章节、列表、表格结构后重新标准化
- Word 模板迁移：把旧 Word 内容迁移到新 Word 模板
- 行内格式解析：加粗、斜体、删除线、行内代码、字体颜色
- 中文标点规范化：中文语境成对 ASCII 引号转弯引号，路径/URL/命令保护
- 模板样式补全：缺 Quote/Code 样式时在副本中程序化创建

## 安装与使用

1. 将 `md-to-word/` 目录复制到你的 AI 技能库（如 `~/.codex/skills/`）。
2. 在 `templates/` 目录下放置你自己的 `default.docx`（本仓库不包含模板文件）。
3. 对 AI 说："把这个 Markdown 转成 Word" 或 "把这个 Word 按标准格式整理一下"。

### 依赖

- Python 3.6+
- python-docx（`pip install python-docx`）

### 内置脚本

- `scripts/build_docx.py`：Markdown → Word
- `scripts/standardize_docx.py`：Word → Word

## 配置

### 模板优先级

1. 本次明确指定的模板
2. 本次上传的 Word 模板
3. 模板库匹配模板（`templates/library/`）
4. `templates/default.docx`

### 目录结构

```
md-to-word/
├── SKILL.md            # AI 执行规范
├── capability.yaml     # 能力声明
├── README.md           # 本文件
├── GUIDE.md            # 人类使用指南
├── CHANGELOG.md        # 变更记录
├── VERSION             # 版本号
├── docs/               # 辅助文档
│   └── template-guide.md
├── references/         # 维护者参考
│   └── implementation-lessons.md
├── scripts/            # 内置脚本
│   ├── build_docx.py
│   └── standardize_docx.py
└── templates/
    ├── default.docx    # 默认模板
    └── library/        # 模板库（可选）
```

## 示例

```text
把这个 Markdown 转成 Word。
```

```text
不要改内容，只统一字体、标题和表格格式。
```

```text
帮我把这个 Word 按上传的正式报告模板重新排版。
```

## Capabilities

基础能力：

- Markdown To Word
- Word Style Standardize
- Word Structure Standardize
- Word Template Migrate
- Inline Format Parsing
- Cjk Punctuation Normalize
- Template Style Completion
- Explicit Warnings

可选增强：

- Custom Template
- Standardized Md Output
