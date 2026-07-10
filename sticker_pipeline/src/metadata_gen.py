"""
metadata_gen.py
processed_images/ の PNG を読み込み、LINE申請用メタデータ JSON と
sticker_sets/ への整理コピーを行う。
"""

import json
import shutil
from pathlib import Path
from PIL import Image

from config import (
    PROCESSED_IMAGES_DIR,
    STICKER_SETS_DIR,
    STICKER_METADATA,
    MIN_STICKER_COUNT,
    MAX_FILE_SIZE_KB,
    STICKER_SIZE,
)


def validate_sticker(img_path: Path) -> list[str]:
    """LINE仕様チェック。問題があればエラーメッセージのリストを返す。"""
    errors = []

    # ファイルサイズ
    size_kb = img_path.stat().st_size / 1024
    if size_kb > MAX_FILE_SIZE_KB:
        errors.append(f"ファイルサイズ超過: {size_kb:.1f}KB > {MAX_FILE_SIZE_KB}KB")

    # 画像チェック
    try:
        img = Image.open(img_path)
        if img.mode != "RGBA":
            errors.append(f"カラーモード不正: {img.mode} (RGBA が必要)")
        if img.size != (STICKER_SIZE, STICKER_SIZE):
            errors.append(f"サイズ不正: {img.size} ({STICKER_SIZE}×{STICKER_SIZE} が必要)")

        # アルファ最小値が 0 でないと透明部分がない
        extrema = img.getextrema()
        alpha_min = extrema[3][0] if len(extrema) >= 4 else None
        if alpha_min is not None and alpha_min > 0:
            errors.append(f"背景が完全透明でない可能性: alpha_min={alpha_min}")
    except Exception as e:
        errors.append(f"画像読込エラー: {e}")

    return errors


def build_metadata(sticker_files: list[Path]) -> dict:
    """sticker_files からメタデータ辞書を構築する。"""
    stickers = []
    for idx, f in enumerate(sticker_files, start=1):
        stickers.append({
            "id": idx,
            "filename": f.name,
            "text": f.stem.replace("sticker_", "").replace("_", " ").title(),
        })

    return {
        **STICKER_METADATA,
        "sticker_count": len(stickers),
        "stickers": stickers,
    }


def generate_sticker_set(
    input_dir: str | Path = PROCESSED_IMAGES_DIR,
    output_dir: str | Path = STICKER_SETS_DIR,
    set_name: str = "set_01",
) -> Path:
    """
    processed_images/ の PNG を sticker_sets/<set_name>/ にコピーし
    metadata.json を生成する。生成したセットフォルダのパスを返す。
    """
    input_path = Path(input_dir)
    set_dir = Path(output_dir) / set_name
    set_dir.mkdir(parents=True, exist_ok=True)

    png_files = sorted(input_path.glob("*.png"))
    if not png_files:
        print(f"⚠️  {input_path} に PNG ファイルが見つかりません。")
        return set_dir

    print(f"📦 {len(png_files)} 枚を検証・コピー → {set_dir}")

    valid_files: list[Path] = []
    for f in png_files:
        errors = validate_sticker(f)
        if errors:
            print(f"  ❌ {f.name}: {'; '.join(errors)}")
        else:
            shutil.copy2(f, set_dir / f.name)
            valid_files.append(set_dir / f.name)
            print(f"  ✅ {f.name}")

    if len(valid_files) < MIN_STICKER_COUNT:
        print(
            f"\n⚠️  有効スタンプ {len(valid_files)} 枚 < LINE最小要件 {MIN_STICKER_COUNT} 枚。"
            " 追加生成してください。"
        )
    else:
        print(f"\n✅ LINE申請可能: {len(valid_files)} 枚")

    # メタデータ生成
    metadata = build_metadata(valid_files)
    metadata_path = set_dir / "metadata.json"
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    print(f"📄 メタデータ → {metadata_path}")
    return set_dir


if __name__ == "__main__":
    generate_sticker_set()
