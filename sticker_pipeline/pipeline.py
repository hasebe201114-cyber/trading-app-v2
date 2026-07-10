"""
pipeline.py
LINEスタンプ生成パイプラインのエントリーポイント。
各ステップを順番に実行する。
"""

import sys
import argparse
from pathlib import Path

# src/ をパスに追加
sys.path.insert(0, str(Path(__file__).parent / "src"))

from generate_prompts import generate_prompts, save_prompts
from batch_process import process_sticker_images
from metadata_gen import generate_sticker_set
from validate import run_validation
from config import RAW_IMAGES_DIR, PROCESSED_IMAGES_DIR, STICKER_SETS_DIR


def step_prompts() -> None:
    """Step 1: Fooocus用プロンプト生成"""
    print("=" * 50)
    print("Step 1: プロンプト生成")
    print("=" * 50)
    prompts = generate_prompts()
    path = save_prompts(prompts)
    print(f"✅ {len(prompts)} 件 → {path}\n")


def step_process(input_dir: Path = RAW_IMAGES_DIR) -> None:
    """Step 2: 背景透明化 + リサイズ"""
    print("=" * 50)
    print("Step 2: 背景透明化 + リサイズ")
    print("=" * 50)
    count = process_sticker_images(input_dir, PROCESSED_IMAGES_DIR)
    print(f"✅ {count} 枚処理完了\n")


def step_validate() -> bool:
    """Step 3: LINE仕様チェック"""
    print("=" * 50)
    print("Step 3: LINE仕様チェック")
    print("=" * 50)
    ok = run_validation(PROCESSED_IMAGES_DIR)
    print()
    return ok


def step_metadata(set_name: str = "set_01") -> None:
    """Step 4: LINE申請用セット作成"""
    print("=" * 50)
    print("Step 4: 申請用セット作成")
    print("=" * 50)
    set_dir = generate_sticker_set(
        PROCESSED_IMAGES_DIR, STICKER_SETS_DIR, set_name
    )
    print(f"✅ セット → {set_dir}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="LINEスタンプ生成パイプライン")
    parser.add_argument(
        "step",
        nargs="?",
        choices=["prompts", "process", "validate", "metadata", "all"],
        default="all",
        help="実行するステップ (default: all)",
    )
    parser.add_argument("--set-name", default="set_01", help="スタンプセット名")
    parser.add_argument(
        "--input",
        default=str(RAW_IMAGES_DIR),
        help="raw_images フォルダ (process ステップ用)",
    )
    args = parser.parse_args()

    if args.step in ("prompts", "all"):
        step_prompts()

    if args.step in ("process", "all"):
        step_process(Path(args.input))

    if args.step in ("validate", "all"):
        ok = step_validate()
        if args.step == "validate":
            sys.exit(0 if ok else 1)

    if args.step in ("metadata", "all"):
        step_metadata(args.set_name)

    if args.step == "all":
        print("🎉 全ステップ完了！sticker_sets/ を確認してください。")


if __name__ == "__main__":
    main()
