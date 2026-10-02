#!/usr/bin/env python
"""
把 Cubism 模型的纹理降采样到指定尺寸，并同步改 model3.json 的纹理路径。

⚠️ 为什么不能"直接 resize"（我第一版就是这么写的，踩了坑）：
   很多纹理会**在全透明像素里存垃圾 RGB**（本模型 355 万个透明像素里
   355 万个 RGB 非零）。直通 alpha 下四通道独立重采样，会把那些垃圾颜色
   插值进**有 alpha 的边缘像素** → 角色四周出现黑边/彩边。

   正确顺序：**预乘 alpha → 重采样 → 反预乘**
     · 预乘会把全透明像素的 RGB 归零（A=0 ⇒ RGB=0），垃圾自然消失
     · 线性重采样在预乘空间下才是数学正确的
     · 反预乘回直通 alpha，与原图的 alpha 约定保持一致

要点：
  · LANCZOS 重采样
  · 输出保持**直通 alpha 且全透明像素 RGB 归零**（与原始素材一致）
  · 目录名带尺寸（Cyrene.8192），降采样后同步改名并更新 model3.json
  · 幂等：已是目标尺寸则跳过

用法：
  python tools/downsample-texture.py <模型文件夹> [目标尺寸=2048]
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Windows 控制台默认是 GBK，直接 print emoji/中文会抛 UnicodeEncodeError。
# 本脚本曾在最后一行 print 时崩溃（而 JSON 已经写完了 —— 险），这里强制 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def resize_straight_alpha(im: Image.Image, target: int) -> Image.Image:
    """把直通 alpha 的图正确重采样到 target×target。

    预乘 → LANCZOS → 反预乘。返回直通 alpha 的图（透明像素 RGB=0）。
    """
    arr = np.asarray(im.convert("RGBA")).astype(np.float32)
    alpha = arr[..., 3:4] / 255.0

    # ① 预乘：A=0 的像素 RGB 自动变 0，垃圾颜色在这一步被清除
    premul = arr.copy()
    premul[..., :3] *= alpha

    # ② 在预乘空间重采样（线性滤波在此空间才是正确的）
    small = np.asarray(
        Image.fromarray(premul.round().clip(0, 255).astype(np.uint8), "RGBA").resize(
            (target, target), Image.LANCZOS
        )
    ).astype(np.float32)

    # ③ 反预乘回直通 alpha
    sa = small[..., 3:4] / 255.0
    out = np.zeros_like(small)
    np.divide(small[..., :3], sa, out=out[..., :3], where=sa > 0)
    out[..., :3] = np.clip(out[..., :3], 0, 255)
    out[..., 3:4] = small[..., 3:4]
    # 全透明像素 RGB 强制归零
    out[sa[..., 0] == 0, :3] = 0
    return Image.fromarray(out.round().clip(0, 255).astype(np.uint8), "RGBA")


def fringe_stats(im: Image.Image) -> tuple[int, int]:
    """返回（全透明像素数，其中 RGB 非零的数量）"""
    arr = np.asarray(im.convert("RGBA"))
    a = arr[..., 3]
    transparent = int((a == 0).sum())
    bad = int(((a == 0) & (arr[..., :3].max(axis=2) > 0)).sum())
    return transparent, bad


def main() -> int:
    if len(sys.argv) < 2:
        print("用法：python tools/downsample-texture.py <模型文件夹> [目标尺寸=2048]")
        return 1

    model_dir = Path(sys.argv[1]).resolve()
    target = int(sys.argv[2]) if len(sys.argv) > 2 else 2048

    model3_path = next(model_dir.glob("*.model3.json"), None)
    if model3_path is None:
        print("❌ 没找到 *.model3.json")
        return 1

    data = json.loads(model3_path.read_text(encoding="utf-8"))
    textures = data.get("FileReferences", {}).get("Textures", [])
    if not textures:
        print("❌ 清单里没有纹理引用")
        return 1

    changed = False
    for idx, rel in enumerate(textures):
        src = model_dir / rel
        if not src.exists():
            print(f"⚠️  缺失，跳过：{rel}")
            continue

        with Image.open(src) as im:
            w, h = im.size
            if w <= target and h <= target:
                print(f"· {rel} 已是 {w}×{h}，无需降采样")
                continue

            before = src.stat().st_size
            t_before, bad_before = fringe_stats(im)
            new = resize_straight_alpha(im, target)
            t_after, bad_after = fringe_stats(new)

            new_dir_name = f"{model_dir.name}.{target}"
            new_dir = model_dir / new_dir_name
            new_dir.mkdir(exist_ok=True)
            dst = new_dir / src.name
            new.save(dst, format="PNG", optimize=True)
            after = dst.stat().st_size

            print(f"· {rel}: {w}×{h} ({before/1048576:.1f} MB) → {target}×{target} ({after/1048576:.1f} MB)")
            print(f"  透明像素 RGB 残留：{bad_before}/{t_before} → {bad_after}/{t_after}")
            print(f"  重采样方式：预乘 → LANCZOS → 反预乘（避免透明区垃圾颜色污染边缘）")

            if src.parent != model_dir and src.parent.name.startswith(f"{model_dir.name}."):
                shutil.rmtree(src.parent, ignore_errors=True)
                print(f"  已删除旧目录 {src.parent.name}/")

            textures[idx] = f"{new_dir_name}/{src.name}"
            changed = True

    if changed:
        model3_path.write_text(json.dumps(data, ensure_ascii=False, indent="\t") + "\n", encoding="utf-8")
        print(f"\n[OK] 已更新 {model3_path.name} 的纹理路径：{textures}")
    else:
        print("\n[OK] 无需改动")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
