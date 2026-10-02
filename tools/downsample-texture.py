#!/usr/bin/env python
"""
把 Cubism 模型的纹理降采样到指定尺寸，并同步改 model3.json 的纹理路径。

为什么需要：很多模型的纹理是 8192×8192，但桌宠显示尺寸只有 250px 左右 ——
纹理超标 30 倍，白吃显存和加载时间。降到 2048 仍有 8 倍余量。

要点：
  · 用 LANCZOS 重采样（RGBA 四通道独立处理；Cubism 纹理为预乘 alpha，
    线性重采样在预乘空间下是正确的，不会产生黑边）
  · 全透明像素的 RGB 归零，避免边缘杂色
  · 目录名带尺寸（Cyrene.8192），降采样后同步改名并更新 model3.json

用法：
  python tools/downsample-texture.py <模型文件夹> [目标尺寸=2048]
"""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

# Windows 控制台默认是 GBK，直接 print emoji/中文会抛 UnicodeEncodeError。
# 本脚本曾在最后一行 print 时崩溃（而 JSON 已经写完了 —— 险），这里强制 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


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
            im = im.convert("RGBA")
            new = im.resize((target, target), Image.LANCZOS)

            # 全透明像素 RGB 归零
            px = new.load()
            for y in range(new.height):
                for x in range(new.width):
                    r, g, b, a = px[x, y]
                    if a == 0 and (r or g or b):
                        px[x, y] = (0, 0, 0, 0)

            # 新目录名把尺寸标出来
            new_dir_name = f"{model_dir.name}.{target}"
            new_dir = model_dir / new_dir_name
            new_dir.mkdir(exist_ok=True)
            dst = new_dir / src.name
            new.save(dst, format="PNG", optimize=True)
            after = dst.stat().st_size

            print(f"· {rel}: {w}×{h} ({before/1048576:.1f} MB) → {target}×{target} ({after/1048576:.1f} MB)")

            # 删掉旧纹理目录（若是带尺寸后缀的独立目录）
            if src.parent != model_dir and src.parent.name.startswith(f"{model_dir.name}."):
                shutil.rmtree(src.parent, ignore_errors=True)
                print(f"  已删除旧目录 {src.parent.name}/")

            textures[idx] = f"{new_dir_name}/{src.name}"
            changed = True

    if changed:
        model3_path.write_text(json.dumps(data, ensure_ascii=False, indent="\t") + "\n", encoding="utf-8")
        print(f"\n✅ 已更新 {model3_path.name} 的纹理路径：{textures}")
    else:
        print("\n✅ 无需改动")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
