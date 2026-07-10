"""
batch_process.py
raw_images/ の PNG を一括処理: 背景透明化 + LINE仕様リサイズ → processed_images/ へ出力。
"""

import sys
from pathlib import Path
from PIL import Image, ImageEnhance

try:
    from rembg import remove as rembg_remove
    REMBG_AVAILABLE = True
except ImportError:
    REMBG_AVAILABLE = False
    print("⚠️  rembg が未インストールです。`pip install rembg` を実行してください。")

from config import RAW_IMAGES_DIR, PROCESSED_IMAGES_DIR, STICKER_SIZE, FRAME_SIZE, MAX_FILE_SIZE_KB


def remove_background(img: Image.Image) -> Image.Image:
    """コントラスト強調後に背景除去。rembg が使えない場合は元画像を返す。"""
    if not REMBG_AVAILABLE:
        return img.convert("RGBA")

    # コントラスト調整で背景除去精度を上げる
    enhanced = ImageEnhance.Contrast(img.convert("RGBA")).enhance(1.5)
    return rembg_remove(enhanced)


def resize_to_line_spec(
    img: Image.Image,
    size: int = STICKER_SIZE,
    frame: int = FRAME_SIZE,
) -> Image.Image:
    """
    LINE仕様: 512×512 の透明キャンバス中央にコンテンツを配置。
    余白 frame px を四辺に確保する。
    """
    content_max = size - 2 * frame
    thumbnail = img.copy()
    thumbnail.thumbnail((content_max, content_max), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    offset_x = (size - thumbnail.width) // 2
    offset_y = (size - thumbnail.height) // 2
    canvas.paste(thumbnail, (offset_x, offset_y), thumbnail)
    return canvas


def check_file_size(path: Path, limit_kb: int = MAX_FILE_SIZE_KB) -> bool:
    """ファイルサイズが LINE 制限内かチェック。"""
    size_kb = path.stat().st_size / 1024
    if size_kb > limit_kb:
        print(f"  ⚠️  {size_kb:.1f}KB > {limit_kb}KB (LINE制限超過)")
        return False
    return True


def process_sticker_images(
    input_dir: str | Path = RAW_IMAGES_DIR,
    output_dir: str | Path = PROCESSED_IMAGES_DIR,
) -> int:
    """
    入力フォルダの PNG を全件処理して出力フォルダへ保存する。
    処理済み件数を返す。
    """
    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    png_files = list(input_path.glob("*.png"))
    if not png_files:
        print(f"⚠️  {input_path} に PNG ファイルが見つかりません。")
        return 0

    processed = 0
    for img_file in png_files:
        try:
            print(f"⏳ 処理中: {img_file.name}...", end=" ", flush=True)

            img = Image.open(img_file).convert("RGBA")
            img_no_bg = remove_background(img)
            final_img = resize_to_line_spec(img_no_bg)

            out_file = output_path / img_file.name
            final_img.save(out_file, "PNG")

            size_kb = out_file.stat().st_size / 1024
            size_ok = check_file_size(out_file)
            status = "✅" if size_ok else "⚠️ "
            print(f"{status} {size_kb:.1f}KB")
            processed += 1

        except Exception as e:
            print(f"❌ エラー: {e}")

    print(f"\n✨ 完了: {processed}/{len(png_files)} 枚処理 → {output_path}")
    return processed


if __name__ == "__main__":
    input_dir = sys.argv[1] if len(sys.argv) > 1 else RAW_IMAGES_DIR
    output_dir = sys.argv[2] if len(sys.argv) > 2 else PROCESSED_IMAGES_DIR
    process_sticker_images(input_dir, output_dir)
