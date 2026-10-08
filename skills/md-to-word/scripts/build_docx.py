#!/usr/bin/env python3
"""Convert a normalized Markdown document into a Word template-driven DOCX.

The script deliberately keeps visual formatting in the DOCX template.  Markdown
supplies content and structure; headings are mapped to template styles and their
chapter numbers are produced by real Word numbering definitions.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict
from math import log1p
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"
EMU_PER_CM = 360000

NS = {
    "w": W_NS,
    "r": R_NS,
    "rel": REL_NS,
    "ct": CT_NS,
    "wp": WP_NS,
    "a": A_NS,
    "pic": PIC_NS,
    "xml": "http://www.w3.org/XML/1998/namespace",
}

for namespace_prefix, namespace_uri in NS.items():
    ET.register_namespace(namespace_prefix, namespace_uri)


class ConversionError(Exception):
    """Raised when conversion cannot be performed safely."""


class ConfirmationRequired(Exception):
    """Raised when the caller must make a decision before conversion continues."""


def qn(prefix: str, tag: str) -> str:
    return f"{{{NS[prefix]}}}{tag}"


def strip_ns(tag: str) -> str:
    return tag.split("}", 1)[-1]


def xml_text(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return "".join(element.itertext()).strip()


def indent_xml(element: ET.Element) -> None:
    ET.indent(element, space="  ")


def serialize_xml(root: ET.Element) -> str:
    indent_xml(root)
    return ET.tostring(root, encoding="unicode", xml_declaration=False)


STRUCTURAL_PREFIX_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "arabic",
        re.compile(r"^(?P<prefix>\d+(?:\.\d+)*)(?P<sep>[.、．]\s*|\s+)(?P<text>.+)$"),
    ),
    (
        "chinese",
        re.compile(r"^(?P<prefix>[一二三四五六七八九十]+)(?P<sep>[、.．]\s*|\s+)(?P<text>.+)$"),
    ),
    (
        "paren",
        re.compile(r"^(?P<prefix>[（(](?:[一二三四五六七八九十]+|\d+(?:\.\d+)*)[）)])(?P<sep>\s*)(?P<text>.+)$"),
    ),
    (
        "letter",
        re.compile(r"^(?P<prefix>[A-Z]+(?:\.\d+)*)(?P<sep>[.、．]\s*|\s+)(?P<text>.+)$"),
    ),
]


IMAGE_PATTERN = re.compile(r"^!\[(?P<alt>.*?)\]\((?P<src><[^>]+>|[^)]+)\)\s*$", re.DOTALL)
TABLE_LIST_PREFIX = re.compile(
    r"^(?P<prefix>[（(]\s*(?:\d+(?:\.\d+)*|[一二三四五六七八九十]+)\s*[）)]|"
    r"[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[、.．](?!\d))\s*(?P<body>.+)$"
)

# 中文语境判定：字符为 CJK（汉字、中文标点、全角字符）
CJK_CHAR_RE = re.compile(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]")

# 疑似路径/命令/URL 特征：盘符、反斜杠、斜杠段、URL scheme、以 - 开头的参数
PATH_LIKE_RE = re.compile(
    r"(?:[A-Za-z]:\\|\\{1,2}|/{2,}|https?://|ftp://|^\s*-\w|\.(?:exe|dll|bat|ps1|sh|py|md|docx?|xlsx?|pptx?|txt|json|ya?ml|xml|ini|cfg)\b)",
    re.IGNORECASE,
)


def normalize_cjk_punctuation(text: str) -> str:
    """把中文语境下的成对 ASCII 引号转换为中文弯引号。

    规则：
    - 引号包裹内容或其前后相邻字符含中文时才转换（保护 URL、路径、纯英文）；
    - 成对转换：开引号 + 内容 + 闭引号一次性输出，不吞字符；
    - 单引号仅处理短包裹（≤8 字符），避免误伤英文缩写（it's）；
    - 不处理代码块（调用方保证）。
    """
    result: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            close = text.find('"', i + 1)
            if close != -1:
                inner = text[i + 1:close]
                # 路径/URL/命令保护：内容疑似路径时不转换
                if not PATH_LIKE_RE.search(inner):
                    # 语境判定：包裹内容含中文，或引号外侧最近的非空白字符含中文
                    before_ctx = text[:i].rstrip()
                    after_ctx = text[close + 1:].lstrip()
                    before_char = before_ctx[-1] if before_ctx else ""
                    after_char = after_ctx[0] if after_ctx else ""
                    if CJK_CHAR_RE.search(inner) or CJK_CHAR_RE.search(before_char + after_char):
                        result.append("\u201c" + inner + "\u201d")
                        i = close + 1
                        continue
        elif ch == "'":
            close = text.find("'", i + 1)
            if close != -1 and close - i <= 9:
                inner = text[i + 1:close]
                if not PATH_LIKE_RE.search(inner):
                    before_ctx = text[:i].rstrip()
                    after_ctx = text[close + 1:].lstrip()
                    before_char = before_ctx[-1] if before_ctx else ""
                    after_char = after_ctx[0] if after_ctx else ""
                    if CJK_CHAR_RE.search(inner) or CJK_CHAR_RE.search(before_char + after_char):
                        result.append("\u2018" + inner + "\u2019")
                        i = close + 1
                        continue
        result.append(ch)
        i += 1
    return "".join(result)


def extract_image(line: str) -> tuple[str, str] | None:
    text = re.sub(r"\s+", " ", line.strip())
    match = IMAGE_PATTERN.match(text)
    if not match:
        return None
    source = match.group("src").strip()
    if source.startswith("<") and source.endswith(">"):
        source = source[1:-1]
    return match.group("alt"), source


def classify_prefix(text: str) -> tuple[str, str, str] | None:
    stripped = text.lstrip()
    for pattern_name, pattern in STRUCTURAL_PREFIX_PATTERNS:
        match = pattern.match(stripped)
        if not match:
            continue
        prefix = match.group("prefix")
        body = match.group("text").strip()
        if not body:
            return None
        if pattern_name == "arabic":
            depth = prefix.count(".") + 1
            signature = f"arabic:{depth}"
        elif pattern_name == "letter":
            depth = prefix.count(".") + 1
            signature = f"letter:{depth}"
        elif pattern_name == "paren":
            signature = "paren"
        else:
            signature = "chinese"
        return signature, prefix, body
    return None


def parse_table_block(lines: list[str]) -> dict[str, Any] | None:
    rows: list[list[str]] = []
    for raw in lines:
        line = raw.strip().strip("|").strip()
        cells = [normalize_cjk_punctuation(cell.strip()) for cell in line.split("|")]
        rows.append(cells)
    if not rows:
        return None
    separator_index = None
    for index, row in enumerate(rows[1:], start=1):
        if all(re.fullmatch(r":?-{3,}:?", cell) for cell in row if cell):
            separator_index = index
            break
    if separator_index is not None:
        rows.pop(separator_index)
    width = max(len(row) for row in rows)
    normalized_rows = [row + [""] * (width - len(row)) for row in rows]
    return {"type": "table", "rows": normalized_rows, "has_header": separator_index is not None}


def split_ordered_prefix(text: str) -> tuple[str, str] | None:
    """拆分单元格内明确的有序编号前缀。

    防护（不变式校验）：prefix 之后的剩余文本去掉首尾空白后必须等于 body，
    且 body 非空；否则视为误匹配（如 IP 地址 10.50.10.22、版本号 2.0），
    返回 None 保留原文。
    """
    stripped = text.strip()
    match = TABLE_LIST_PREFIX.match(stripped)
    if not match:
        return None
    prefix = match.group("prefix")
    body = match.group("body").strip()
    if not body:
        return None
    remainder = stripped[len(prefix):].strip()
    if body != remainder:
        return None
    return (body, prefix)


def parse_markdown(markdown: str) -> list[dict[str, Any]]:
    """Parse Markdown into a lightweight intermediate document structure."""
    blocks: list[dict[str, Any]] = []
    paragraph: list[str] = []
    code_lines: list[str] = []
    list_lines: list[str] = []
    quote_lines: list[str] = []
    table_lines: list[str] = []
    fence_marker: str | None = None

    def flush_paragraph() -> None:
        if not paragraph:
            return
        text = "\n".join(paragraph).strip()
        paragraph.clear()
        if not text:
            return
        image = extract_image(text)
        if image:
            blocks.append({"type": "image", "alt": image[0], "src": image[1]})
        else:
            blocks.append({"type": "paragraph", "text": normalize_cjk_punctuation(text)})

    def flush_list() -> None:
        if not list_lines:
            return
        items: list[dict[str, Any]] = []
        ordered = False
        for raw in list_lines:
            line = raw.strip()
            ordered_match = re.match(r"^(\d+)[.)]\s+(.*)$", line)
            if ordered_match:
                ordered = True
                items.append({"text": normalize_cjk_punctuation(ordered_match.group(2)), "marker": ordered_match.group(1)})
                continue
            unordered_match = re.match(r"^[-*+]\s+(.*)$", line)
            if unordered_match:
                items.append({"text": normalize_cjk_punctuation(unordered_match.group(1)), "marker": None})
                continue
            if items:
                items[-1]["text"] += "\n" + line
        list_lines.clear()
        blocks.append({"type": "list", "ordered": ordered, "items": items})

    def flush_quote() -> None:
        if not quote_lines:
            return
        text = "\n".join(line[1:].strip() if line.startswith(">") else line for line in quote_lines)
        quote_lines.clear()
        # 空引用行（仅 ">"）与首尾换行是引用块边界标记，不是内容；
        # 保留在中间会产生段内空行（<w:br/>），这里清除首尾空行、压掉中间连续空行。
        lines = [ln for ln in text.split("\n")]
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        cleaned: list[str] = []
        prev_empty = False
        for ln in lines:
            empty = not ln.strip()
            if empty and prev_empty:
                continue
            cleaned.append(ln)
            prev_empty = empty
        text = "\n".join(cleaned)
        if not text:
            return
        blocks.append({"type": "quote", "text": normalize_cjk_punctuation(text)})

    def flush_table() -> None:
        if not table_lines:
            return
        parsed = parse_table_block(table_lines)
        table_lines.clear()
        if parsed:
            blocks.append(parsed)

    def flush_all() -> None:
        flush_paragraph()
        flush_list()
        flush_quote()
        flush_table()

    for raw_line in markdown.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        fence_match = re.match(r"^(?P<marker>`{3,}|~{3,})", stripped)
        if fence_match:
            if fence_marker is None:
                flush_all()
                fence_marker = fence_match.group("marker")
                continue
            if fence_match.group("marker")[0] == fence_marker[0]:
                blocks.append({"type": "code", "text": "\n".join(code_lines)})
                code_lines.clear()
                fence_marker = None
                continue
        if fence_marker is not None:
            code_lines.append(raw_line)
            continue
        if stripped.startswith(">"):
            flush_paragraph()
            flush_list()
            flush_table()
            quote_lines.append(stripped)
            continue
        if stripped.startswith("|"):
            flush_paragraph()
            flush_list()
            flush_quote()
            table_lines.append(stripped)
            continue
        if re.match(r"^[-*+]\s+", stripped) or re.match(r"^\d+[.)]\s+", stripped):
            flush_paragraph()
            flush_quote()
            flush_table()
            list_lines.append(stripped)
            continue
        heading_match = re.match(r"^(?P<level>#{1,6})\s+(?P<text>.+?)\s*#*\s*$", stripped)
        if heading_match:
            flush_all()
            heading_text = heading_match.group("text")
            classification = classify_prefix(heading_text)
            if classification:
                _, prefix, body = classification
                heading_text = body
                number_hint = prefix
            else:
                number_hint = None
            blocks.append(
                {
                    "type": "heading",
                    "level": len(heading_match.group("level")),
                    "text": heading_match.group("text"),
                    "title": normalize_cjk_punctuation(heading_text),
                    "number_hint": number_hint,
                }
            )
            continue
        # 水平分隔线：--- 、*** 、___（三个及以上同类字符，且不是表格分隔行）
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
            flush_all()
            blocks.append({"type": "hr"})
            continue
        if not stripped:
            flush_all()
            continue
        flush_list()
        flush_quote()
        flush_table()
        paragraph.append(stripped)
    flush_all()
    if code_lines:
        blocks.append({"type": "code", "text": "\n".join(code_lines)})
    return blocks


def normalize_markdown(markdown: str) -> tuple[str, list[dict[str, Any]], list[str]]:
    """Normalize headings and extract structural chapter number hints."""
    normalized_lines: list[str] = []
    number_hints: list[dict[str, Any]] = []
    warnings: list[str] = []
    signature_levels: dict[str, set[int]] = defaultdict(set)
    signature_counts: Counter[str] = Counter()

    raw_blocks = parse_markdown(markdown)
    for block in raw_blocks:
        if block["type"] != "heading":
            continue
        classification = classify_prefix(block["text"])
        if classification:
            signature, prefix, body = classification
            signature_levels[signature].add(block["level"])
            signature_counts[signature] += 1
            block["number_hint"] = prefix
            block["title"] = body
        else:
            block["number_hint"] = None
            block["title"] = block["text"]

    for signature, levels in signature_levels.items():
        if len(levels) > 1:
            warnings.append(
                f"同一编号模式 {signature} 出现在多个标题层级：{', '.join(f'H{level}' for level in sorted(levels))}"
            )

    in_code = False
    for line in markdown.splitlines():
        stripped = line.strip()
        fence_match = re.match(r"^(`{3,}|~{3,})", stripped)
        if fence_match:
            in_code = not in_code
            normalized_lines.append(line)
            continue
        if in_code:
            normalized_lines.append(line)
            continue
        heading_match = re.match(r"^(?P<level>#{1,6})\s+(?P<text>.+?)\s*#*\s*$", stripped)
        if heading_match:
            level = len(heading_match.group("level"))
            title = heading_match.group("text")
            title = re.sub(r"\s+", " ", title)
            classification = classify_prefix(title)
            if classification:
                signature, prefix, body = classification
                if signature_counts[signature] > 1 or ":" in signature:
                    title = body
                    number_hints.append({"level": level, "number_hint": prefix, "title": body})
            normalized_lines.append(f"{'#' * level} {title}")
        else:
            normalized_lines.append(line)
    return "\n".join(normalized_lines).rstrip() + "\n", number_hints, warnings


def load_docx(path: Path) -> tuple[dict[str, bytes], dict[str, ET.Element]]:
    with zipfile.ZipFile(path, "r") as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    trees = {}
    for name in ("word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"):
        if name in entries:
            trees[name] = ET.fromstring(entries[name])
    return entries, trees


def get_styles(styles_root: ET.Element) -> dict[str, dict[str, Any]]:
    styles: dict[str, dict[str, Any]] = {}
    for style in styles_root.findall(qn("w", "style")):
        style_id = style.attrib.get(qn("w", "styleId"), "")
        name_element = style.find(qn("w", "name"))
        name = name_element.attrib.get(qn("w", "val"), "") if name_element is not None else ""
        styles[style_id] = {"id": style_id, "name": name, "element": style}
    return styles


def heading_style_candidates(styles: dict[str, dict[str, Any]]) -> dict[int, str]:
    headings: dict[int, str] = {}
    for style_id, style in styles.items():
        name = style["name"]
        level_match = re.search(r"(?:Heading|标题|heading)\s*(\d+)", name, re.IGNORECASE)
        if level_match:
            headings.setdefault(int(level_match.group(1)), style_id)
    if headings:
        return headings
    for style_id in styles:
        if re.match(r"^(?:Heading|标题)(\d+)$", style_id, re.IGNORECASE):
            headings.setdefault(int(style_id[-1]), style_id)
    return headings


def style_numbering(style: ET.Element) -> tuple[str | None, str | None]:
    ppr = style.find(qn("w", "pPr"))
    if ppr is None:
        return None, None
    numpr = ppr.find(qn("w", "numPr"))
    if numpr is None:
        return None, None
    numid = numpr.find(qn("w", "numId"))
    ilvl = numpr.find(qn("w", "ilvl"))
    return (numid.attrib.get(qn("w", "val")) if numid is not None else None), (ilvl.attrib.get(qn("w", "val")) if ilvl is not None else None)


def analyze_template(
    template_path: Path,
    markdown_headings: set[int],
) -> dict[str, Any]:
    if not template_path.exists():
        raise ConfirmationRequired(
            f"未找到 Word 模板：{template_path}。首次使用请提供 default.docx。"
        )
    entries, trees = load_docx(template_path)
    if "word/styles.xml" not in trees:
        raise ConfirmationRequired("模板缺少 styles.xml，无法识别 Heading 与正文样式。")
    styles = get_styles(trees["word/styles.xml"])
    headings = heading_style_candidates(styles)
    if not headings:
        raise ConfirmationRequired("模板中没有可识别的 Heading 样式，无法绑定标题层级。")
    missing_headings = sorted(level for level in markdown_headings if level not in headings)
    if missing_headings:
        raise ConfirmationRequired(
            "模板缺少以下标题样式：" + ", ".join(f"Heading {level}" for level in missing_headings)
        )

    document_root = trees.get("word/document.xml")
    body = document_root.find(qn("w", "body")) if document_root is not None else None
    sectpr = body.find(qn("w", "sectPr")) if body is not None else None
    content_width = 9026
    if sectpr is not None:
        pgsz = sectpr.find(qn("w", "pgSz"))
        pgmar = sectpr.find(qn("w", "pgMar"))
        if pgsz is not None and pgmar is not None:
            page_width = int(pgsz.attrib.get(qn("w", "w"), "11906"))
            left = int(pgmar.attrib.get(qn("w", "left"), "1440"))
            right = int(pgmar.attrib.get(qn("w", "right"), "1440"))
            content_width = page_width - left - right

    table_styles = [style["id"] for style in styles.values() if "table" in style["name"].lower()]
    title_styles = [
        style["id"]
        for style in styles.values()
        if style["name"].lower() in {"title", "document title"} or style["name"] in {"标题", "文档标题"}
    ]
    quote_styles = [style["id"] for style in styles.values() if style["name"].lower() in {"quote", "intense quote"}]
    code_styles = [style["id"] for style in styles.values() if "code" in style["id"].lower() or "代码" in style["name"]]
    list_styles = [style["id"] for style in styles.values() if "list paragraph" in style["name"].lower() or "列表段落" in style["name"]]
    # 水平线样式：模板定义了才渲染 hr，未定义则跳过（模板感知，不硬编码视觉样式）
    hr_styles = [
        style["id"]
        for style in styles.values()
        if style["name"].lower() in {"horizontal line", "hr", "horizontal rule"}
        or style["name"] in {"水平线", "分隔线"}
    ]

    # 样式自动补全：模板缺失 Quote / Code 样式时，在模板副本中程序化创建
    # （不修改原模板文件），并记录补全动作供警告输出。
    template_completions: list[str] = []
    styles_root = trees["word/styles.xml"]

    def ensure_style(style_id: str, style_name: str, builder) -> list[str]:
        existing = [s for s in styles.values() if s["id"].lower() == style_id.lower()]
        if existing:
            return [existing[0]["id"]]
        new_style = builder(style_id, style_name)
        styles_root.append(new_style)
        styles[style_id] = {"id": style_id, "name": style_name, "element": new_style}
        return [style_id]

    def build_quote_style(style_id: str, style_name: str) -> ET.Element:
        style = ET.Element(qn("w", "style"))
        style.attrib.update({"type": "paragraph", "styleId": style_id})
        name = ET.SubElement(style, qn("w", "name"))
        name.attrib[qn("w", "val")] = style_name
        based = ET.SubElement(style, qn("w", "basedOn"))
        based.attrib[qn("w", "val")] = styles.get("Normal", {}).get("id", "Normal")
        ppr = ET.SubElement(style, qn("w", "pPr"))
        pbdr = ET.SubElement(ppr, qn("w", "pBdr"))
        left = ET.SubElement(pbdr, qn("w", "left"))
        left.attrib.update({"val": "single", "sz": "18", "space": "4", "color": "4472C4"})
        ind = ET.SubElement(ppr, qn("w", "ind"))
        ind.attrib.update({"left": "425"})
        spacing = ET.SubElement(ppr, qn("w", "spacing"))
        spacing.attrib.update({"before": "120", "after": "120"})
        rpr = ET.SubElement(style, qn("w", "rPr"))
        color = ET.SubElement(rpr, qn("w", "color"))
        color.attrib[qn("w", "val")] = "595959"
        return style

    def build_code_style(style_id: str, style_name: str) -> ET.Element:
        style = ET.Element(qn("w", "style"))
        style.attrib.update({"type": "paragraph", "styleId": style_id})
        name = ET.SubElement(style, qn("w", "name"))
        name.attrib[qn("w", "val")] = style_name
        based = ET.SubElement(style, qn("w", "basedOn"))
        based.attrib[qn("w", "val")] = styles.get("Normal", {}).get("id", "Normal")
        ppr = ET.SubElement(style, qn("w", "pPr"))
        shd = ET.SubElement(ppr, qn("w", "shd"))
        shd.attrib.update({"val": "clear", "color": "auto", "fill": "F2F2F2"})
        spacing = ET.SubElement(ppr, qn("w", "spacing"))
        spacing.attrib.update({"before": "60", "after": "60", "line": "240", "lineRule": "auto"})
        rpr = ET.SubElement(style, qn("w", "rPr"))
        rfonts = ET.SubElement(rpr, qn("w", "rFonts"))
        rfonts.attrib.update({"ascii": "Consolas", "hAnsi": "Consolas"})
        sz = ET.SubElement(rpr, qn("w", "sz"))
        sz.attrib[qn("w", "val")] = "19"
        return style

    if not quote_styles:
        quote_styles = ensure_style("Quote", "Quote", build_quote_style)
        template_completions.append("已自动补全 Quote 样式（左边框 + 缩进 + 灰字）")
    if not code_styles:
        code_styles = ensure_style("Code", "Code", build_code_style)
        template_completions.append("已自动补全 Code 样式（Consolas + 灰底）")

    numbering_root = trees.get("word/numbering.xml")
    if numbering_root is None:
        raise ConfirmationRequired("模板缺少 numbering.xml，无法确定章节自动编号体系。")

    abstract_nums: dict[str, list[dict[str, Any]]] = {}
    for abstract_num in numbering_root.findall(qn("w", "abstractNum")):
        abstract_id = abstract_num.attrib.get(qn("w", "abstractNumId"))
        levels = []
        for level in abstract_num.findall(qn("w", "lvl")):
            ilvl = level.attrib.get(qn("w", "ilvl"))
            lvl_text_element = level.find(qn("w", "lvlText"))
            numfmt_element = level.find(qn("w", "numFmt"))
            levels.append(
                {
                    "ilvl": ilvl,
                    "text": lvl_text_element.attrib.get(qn("w", "val"), "") if lvl_text_element is not None else "",
                    "format": numfmt_element.attrib.get(qn("w", "val"), "") if numfmt_element is not None else "",
                }
            )
        abstract_nums[abstract_id] = levels

    num_definitions: dict[str, dict[str, Any]] = {}
    for num in numbering_root.findall(qn("w", "num")):
        num_id = num.attrib.get(qn("w", "numId"))
        abstract_ref = num.find(qn("w", "abstractNumId"))
        abstract_id = abstract_ref.attrib.get(qn("w", "val")) if abstract_ref is not None else None
        num_definitions[num_id] = {"abstractId": abstract_id, "levels": abstract_nums.get(abstract_id, [])}

    heading_numbering: dict[int, dict[str, Any]] = {}
    for level, style_id in sorted(headings.items()):
        num_id, ilvl = style_numbering(styles[style_id]["element"])
        if num_id and num_id in num_definitions:
            heading_numbering[level] = {"numId": num_id, "ilvl": ilvl or str(level - 1), "source": "template_style"}

    if not heading_numbering:
        candidates = sorted(
            (num_id for num_id, definition in num_definitions.items() if definition["levels"]),
            key=lambda num_id: len(num_definitions[num_id]["levels"]),
            reverse=True,
        )
        if not candidates:
            raise ConfirmationRequired("模板中未发现可用的多级编号定义，无法自动绑定章节编号。")
        selected_num_id = candidates[0]
        for level, style_id in sorted(headings.items()):
            heading_numbering[level] = {
                "numId": selected_num_id,
                "ilvl": str(level - 1),
                "source": "template_inferred",
            }

    return {
        "entries": entries,
        "trees": trees,
        "styles": styles,
        "headings": headings,
        "heading_numbering": heading_numbering,
        "content_width": content_width,
        "table_styles": table_styles,
        "title_styles": title_styles,
        "quote_styles": quote_styles,
        "code_styles": code_styles,
        "list_styles": list_styles,
        "hr_styles": hr_styles,
        "sectpr": sectpr,
        "template_completions": template_completions,
    }


def update_styles_numbering(
    styles_root: ET.Element,
    heading_styles: dict[int, str],
    heading_numbering: dict[int, dict[str, Any]],
) -> None:
    for level, style_id in heading_styles.items():
        style = next(
            (style for style in styles_root.findall(qn("w", "style")) if style.attrib.get(qn("w", "styleId")) == style_id),
            None,
        )
        if style is None:
            continue
        ppr = style.find(qn("w", "pPr"))
        if ppr is None:
            ppr = ET.SubElement(style, qn("w", "pPr"))
        existing_numpr = ppr.find(qn("w", "numPr"))
        if existing_numpr is not None:
            ppr.remove(existing_numpr)
        numpr = ET.Element(qn("w", "numPr"))
        ilvl = ET.SubElement(numpr, qn("w", "ilvl"))
        ilvl.attrib[qn("w", "val")] = heading_numbering[level]["ilvl"]
        numid = ET.SubElement(numpr, qn("w", "numId"))
        numid.attrib[qn("w", "val")] = heading_numbering[level]["numId"]
        ppr.insert(0, numpr)


# 行内标记解析开关：代码块渲染时置 False，避免命令内容被误解析
inline_parsing_enabled = True

# 行内标记 token：**粗体**、*斜体*、~~删除~~、`代码`、<font>..</font>（color= 与 style= 两种写法）
INLINE_TOKEN_RE = re.compile(
    r"(\*\*(?P<bold>.+?)\*\*"
    r"|~~(?P<strike>.+?)~~"
    r"|`(?P<code>[^`]+)`"
    r"|\*(?P<italic>[^*\s][^*]*)\*"
    r"|<font[^>]*?\bcolor=\"?(?P<fontcolor>#[0-9A-Fa-f]{6})\"?[^>]*>(?P<fontbody>.*?)</font>"
    r"|<font[^>]*?color:\s*(?P<fontcolor2>#[0-9A-Fa-f]{6})[^>]*>(?P<fontbody2>.*?)</font>)",
    re.DOTALL,
)


def parse_inline_tokens(text: str, warnings: list[str] | None = None) -> list[dict[str, Any]]:
    """把行内 Markdown/HTML 标记解析为带格式的 token 列表。

    未闭合的标记原样保留，不吞字符。warnings 收集未闭合情况。
    """
    tokens: list[dict[str, Any]] = []
    pos = 0
    for match in INLINE_TOKEN_RE.finditer(text):
        if match.start() > pos:
            tokens.append({"text": text[pos:match.start()]})
        # 注意不能用 match.lastgroup：最外层捕获组总是最后匹配，会返回 None。
        # 逐一检查具名组取第一个非 None 者。
        content = None
        kind = None
        for name in ("bold", "strike", "code", "italic", "fontbody", "fontbody2"):
            value = match.group(name)
            if value is not None:
                kind = name
                content = value
                break
        if kind is None:
            pos = match.end()
            continue
        if kind == "bold":
            tokens.append({"text": content, "bold": True})
        elif kind == "italic":
            tokens.append({"text": content, "italic": True})
        elif kind == "strike":
            tokens.append({"text": content, "strike": True})
        elif kind == "code":
            tokens.append({"text": content, "code": True})
        elif kind in ("fontbody", "fontbody2"):
            color = match.group("fontcolor") or match.group("fontcolor2")
            tokens.append({"text": content, "color": color})
        pos = match.end()
    if pos < len(text):
        tail = text[pos:]
        # 检测未闭合标记并告警
        if warnings is not None and re.search(r"\*\*|~~|`|</?font", tail):
            warnings.append(f"行内存在未闭合标记，已按原样保留：{tail.strip()[:40]!r}")
        tokens.append({"text": tail})
    return tokens


def apply_run_format(run: ET.Element, fmt: dict[str, Any]) -> ET.Element:
    """把 token 格式写入 run 的 rPr。"""
    keys = [k for k in ("bold", "italic", "strike", "code", "color") if k in fmt]
    if not keys:
        return run
    rpr = ET.Element(qn("w", "rPr"))
    if fmt.get("bold"):
        ET.SubElement(rpr, qn("w", "b"))
    if fmt.get("italic"):
        ET.SubElement(rpr, qn("w", "i"))
    if fmt.get("strike"):
        ET.SubElement(rpr, qn("w", "strike"))
    if fmt.get("code"):
        rfonts = ET.SubElement(rpr, qn("w", "rFonts"))
        rfonts.attrib[qn("w", "ascii")] = "Consolas"
        rfonts.attrib[qn("w", "hAnsi")] = "Consolas"
        shd = ET.SubElement(rpr, qn("w", "shd"))
        shd.attrib.update({"val": "clear", "color": "auto", "fill": "F2F2F2"})
    if fmt.get("color"):
        color = ET.SubElement(rpr, qn("w", "color"))
        color.attrib[qn("w", "val")] = fmt["color"].lstrip("#")
    run.insert(0, rpr)
    return run


def make_run(text: str, fmt: dict[str, Any] | None = None) -> ET.Element:
    run = ET.Element(qn("w", "r"))
    t = ET.SubElement(run, qn("w", "t"))
    t.text = text
    t.attrib[qn("xml", "space")] = "preserve"
    has_format = bool(fmt) and any(k != "text" for k in fmt)
    if has_format:
        apply_run_format(run, fmt)
    if CJK_CHAR_RE.search(text):
        # 含中文的 run：显式标记东亚语言与字体提示，使 “”、—— 等歧义宽度
        # 标点由中文字体渲染（全角形态），与手动输入效果一致；否则 Word
        # 会用西文字体渲染出窄引号，造成同一文档引号形态混排。
        rpr = run.find(qn("w", "rPr"))
        if rpr is None:
            rpr = ET.Element(qn("w", "rPr"))
            run.insert(0, rpr)
        rfonts = rpr.find(qn("w", "rFonts"))
        if rfonts is None:
            rfonts = ET.Element(qn("w", "rFonts"))
            rpr.insert(0, rfonts)
        rfonts.attrib[qn("w", "hint")] = "eastAsia"
        lang = ET.SubElement(rpr, qn("w", "lang"))
        lang.attrib[qn("w", "val")] = "zh-CN"
        lang.attrib[qn("w", "eastAsia")] = "zh-CN"
    return run


def make_text_runs(text: str, warnings: list[str] | None = None) -> list[ET.Element]:
    runs: list[ET.Element] = []
    # 先做行内 token 解析（标记可跨越 <br>/换行，如多行 <font> 块），
    # 再对每个 token 的文本按换行切分插入 <w:br/>，格式得以延续。
    if inline_parsing_enabled:
        tokens = parse_inline_tokens(text, warnings)
    else:
        tokens = [{"text": text}]
    for token in tokens:
        segments = re.split(r"<br\s*/?\s*>|\n", token["text"], flags=re.IGNORECASE)
        for index, segment in enumerate(segments):
            if index:
                break_run = ET.Element(qn("w", "r"))
                ET.SubElement(break_run, qn("w", "br"))
                runs.append(break_run)
            if segment:
                runs.append(make_run(segment, token))
    return runs


def make_hr_paragraph(style_id: str) -> ET.Element:
    """水平分隔线：引用模板中定义的水平线样式（样式自带底边框等视觉定义）。"""
    paragraph = ET.Element(qn("w", "p"))
    ppr = ET.SubElement(paragraph, qn("w", "pPr"))
    pstyle = ET.SubElement(ppr, qn("w", "pStyle"))
    pstyle.attrib[qn("w", "val")] = style_id
    return paragraph


def make_paragraph(text: str, style_id: str | None = None, warnings: list[str] | None = None) -> ET.Element:
    paragraph = ET.Element(qn("w", "p"))
    if style_id:
        ppr = ET.SubElement(paragraph, qn("w", "pPr"))
        pstyle = ET.SubElement(ppr, qn("w", "pStyle"))
        pstyle.attrib[qn("w", "val")] = style_id
    if text:
        paragraph.extend(make_text_runs(text, warnings))
    return paragraph


def make_numbered_paragraph(
    text: str,
    style_id: str | None,
    num_id: str,
    ilvl: str = "0",
    warnings: list[str] | None = None,
) -> ET.Element:
    paragraph = make_paragraph(text, style_id, warnings)
    ppr = paragraph.find(qn("w", "pPr"))
    if ppr is None:
        ppr = ET.Element(qn("w", "pPr"))
        paragraph.insert(0, ppr)
    numpr = ET.SubElement(ppr, qn("w", "numPr"))
    ilvl_element = ET.SubElement(numpr, qn("w", "ilvl"))
    ilvl_element.attrib[qn("w", "val")] = ilvl
    numid_element = ET.SubElement(numpr, qn("w", "numId"))
    numid_element.attrib[qn("w", "val")] = num_id
    return paragraph


def next_numbering_id(numbering_root: ET.Element, tag: str, attribute: str) -> str:
    values = []
    for element in numbering_root.findall(qn("w", tag)):
        value = element.attrib.get(qn("w", attribute), "")
        if value.isdigit():
            values.append(int(value))
    return str(max(values, default=-1) + 1)


def add_list_abstract_numbering(template: dict[str, Any], ordered: bool) -> str:
    numbering_root = template["trees"].get("word/numbering.xml")
    if numbering_root is None:
        raise ConfirmationRequired("模板缺少 numbering.xml，无法创建正文自动编号。")
    cache_key = "ordered_list_abstract_id" if ordered else "bullet_list_abstract_id"
    abstract_id = template.get(cache_key)
    if abstract_id:
        return abstract_id

    abstract_id = next_numbering_id(numbering_root, "abstractNum", "abstractNumId")
    abstract_num = ET.Element(qn("w", "abstractNum"))
    abstract_num.attrib[qn("w", "abstractNumId")] = abstract_id
    multi_level = ET.SubElement(abstract_num, qn("w", "multiLevelType"))
    multi_level.attrib[qn("w", "val")] = "hybridMultilevel"
    level = ET.SubElement(abstract_num, qn("w", "lvl"))
    level.attrib[qn("w", "ilvl")] = "0"
    start = ET.SubElement(level, qn("w", "start"))
    start.attrib[qn("w", "val")] = "1"
    number_format = ET.SubElement(level, qn("w", "numFmt"))
    number_format.attrib[qn("w", "val")] = "decimal" if ordered else "bullet"
    level_text = ET.SubElement(level, qn("w", "lvlText"))
    level_text.attrib[qn("w", "val")] = "%1." if ordered else "•"
    level_jc = ET.SubElement(level, qn("w", "lvlJc"))
    level_jc.attrib[qn("w", "val")] = "left"
    ppr = ET.SubElement(level, qn("w", "pPr"))
    indent = ET.SubElement(ppr, qn("w", "ind"))
    indent.attrib.update({"left": "720", "hanging": "360"})

    nums = numbering_root.findall(qn("w", "num"))
    insert_index = list(numbering_root).index(nums[0]) if nums else len(list(numbering_root))
    numbering_root.insert(insert_index, abstract_num)
    template[cache_key] = abstract_id
    return abstract_id


def ensure_list_numbering(template: dict[str, Any], ordered: bool, restart: bool = False) -> str:
    numbering_root = template["trees"].get("word/numbering.xml")
    if numbering_root is None:
        raise ConfirmationRequired("模板缺少 numbering.xml，无法创建正文自动编号。")
    abstract_id = add_list_abstract_numbering(template, ordered)
    if not ordered and not restart:
        cached_num_id = template.get("bullet_list_num_id")
        if cached_num_id:
            return cached_num_id

    num_id = next_numbering_id(numbering_root, "num", "numId")
    num = ET.SubElement(numbering_root, qn("w", "num"))
    num.attrib[qn("w", "numId")] = num_id
    abstract_ref = ET.SubElement(num, qn("w", "abstractNumId"))
    abstract_ref.attrib[qn("w", "val")] = abstract_id
    if ordered:
        override = ET.SubElement(num, qn("w", "lvlOverride"))
        override.attrib[qn("w", "ilvl")] = "0"
        start_override = ET.SubElement(override, qn("w", "startOverride"))
        start_override.attrib[qn("w", "val")] = "1"
    else:
        template["bullet_list_num_id"] = num_id
    return num_id


def determine_heading_mapping(blocks: list[dict[str, Any]]) -> tuple[dict[int, int], bool]:
    heading_levels = [block["level"] for block in blocks if block["type"] == "heading"]
    use_title_mapping = bool(
        heading_levels
        and heading_levels[0] == 1
        and heading_levels.count(1) == 1
        and len(heading_levels) > 1
    )
    mapping = {level: (max(1, level - 1) if use_title_mapping else level) for level in set(heading_levels)}
    return mapping, use_title_mapping


def make_title_paragraph(text: str, style_id: str, suppress_style_numbering: bool) -> ET.Element:
    paragraph = make_paragraph(text, style_id)
    if suppress_style_numbering:
        ppr = paragraph.find(qn("w", "pPr"))
        numpr = ET.SubElement(ppr, qn("w", "numPr"))
        numid = ET.SubElement(numpr, qn("w", "numId"))
        numid.attrib[qn("w", "val")] = "0"
    return paragraph


def image_dimensions(data: bytes) -> tuple[int, int]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        return width, height
    if data.startswith(b"GIF8"):
        width = int.from_bytes(data[6:8], "little")
        height = int.from_bytes(data[8:10], "little")
        return width, height
    if data.startswith(b"BM"):
        width = int.from_bytes(data[18:22], "little", signed=True)
        height = int.from_bytes(data[22:26], "little", signed=True)
        return abs(width), abs(height)
    if data[:2] == b"\xff\xd8":
        offset = 2
        while offset < len(data) - 9:
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            if marker in {0xD8, 0x01} or 0xD0 <= marker <= 0xD7:
                offset += 2
                continue
            length = int.from_bytes(data[offset + 2 : offset + 4], "big")
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(data[offset + 5 : offset + 7], "big")
                width = int.from_bytes(data[offset + 7 : offset + 9], "big")
                return width, height
            offset += 2 + length
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8 ":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
            return width, height
    return 600, 400


def image_relationship_type(source: str) -> str:
    lower = source.lower()
    if lower.startswith("data:image/webp"):
        return "webp"
    if lower.startswith("data:image/png"):
        return "png"
    if lower.startswith("data:image/gif"):
        return "gif"
    if lower.startswith("data:image/bmp"):
        return "bmp"
    if lower.startswith("data:image/jpeg") or lower.startswith("data:image/jpg"):
        return "jpg"
    return Path(lower).suffix.lower().lstrip(".") or "png"


def image_payload(source: str, base_dir: Path) -> tuple[bytes, str] | None:
    if source.startswith("data:"):
        header, _, encoded = source.partition(",")
        try:
            data = base64.b64decode(encoded)
        except Exception:
            return None
        return data, image_relationship_type(header)
    path = (base_dir / source).resolve() if not re.match(r"^https?://", source.lower()) else None
    if path is None or not path.is_file():
        return None
    try:
        data = path.read_bytes()
    except Exception:
        return None
    return data, image_relationship_type(str(path))


def make_image_paragraph(
    alt: str,
    source: str,
    base_dir: Path,
    content_width: int,
    media: list[tuple[str, bytes, str]],
    rels_root: ET.Element,
    content_types_root: ET.Element,
    existing_media_names: set[str],
) -> ET.Element:
    payload = image_payload(source, base_dir)
    if payload is None:
        return make_paragraph(f"[图片加载失败: {source}]")
    data, extension = payload
    index = 1
    while f"word/media/image{index}.{extension}" in existing_media_names:
        index += 1
    part_name = f"word/media/image{index}.{extension}"
    existing_media_names.add(part_name)
    media.append((part_name, data, extension))

    rel_id = f"rIdImage{len(media)}"
    relationship = ET.SubElement(rels_root, f"{{{REL_NS}}}Relationship")
    relationship.attrib.update(
        {
            "Id": rel_id,
            "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
            "Target": f"media/image{index}.{extension}",
        }
    )
    default = content_types_root.find(f"{{{CT_NS}}}Default[@Extension='{extension}']")
    if default is None:
        default = ET.SubElement(content_types_root, f"{{{CT_NS}}}Default")
        default.attrib["Extension"] = extension
        default.attrib["ContentType"] = f"image/{extension}"

    width_px, height_px = image_dimensions(data)
    max_width_px = max(1, content_width * 96 // 1440)
    scale = min(1.0, max_width_px / width_px)
    width_emu = max(1, int(width_px * scale * 9525))
    height_emu = max(1, int(height_px * scale * 9525))
    paragraph = ET.Element(qn("w", "p"))
    run = ET.SubElement(paragraph, qn("w", "r"))
    drawing = ET.SubElement(run, qn("w", "drawing"))
    inline = ET.SubElement(drawing, f"{{{WP_NS}}}inline")
    extent = ET.SubElement(inline, f"{{{WP_NS}}}extent")
    extent.attrib.update({"cx": str(width_emu), "cy": str(height_emu)})
    docpr = ET.SubElement(inline, f"{{{WP_NS}}}docPr")
    docpr.attrib.update({"id": str(len(media)), "name": alt or f"image{len(media)}"})
    graphic = ET.SubElement(inline, f"{{{A_NS}}}graphic")
    graphicdata = ET.SubElement(graphic, f"{{{A_NS}}}graphicData")
    graphicdata.attrib["uri"] = "http://schemas.openxmlformats.org/drawingml/2006/picture"
    pic = ET.SubElement(graphicdata, f"{{{PIC_NS}}}pic")
    blipfill = ET.SubElement(pic, f"{{{PIC_NS}}}blipFill")
    blip = ET.SubElement(blipfill, f"{{{A_NS}}}blip")
    blip.attrib[f"{{{R_NS}}}embed"] = rel_id
    spPr = ET.SubElement(pic, f"{{{PIC_NS}}}spPr")
    xfrm = ET.SubElement(spPr, f"{{{A_NS}}}xfrm")
    off = ET.SubElement(xfrm, f"{{{A_NS}}}off")
    off.attrib.update({"x": "0", "y": "0"})
    ext = ET.SubElement(xfrm, f"{{{A_NS}}}ext")
    ext.attrib.update({"cx": str(width_emu), "cy": str(height_emu)})
    prstgeom = ET.SubElement(spPr, f"{{{A_NS}}}prstGeom")
    prstgeom.attrib["prst"] = "rect"
    ET.SubElement(prstgeom, f"{{{A_NS}}}avLst")
    return paragraph


def calculate_table_column_widths(rows: list[list[str]], content_width: int) -> list[int]:
    column_count = max((len(row) for row in rows), default=1)
    if column_count <= 1:
        return [max(1, content_width)]
    column_lengths = []
    for index in range(column_count):
        lengths = [len(row[index]) for row in rows if index < len(row)]
        column_lengths.append(max(lengths or [1]))
    weights = [log1p(max(1, length)) for length in column_lengths]
    total_weight = sum(weights)
    minimum_width = max(1, min(700, content_width // 12))
    maximum_width = max(minimum_width, int(content_width * 0.58))
    widths = [
        max(minimum_width, min(maximum_width, int(content_width * weight / total_weight)))
        for weight in weights
    ]
    difference = content_width - sum(widths)
    if difference:
        widest_index = max(range(len(widths)), key=lambda index: widths[index])
        widths[widest_index] = max(minimum_width, widths[widest_index] + difference)
    return widths


def make_cell_paragraphs(
    cell_text: str,
    style_id: str | None,
    template: dict[str, Any],
    allow_list_numbering: bool,
) -> list[ET.Element]:
    segments = [segment.strip() for segment in re.split(r"<br\s*/?\s*>", cell_text, flags=re.IGNORECASE)]
    if not segments:
        segments = [""]
    if not allow_list_numbering:
        return [make_paragraph(segment, style_id) for segment in segments]
    numbered_segments = [split_ordered_prefix(segment) for segment in segments]
    if not any(parsed is not None for parsed in numbered_segments):
        return [make_paragraph(segment, style_id) for segment in segments]

    num_id = ensure_list_numbering(template, ordered=True, restart=True)
    paragraphs = []
    for segment, parsed in zip(segments, numbered_segments):
        if parsed is None:
            paragraphs.append(make_paragraph(segment, style_id))
            continue
        body, _prefix = parsed
        paragraphs.append(make_numbered_paragraph(body, style_id, num_id))
    return paragraphs


def make_table(table: dict[str, Any], template: dict[str, Any], style_id: str | None, content_width: int) -> ET.Element:
    element = ET.Element(qn("w", "tbl"))
    tblpr = ET.SubElement(element, qn("w", "tblPr"))
    if style_id:
        tblstyle = ET.SubElement(tblpr, qn("w", "tblStyle"))
        tblstyle.attrib[qn("w", "val")] = style_id
    tblw = ET.SubElement(tblpr, qn("w", "tblW"))
    tblw.attrib.update({"w": str(content_width), "type": "dxa"})
    grid = ET.SubElement(element, qn("w", "tblGrid"))
    column_widths = calculate_table_column_widths(table["rows"], content_width)
    for column_width in column_widths:
        gridcol = ET.SubElement(grid, qn("w", "gridCol"))
        gridcol.attrib[qn("w", "w")] = str(column_width)
    for row_index, row in enumerate(table["rows"]):
        tr = ET.SubElement(element, qn("w", "tr"))
        if row_index == 0 and table["has_header"]:
            trpr = ET.SubElement(tr, qn("w", "trPr"))
            ET.SubElement(trpr, qn("w", "tblHeader"))
        for cell_index, cell_text in enumerate(row):
            tc = ET.SubElement(tr, qn("w", "tc"))
            tcpr = ET.SubElement(tc, qn("w", "tcPr"))
            tcw = ET.SubElement(tcpr, qn("w", "tcW"))
            tcw.attrib.update({"w": str(column_widths[cell_index]), "type": "dxa"})
            for paragraph in make_cell_paragraphs(
                cell_text,
                template["styles"].get("Normal", {}).get("id"),
                template,
                allow_list_numbering=not (row_index == 0 and table["has_header"]),
            ):
                tc.append(paragraph)
    return element


def build_document_xml(
    blocks: list[dict[str, Any]],
    template: dict[str, Any],
    base_dir: Path,
    media: list[tuple[str, bytes, str]],
    rels_root: ET.Element,
    content_types_root: ET.Element,
    render_warnings: list[str] | None = None,
) -> ET.Element:
    document = ET.Element(qn("w", "document"))
    body = ET.SubElement(document, qn("w", "body"))
    existing_media = {name for name, _, _ in media}
    warnings_ref = render_warnings if render_warnings is not None else []
    heading_mapping, use_title_mapping = determine_heading_mapping(blocks)
    if use_title_mapping and not template["title_styles"]:
        heading_mapping = {level: level for level in heading_mapping}
    for block in blocks:
        if block["type"] == "heading":
            level = block["level"]
            mapped_level = heading_mapping[level]
            style_id = template["headings"][mapped_level]
            if level == 1 and use_title_mapping:
                title_style_id = template["title_styles"][0] if template["title_styles"] else style_id
                body.append(make_title_paragraph(block["title"], title_style_id, template["title_styles"] == []))
            else:
                body.append(make_paragraph(block["title"], style_id))
        elif block["type"] == "paragraph":
            body.append(make_paragraph(block["text"], template["styles"].get("Normal", {}).get("id"), warnings=warnings_ref))
        elif block["type"] == "list":
            style_id = template["list_styles"][0] if template["list_styles"] else template["styles"].get("Normal", {}).get("id")
            num_id = ensure_list_numbering(template, ordered=block["ordered"], restart=block["ordered"])
            for item in block["items"]:
                body.append(make_numbered_paragraph(item["text"], style_id, num_id, warnings=warnings_ref))
        elif block["type"] == "table":
            body.append(make_table(block, template, template["table_styles"][0] if template["table_styles"] else None, template["content_width"]))
        elif block["type"] == "image":
            body.append(
                make_image_paragraph(
                    block["alt"],
                    block["src"],
                    base_dir,
                    template["content_width"],
                    media,
                    rels_root,
                    content_types_root,
                    existing_media,
                )
            )
        elif block["type"] == "hr":
            # 模板感知：模板定义了水平线样式才渲染；未定义则跳过，不输出任何段落
            if template.get("hr_styles"):
                body.append(make_hr_paragraph(template["hr_styles"][0]))
            continue
        elif block["type"] == "quote":
            style_id = template["quote_styles"][0] if template["quote_styles"] else template["styles"].get("Normal", {}).get("id")
            if not template["quote_styles"]:
                downgrade_msg = "模板缺少 Quote 样式，引用块已降级为正文样式"
                if downgrade_msg not in warnings_ref:
                    warnings_ref.append(downgrade_msg)
            body.append(make_paragraph(block["text"], style_id, warnings=warnings_ref))
        elif block["type"] == "code":
            style_id = template["code_styles"][0] if template["code_styles"] else template["styles"].get("Normal", {}).get("id")
            # 代码块内容不做行内解析，避免命令中的 * ` 等字符被误处理
            global inline_parsing_enabled
            saved = inline_parsing_enabled
            inline_parsing_enabled = False
            try:
                for line in block["text"].splitlines() or [""]:
                    body.append(make_paragraph(line, style_id))
            finally:
                inline_parsing_enabled = saved
    if template["sectpr"] is not None:
        body.append(template["sectpr"])
    return document


def count_elements(document_root: ET.Element) -> dict[str, int]:
    counts = defaultdict(int)
    for element in document_root.iter():
        counts[strip_ns(element.tag)] += 1
    return {
        "paragraphs": counts["p"],
        "tables": counts["tbl"],
        "images": counts["blip"],
        "headings": counts["pStyle"],
    }


def write_docx(
    output_path: Path,
    template_path: Path,
    document_root: ET.Element,
    styles_root: ET.Element,
    numbering_root: ET.Element | None,
    rels_root: ET.Element,
    content_types_root: ET.Element,
    media: list[tuple[str, bytes, str]],
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    entries, _ = load_docx(template_path)
    replacements = {
        "word/document.xml": serialize_xml(document_root).encode("utf-8"),
        "word/styles.xml": serialize_xml(styles_root).encode("utf-8"),
        **({"word/numbering.xml": serialize_xml(numbering_root).encode("utf-8")} if numbering_root is not None else {}),
        "word/_rels/document.xml.rels": serialize_xml(rels_root).encode("utf-8"),
        "[Content_Types].xml": serialize_xml(content_types_root).encode("utf-8"),
    }
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            if name in replacements:
                archive.writestr(name, replacements[name])
            else:
                archive.writestr(name, data)
        for name, data, _extension in media:
            archive.writestr(name, data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Markdown input path")
    parser.add_argument("output", type=Path, nargs="?", help="DOCX output path")
    parser.add_argument("--template", type=Path, help="Word template path")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite the output DOCX")
    parser.add_argument("--json", action="store_true", help="Print a JSON result report")
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent.parent
    input_path = args.input.resolve()
    if not input_path.is_file():
        raise ConversionError(f"Markdown 文件不存在：{input_path}")
    template_path = (args.template or skill_dir / "templates" / "default.docx").resolve()
    output_path = (args.output or input_path.with_suffix(".docx")).resolve()
    if output_path.exists() and not args.overwrite:
        raise ConfirmationRequired(f"输出文件已存在：{output_path}。请确认是否覆盖。")

    markdown = input_path.read_text(encoding="utf-8-sig")
    normalized_markdown, number_hints, markdown_warnings = normalize_markdown(markdown)
    standardized_path = input_path.with_suffix(".standardized.md")
    standardized_written = False
    if normalized_markdown != markdown:
        standardized_path.write_text(normalized_markdown, encoding="utf-8")
        standardized_written = True

    blocks = parse_markdown(normalized_markdown)
    markdown_headings = {block["level"] for block in blocks if block["type"] == "heading"}
    template = analyze_template(template_path, markdown_headings)
    update_styles_numbering(
        template["trees"]["word/styles.xml"],
        template["headings"],
        template["heading_numbering"],
    )
    rels_root = template["trees"].get(
        "word/_rels/document.xml.rels", ET.Element(f"{{{REL_NS}}}Relationships")
    )
    content_types_root = template["trees"].get(
        "[Content_Types].xml", ET.Element(f"{{{CT_NS}}}Types")
    )
    media: list[tuple[str, bytes, str]] = []
    render_warnings: list[str] = []
    document_root = build_document_xml(
        blocks,
        template,
        input_path.parent,
        media,
        rels_root,
        content_types_root,
        render_warnings=render_warnings,
    )
    missing_images = [
        block["src"]
        for block in blocks
        if block["type"] == "image" and image_payload(block["src"], input_path.parent) is None
    ]
    all_warnings = markdown_warnings + template.get("template_completions", []) + render_warnings
    write_docx(
        output_path,
        template_path,
        document_root,
        template["trees"]["word/styles.xml"],
        template["trees"].get("word/numbering.xml"),
        rels_root,
        content_types_root,
        media,
    )
    counts = count_elements(document_root)
    result = {
        "input": str(input_path),
        "output": str(output_path),
        "template": str(template_path),
        "standardized": str(standardized_path) if standardized_written else None,
        "number_hints": number_hints,
        "warnings": all_warnings,
        "missing_images": missing_images,
        "counts": counts,
        "numbering_source": {str(level): info["source"] for level, info in template["heading_numbering"].items()},
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Markdown 结构已检查并标准化。")
        print(f"已使用 Word 模板：{template_path}")
        print("章节编号已按模板规则处理。")
        print(f"Word 文档已生成并完成基础检查：{output_path}")
        if all_warnings:
            print("需要确认：")
            for warning in all_warnings:
                print(f"- {warning}")
        if missing_images:
            print("图片问题：")
            for source in missing_images:
                print(f"- 图片缺失：{source}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConfirmationRequired as error:
        print(f"需要用户确认：{error}", file=sys.stderr)
        raise SystemExit(2)
    except ConversionError as error:
        print(f"转换失败：{error}", file=sys.stderr)
        raise SystemExit(1)
