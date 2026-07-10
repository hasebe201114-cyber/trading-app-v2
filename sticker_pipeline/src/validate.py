"""
validate.py
生成済みスタンプ画像の LINE 仕様を一括チェックするユーティリティ。
metadata_gen.py の validate_sticker() を再利用し、結果をサマリ表示する。
"""

import sys
from pathlib import Path
from metadata_gen import validate_sticker
from config import PROCESSED_IMAGES_DIR, MIN_STICKER_COUNT


def run_validation(target_dir: str | Path = PROCESSED_IMAGES_DIR) -> bool:
    """
    target_dir 内の PNG を全件検証。
    全て合格かつ枚数が MIN_STICKER_COUNT 以上なら True を返す。
    """
    target = Path(target_dir)
    png_files = sorted(target.glob("*.png"))

    if not png_files:
        print(f"⚠️  {target} に PNG が見つかりません。")
        return False

    print(f"🔍 {len(png_files)} 枚を検証中...\n")

    passed = []
    failed = []
    for f in png_files:
        errors = validate_sticker(f)
        if errors:
            failed.append((f, errors))
            print(f"  ❌ {f.name}")
            for e in errors:
                print(f"     - {e}")
        else:
            passed.append(f)
            print(f"  ✅ {f.name}")

    print(f"\n--- 結果サマリ ---")
    print(f"  合格: {len(passed)} 枚 / 不合格: {len(failed)} 枚 / 合計: {len(png_files)} 枚")

    if len(passed) < MIN_STICKER_COUNT:
        print(f"  ⚠️  合格枚数 {len(passed)} 枚 < LINE最小要件 {MIN_STICKER_COUNT} 枚")
        return False

    print(f"  🎉 LINE申請OK ({len(passed)} 枚)")
    return len(failed) == 0


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else PROCESSED_IMAGES_DIR
    ok = run_validation(target)
    sys.exit(0 if ok else 1)
