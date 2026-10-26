# -*- coding: utf-8 -*-
"""Generate the marketplace assets (icon + preview screenshots) for the Comments plugin."""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"
OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BG = (238, 240, 244)
WHITE = (255, 255, 255)
INK = (31, 35, 41)
SOFT = (107, 114, 128)
LINE = (231, 233, 238)
AMBER = (242, 201, 76)
APP_BG = (235, 236, 240)  # SiYuan window chrome, used to complete the 4:3 preview frame
AMBER_SOFT = (253, 246, 227)
AMBER_EDGE = (240, 220, 168)
AMBER_INK = (138, 109, 31)
GREEN_BG = (220, 252, 231)
GREEN_INK = (22, 101, 52)
PILL = (243, 244, 246)


def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, max(6, int(size)))


def tw(d, s, f):
    return d.textlength(s, font=f)


def wrap(d, s, f, maxw):
    lines, cur = [], ""
    for ch in s:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if tw(d, cur + ch, f) > maxw and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def text(d, x, y, s, size, color=INK, bold=False):
    d.text((x, y), s, font=font(size, bold), fill=color)


def para(d, x, y, s, size, maxw, color=INK, bold=False, lh=None):
    f = font(size, bold)
    lh = lh or size * 1.75
    for i, line in enumerate(wrap(d, s, f, maxw)):
        d.text((x, y + i * lh), line, font=f, fill=color)
    return y + len(wrap(d, s, f, maxw)) * lh


def card(img, box, radius, fill=WHITE, outline=None, shadow=True):
    d = ImageDraw.Draw(img, "RGBA")
    if shadow:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle((box[0] + 3, box[1] + 6, box[2] + 3, box[3] + 8), radius, fill=(15, 23, 42, 34))
        img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(9)))
    d.rounded_rectangle(box, radius, fill=fill, outline=outline, width=1 if outline else 0)


def pill(d, x, y, label, size=11, fill=PILL, color=SOFT, pad=9, h=None):
    f = font(size)
    w = tw(d, label, f) + pad * 2
    h = h or size + 13
    d.rounded_rectangle((x, y, x + w, y + h), h / 2, fill=fill)
    d.text((x + pad, y + (h - size * 1.35) / 2), label, font=f, fill=color)
    return w


def dot(d, cx, cy, r, fill):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)


def avatar(d, x, y, name, size=19):
    d.ellipse((x, y, x + size, y + size), fill=(253, 230, 138))
    f = font(size * 0.62, True)
    w = tw(d, name, f)
    d.text((x + (size - w) / 2, y + size * 0.17), name, font=f, fill=(146, 100, 12))


def commented(d, x, y, s, size, maxw, lh=None):
    """A sentence the plugin has commented on: just the yellow underline below the text."""
    f = font(size)
    lh = lh or size * 1.75
    for i, line in enumerate(wrap(d, s, f, maxw)):
        w = tw(d, line, f)
        yy = y + i * lh
        d.text((x, yy), line, font=f, fill=INK)
        d.rounded_rectangle((x, yy + size * 1.48, x + w, yy + size * 1.48 + 3), 2, fill=AMBER)
    return y + len(wrap(d, s, f, maxw)) * lh


def topbar(img, title):
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle((0, 0, img.size[0], 52), fill=WHITE)
    d.line((0, 52, img.size[0], 52), fill=LINE)
    dot(d, 30, 26, 7, (255, 95, 87))
    dot(d, 54, 26, 7, (254, 188, 46))
    dot(d, 78, 26, 7, (40, 200, 64))
    text(d, 110, 16, title, 14, SOFT)


def document(img, box, title, meta, body, bullets, commented_lines, footer):
    card(img, box, 14)
    d = ImageDraw.Draw(img, "RGBA")
    x = box[0] + 48
    y = box[1] + 42
    text(d, x, y, title, 33, (17, 24, 39), True)
    y += 50
    text(d, x, y, meta, 13.5, (156, 163, 175))
    y += 46
    maxw = box[2] - x - 48
    y = para(d, x, y, body[0], 16.5, maxw, (55, 65, 81)) + 12
    y = commented(d, x, y, commented_lines[0], 16.5, maxw) + 22
    y = para(d, x, y, body[1], 16.5, maxw, (55, 65, 81)) + 24
    for b in bullets:
        d.rounded_rectangle((x + 2, y + 8, x + 8, y + 14), 3, fill=AMBER)
        f = font(16)
        d.text((x + 22, y), b, font=f, fill=(55, 65, 81))
        y += 34
    y += 10
    y = commented(d, x, y, commented_lines[1], 16.5, maxw) + 26
    text(d, x, box[3] - 46, footer, 12.5, (156, 163, 175))
    return y


def comment_card(img, box, quote, body, author, when, actions, replies=None, resolved=False, edit_box=False):
    card(img, box, 10, fill=(246, 247, 249) if resolved else AMBER_SOFT,
         outline=(226, 232, 240) if resolved else AMBER_EDGE, shadow=False)
    d = ImageDraw.Draw(img, "RGBA")
    x0, y0, x1, y1 = box
    pad = 13
    x = x0 + pad
    w = x1 - x0 - pad * 2
    y = y0 + pad
    # identity first, exactly like the panel: avatar + name + time, then the quote
    avatar(d, x, y, author[0])
    text(d, x + 25, y + 2, author, 11.5, INK, True)
    text(d, x + 25 + tw(d, author, font(11.5, True)) + 8, y + 2, when, 11.5, (148, 163, 184))
    if resolved:
        pill(d, x1 - pad - 52, y - 1, "已解决", 10, GREEN_BG, GREEN_INK, pad=8, h=19)
    else:
        pill(d, x1 - pad - 66, y - 1, "解决并隐藏", 10, PILL, SOFT, pad=8, h=19)
    y += 26
    d.rounded_rectangle((x, y + 2, x + 3, y + 15), 2, fill=AMBER if not resolved else (203, 213, 225))
    text(d, x + 10, y, quote, 11, SOFT if not resolved else (148, 163, 184))
    y += 28
    f = font(13)
    for line in wrap(d, body, f, w):
        d.text((x, y), line, font=f, fill=(31, 41, 55) if not resolved else (120, 128, 140))
        y += 22
    y += 6
    if resolved:
        text(d, x, y, "已解决，重新打开后可继续回复", 11, (148, 163, 184))
        return
    ay = y
    for a in actions:
        ay_used = pill(d, x if not actions else x, ay, a, 10.5)
        x = x + ay_used + 6
    x = x0 + pad
    y = ay + 26
    if replies:
        d.rounded_rectangle((x, y, x + 2, y + 96), 1, fill=(226, 232, 240))
        rx = x + 14
        rw = x1 - pad - rx
        chip = "回复 @" + replies[0]
        cw = pill(d, rx, y, chip, 10.5, (255, 255, 255), AMBER_INK, pad=8, h=19)
        text(d, rx + cw + 6, y + 2, replies[1], 11, (148, 163, 184))
        y += 26
        f2 = font(12)
        for line in wrap(d, replies[2], f2, rw):
            d.text((rx, y), line, font=f2, fill=(55, 65, 81))
            y += 20
        y += 6
        if edit_box:
            d.rounded_rectangle((rx, y, rx + rw, y + 54), 6, fill=WHITE, outline=AMBER, width=1)
            f3 = font(12)
            d.text((rx + 9, y + 9), replies[3], font=f3, fill=(107, 114, 128))
            d.line((rx + 12 + tw(d, replies[3], f3), y + 8, rx + 12 + tw(d, replies[3], f3), y + 26), fill=(31, 35, 41))
            by = y + 60
            bw = pill(d, rx, by, "取消", 10.5, PILL, SOFT)
            pill(d, rx + bw + 6, by, "保存", 10.5, (59, 130, 246), WHITE)
        else:
            d.rounded_rectangle((rx, y, rx + rw, y + 28), 6, outline=(203, 213, 225), width=1, fill=(255, 255, 255, 120))
            text(d, rx + 9, y + 7, "回复…", 11.5, (156, 163, 175))
    else:
        d.rounded_rectangle((x, y, x + w, y + 28), 6, outline=(203, 213, 225), width=1, fill=(255, 255, 255, 120))
        text(d, x + 9, y + 7, "回复…", 11.5, (156, 163, 175))


def panel(img, box):
    card(img, box, 14)
    d = ImageDraw.Draw(img, "RGBA")
    x0, y0, x1, y1 = box
    pad = 18
    x = x0 + pad
    text(d, x, y0 + 22, "评论", 16, INK, True)
    bx = x1 - pad
    for label in ["刷新", "署名", "首条评论"]:
        w = tw(d, label, font(10.5)) + 16
        bx -= w
        pill(d, bx, y0 + 22, label, 10.5)
        bx -= 6
    d.line((x0, y0 + 56, x1, y0 + 56), fill=LINE)
    w = x1 - x0 - pad * 2
    y = y0 + 74
    comment_card(img, (x, y, x + w, y + 316),
                 "评审结论以文档为准，所有讨论都要落到具体的句子旁边",
                 "「以文档为准」建议补一句例外：会上口头确认的结论，也要回写到文档，否则下次评审又会重复讨论。",
                 "李四", "12 分钟前", ["回复", "定位", "编辑", "删除"],
                 replies=["李四", "王五 · 3 分钟前", "同意，我把口头结论也补进去，稍后同步给你。"])
    y += 332
    comment_card(img, (x, y, x + w, y + 196),
                 "评论会跟着文档一起同步、一起分享",
                 "确认过了，评论存在文档属性里，不会新建文件，也不会改正文。",
                 "张三", "今天 14:02", ["回复", "定位", "编辑", "删除"])
    y += 212
    comment_card(img, (x, y, x + w, y + 124),
                 "点击评论可以跳转到对应句子",
                 "已实现，并在原文下划线处闪一下提示位置。",
                 "李四", "昨天 18:20", [], resolved=True)
    pill(d, x, y1 - pad - 26, "显示已解决 (2)", 10.5, PILL, SOFT, pad=10, h=22)


def preview_doc(img):
    document(img, (24, 72, 1160, 968),
             "产品需求评审（2026 Q1）",
             "最后编辑：今天 14:02 · 负责人 张三",
             ["本期目标是把「文档内评论」打通到所有共享工作空间：审阅人可以直接在正文上标注，作者不必再在聊天窗口里逐条对照。",
              "为了降低沟通成本，我们把评论挂在块上，而不是新建一份「评审记录」文档——这样评论会跟着文档一起同步、一起分享，也不会污染正文内容。"],
             ["支持回复与对回复的再回复，回复也可以编辑和删除",
              "每条评论都可以「解决并隐藏」，之后可随时取消解决",
              "点击评论卡片或「定位」，正文会跳到对应句子"],
             ["评审结论以文档为准，所有讨论都要落到具体的句子旁边。",
              "评论只保存在文档属性 custom-comments 里，不写入正文。"],
             "第 1 页 · 共 3 页")
    panel(img, (1184, 72, 1576, 968))


def make_icon():
    S, W = 4, 512
    img = Image.new("RGBA", (W * S, W * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    # warm gradient background, rounded like a marketplace icon
    grad = Image.new("RGBA", (W * S, W * S))
    gd = ImageDraw.Draw(grad)
    for i in range(W * S):
        t = i / (W * S - 1)
        gd.line((0, i, W * S, i), fill=(int(255 - 15 * t), int(216 - 24 * t), int(115 - 40 * t), 255))
    mask = Image.new("L", (W * S, W * S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W * S - 1, W * S - 1), 112 * S, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img, "RGBA")
    # speech bubble with three dots (the dock icon) above a comment underline
    d.rounded_rectangle((136 * S, 138 * S, 376 * S, 322 * S), 46 * S, fill=(255, 255, 255, 255))
    d.polygon([(168 * S, 316 * S), (216 * S, 316 * S), (170 * S, 372 * S)], fill=(255, 255, 255, 255))
    for i in range(3):
        dot(d, (206 + i * 50) * S, 230 * S, 15 * S, (240, 169, 58, 255))
    d.rounded_rectangle((136 * S, 404 * S, 376 * S, 420 * S), 8 * S, fill=(255, 255, 255, 225))
    # the marketplace asks for 160*160; draw at 512-space and downsample for crispness
    img.resize((160, 160), Image.LANCZOS).save(os.path.join(OUT, "icon.png"), optimize=True)


def main():
    make_icon()
    # every helper draws in final-image coordinates, so the canvas matches 1:1
    S = 1
    W, H = 1600, 1000
    img = Image.new("RGBA", (W * S, H * S), BG + (255,))
    topbar(img, "产品需求评审（2026 Q1）— 思源笔记 · 评论")
    preview_doc(img)
    # the card renders the preview with background-size: cover and the spec recommends
    # 1024*768, so ship that 4:3 frame with the whole shot centred and fully visible
    shot = img.resize((1024, 640), Image.LANCZOS).convert("RGB")
    frame = Image.new("RGB", (1024, 768), BG)
    frame.paste(shot, (0, 64))
    frame.save(os.path.join(OUT, "preview.png"), optimize=True)

    # detail shot: what a thread looks like while replying / after resolving
    W2, H2 = 1600, 900
    img2 = Image.new("RGBA", (W2 * S, H2 * S), BG + (255,))
    d = ImageDraw.Draw(img2, "RGBA")
    text(d, 40, 30, "回复、编辑、解决：一条评论线程的完整状态", 22, INK, True)
    card(img2, (40, 78, 900, 840), 14)
    dd = ImageDraw.Draw(img2, "RGBA")
    x, y = 84, 122
    text(dd, x, y, "评论挂在被引用的句子上，随文档保存", 15, SOFT)
    y += 42
    y = para(dd, x, y, "评审结论以文档为准，所有讨论都要落到具体的句子旁边。", 21, 760, (55, 65, 81), lh=38) + 6
    commented(dd, x, y, "评论存在文档属性里，不写入正文，也不新建文件。", 21, 760)
    y += 52
    text(dd, x, y, "点「定位」→ 正文滚到这句，下划线闪一下：", 15, SOFT)
    y += 34
    d2 = ImageDraw.Draw(img2, "RGBA")
    d2.rounded_rectangle((x - 5, y - 3, x + 404, y + 34), 6, fill=(242, 201, 76, 62))
    d2.rounded_rectangle((x, y + 30, x + 400, y + 35), 2, fill=AMBER)
    dd.text((x, y), "评论存在文档属性 custom-comments 里。", font=font(21), fill=INK)
    text(dd, x, y + 74, "普通状态是 2px 下划线，跳转时 1.6 秒的高亮脉冲（上图放大示意）。", 14, (148, 163, 184))
    table = [["选中文字评论", "浮动工具栏 → 评论"], ["回复与再回复", "显示「回复 @某人」，可编辑/删除"],
             ["解决并隐藏", "线程关闭，取消解决即可继续"], ["排序", "按引用文字在文档中的顺序"],
             ["署名", "只存在本机浏览器，不是账号体系"], ["删除保护", "删除带回复的评论会二次确认"]]
    ty = y + 132
    for row in table:
        dd.rounded_rectangle((x, ty, x + 250, ty + 38), 8, fill=PILL)
        dd.text((x + 14, ty + 9), row[0], font=font(15, True), fill=INK)
        dd.text((x + 270, ty + 10), row[1], font=font(14.5), fill=SOFT)
        ty += 50
    panel(img2, (940, 78, 1560, 840))
    img2.resize((W2, H2), Image.LANCZOS).convert("RGB").save(os.path.join(OUT, "preview-detail.png"), optimize=True)
    if USE_REAL_SCREENSHOTS and from_screenshots():
        print("using the real screenshots")
    for name in ["icon.png", "preview.png", "preview-detail.png"]:
        p = os.path.join(OUT, name)
        print(name, os.path.getsize(p), "bytes", Image.open(p).size)


# The author's real screenshots are kept as an option, but at listing size the drawn
# mock reads better: it is composed for the card, while a window grab has to be
# downscaled. Set this to True to use the screenshots in SHOTS instead.
USE_REAL_SCREENSHOTS = False

SHOTS = {
    # real screenshots, dropped in by the author; used when present
    "preview": r"D:\AAAAAAlearn\AILAB\siyuan\preview-raw.png",
    "detail": r"D:\AAAAAAlearn\AILAB\siyuan\detail-raw.png",
}


def from_screenshots():
    """Replace the drawn mock with the real screenshots when they exist.

    The marketplace paints the preview with background-size: cover in a 4:3 card, and
    the shot is 3:2, so the document card's left padding is trimmed and the frame is
    completed with the app background colour: cropping to 4:3 instead would eat into
    the comment panel on the right.
    """
    if not all(os.path.exists(p) for p in SHOTS.values()):
        return False
    raw = Image.open(SHOTS["preview"]).convert("RGB")
    # trim the window border and the document card's left padding only; the extra
    # height a 4:3 frame needs goes above the tab bar, where it is the same colour
    shot = raw.crop((100, 2, raw.size[0], raw.size[1]))
    tw = shot.size[0]
    th = int(round(tw * 3 / 4))
    frame = Image.new("RGB", (tw, th), APP_BG)
    frame.paste(shot, (0, th - shot.size[1]))
    frame.resize((1024, 768), Image.LANCZOS).save(os.path.join(OUT, "preview.png"), optimize=True)

    bar = Image.open(SHOTS["detail"]).convert("RGB")
    canvas = Image.new("RGB", (1024, 260), APP_BG)
    card(canvas, (48, 34, 976, 166), 12, fill=WHITE, shadow=False)
    canvas.paste(bar, (60, 34 + (132 - bar.size[1]) // 2))
    text(ImageDraw.Draw(canvas, "RGBA"), 60, 192, "选中正文后出现的浮动工具栏", 14, SOFT)
    canvas.save(os.path.join(OUT, "preview-detail.png"), optimize=True)
    return True


def publish_names():
    """The bazaar links images as /plugins/<name>/<file>?v=<install time>, and that query
    never changes when a file is replaced. A versioned file name is therefore the only
    reliable cache buster, so every packaged image is also written under its version."""
    import json
    import re
    import shutil

    with open(os.path.join(OUT, "plugin.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    version = manifest["version"]
    for stale in os.listdir(OUT):
        m = re.match(r"^(icon|preview|preview-detail)-([0-9.]+)\.png$", stale)
        if m and m.group(2) != version:
            os.remove(os.path.join(OUT, stale))
    for base in ["icon", "preview", "preview-detail"]:
        src = os.path.join(OUT, base + ".png")
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(OUT, "%s-%s.png" % (base, version)))
    manifest["icon"] = "icon-%s.png" % version
    manifest["preview"] = "preview-%s.png" % version
    with open(os.path.join(OUT, "plugin.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    for readme in ["README.md", "README.zh-CN.md", "README.zh_CN.md"]:
        target = os.path.join(OUT, readme)
        if not os.path.exists(target):
            continue
        body = open(target, encoding="utf-8").read()
        for base in ["preview-detail", "preview", "icon"]:
            # relative paths: the kernel rewrites them to /plugins/<name>/..., and the
            # online marketplace resolves them from package.zip / the release
            body = re.sub(r"(?:/plugins/team-comment/)?%s(?:-[0-9.]+)?\.png" % base,
                          "%s-%s.png" % (base, version), body)
        open(target, "w", encoding="utf-8").write(body)
    print("versioned assets:" + version)


main()
publish_names()
