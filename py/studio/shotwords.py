"""
FILE: py/studio/shotwords.py
PURPOSE: "What to film" in Japanese that still finds footage. The library's picture search (OpenCLIP) reads English
         only, so a shot typed in Japanese ("窓際のカフェのテーブル") found little. Each Japanese shot gets an English
         search form, made when the theme is saved and kept beside it (themes.json `shotsEn`); searches use the English
         form and the page shows the words as typed.
OVERVIEW: to_english() makes the search forms: the project's AI writing service when it has a key (studio.research._llm:
          the llm block, its backups and the daily budget), else (and for any line the AI did not answer) a built-in
          Japanese-to-English glossary of common filming words, so it works with no key and offline. search_form() is
          the glossary alone (fast, free): what the library search uses for a Japanese query typed in the search box.
          shown() gives the words to show for a shot in the page's language (the starter shots have Japanese words).
DEPENDENCIES: studio.research (only when the AI is asked)
USAGE: to_english(["窓際のカフェのテーブル", "a cup of coffee"]) -> ["table cafe by a window", "a cup of coffee"]
NOTES: The glossary reads Japanese as written: longest word first, "の" joins a modifier to its head, so the parts
       come out head first ("カフェのテーブル" -> "table cafe"). CLIP reads such a phrase well enough; the AI writes
       a proper one when it is there.
"""
from __future__ import annotations

import json
import re
import unicodedata

_JA = re.compile(r"[぀-ヿ㐀-鿿ｦ-ﾟ]")

# Common filming words, Japanese -> English (what a business films: the place, food and drink, people at work, nature,
# light and time of day, camera words). Longer entries win over the shorter ones inside them.
GLOSSARY: dict[str, str] = {
    # the place
    "外観": "the building from outside", "建物": "building", "入口": "entrance", "入り口": "entrance", "玄関": "front door",
    "看板": "shop sign", "のれん": "noren curtain", "暖簾": "noren curtain", "店内": "inside the shop", "店先": "shop front",
    "店": "shop", "お店": "shop", "カフェ": "cafe", "喫茶店": "cafe", "レストラン": "restaurant", "食堂": "diner",
    "パン屋": "bakery", "ベーカリー": "bakery", "宿": "inn", "旅館": "japanese inn", "民宿": "guesthouse", "ゲストハウス": "guesthouse",
    "ホテル": "hotel", "客室": "guest room", "部屋": "room", "寝室": "bedroom", "ベッド": "bed", "布団": "futon", "畳": "tatami",
    "和室": "japanese room", "温泉": "hot spring", "お風呂": "bath", "風呂": "bath", "露天風呂": "outdoor bath", "ロビー": "lobby",
    "受付": "reception desk", "フロント": "front desk", "キッチン": "kitchen", "厨房": "kitchen", "カウンター": "counter",
    "テーブル": "table", "席": "seats", "椅子": "chair", "ソファ": "sofa", "窓際": "by a window", "窓": "window", "棚": "shelf",
    "商品": "products", "品物": "goods", "陳列": "display", "レジ": "cash register", "店員": "shop staff", "スタッフ": "staff",
    "キャンプ場": "campsite", "キャンプ": "camping", "テント": "tent", "焚き火": "campfire", "たき火": "campfire", "薪": "firewood",
    "炎": "flames", "火": "fire", "サウナ": "sauna", "デッキ": "wooden deck", "テラス": "terrace", "庭": "garden", "駐車場": "parking lot",
    "車": "car", "自転車": "bicycle", "道": "road", "通り": "street", "街": "town street", "駅": "station", "看板メニュー": "signature dish",
    # food and drink
    "料理": "dish of food", "ご飯": "rice", "ごはん": "meal", "朝ごはん": "breakfast", "朝食": "breakfast", "昼ごはん": "lunch",
    "ランチ": "lunch", "夕食": "dinner", "ディナー": "dinner", "定食": "set meal", "メニュー": "menu", "パン": "bread",
    "焼きたて": "freshly baked", "ケーキ": "cake", "スイーツ": "sweets", "お菓子": "sweets", "デザート": "dessert", "クッキー": "cookies",
    "コーヒー": "coffee", "珈琲": "coffee", "紅茶": "tea", "お茶": "tea", "抹茶": "matcha tea", "ラテ": "latte", "カップ": "cup",
    "湯気": "steam", "豆": "beans", "焙煎": "roasting", "ビール": "beer", "ワイン": "wine", "グラス": "glass", "お酒": "sake", "酒": "sake",
    "野菜": "vegetables", "果物": "fruit", "フルーツ": "fruit", "肉": "meat", "魚": "fish", "寿司": "sushi", "ラーメン": "ramen",
    "スープ": "soup", "ピザ": "pizza", "皿": "plate", "お皿": "plate", "器": "dish", "生地": "dough", "オーブン": "oven", "窯": "oven",
    "鍋": "pot", "フライパン": "frying pan", "包丁": "kitchen knife", "まな板": "cutting board", "食材": "ingredients",
    # people and work
    "手元": "hands at work", "手": "hands", "シェフ": "chef", "料理人": "cook", "職人": "craftsman", "店主": "owner", "お客さん": "customers",
    "お客様": "guests", "客": "customers", "人": "people", "家族": "family", "子ども": "children", "子供": "children", "笑顔": "smiling faces",
    "犬": "dog", "猫": "cat", "作業": "work", "仕事": "work", "接客": "serving customers", "乾杯": "a toast with glasses",
    "注ぐ": "pouring", "注い": "pouring", "焼く": "baking", "焼い": "baking", "焼き": "grilling", "切る": "cutting", "切っ": "cutting",
    "こねる": "kneading", "こね": "kneading", "盛り付け": "plating food", "運ぶ": "carrying", "歩く": "walking", "歩い": "walking",
    "座る": "sitting", "食べる": "eating", "食べ": "eating", "飲む": "drinking", "飲み": "drinking", "作る": "making", "作っ": "making",
    "掃除": "cleaning", "準備": "preparing", "到着": "arriving", "出迎え": "welcoming guests", "チェックイン": "check-in",
    "包む": "wrapping", "ラッピング": "gift wrapping", "並べる": "arranging", "開店": "opening the shop", "閉店": "closing time",
    # nature, light and time
    "景色": "scenery", "風景": "landscape", "眺め": "view", "山": "mountains", "海": "sea", "川": "river", "湖": "lake", "森": "forest",
    "木": "trees", "花": "flowers", "桜": "cherry blossoms", "紅葉": "autumn leaves", "雪": "snow", "雨": "rain", "空": "sky", "雲": "clouds",
    "星空": "starry sky", "星": "stars", "月": "moon", "太陽": "sun", "朝日": "sunrise", "日の出": "sunrise", "夕日": "sunset",
    "夕焼け": "sunset glow", "日没": "sunset", "朝": "morning", "昼": "daytime", "夕方": "evening", "夜": "night", "夜景": "night view",
    "光": "light", "灯り": "warm lights", "明かり": "lights", "ライト": "lights", "ろうそく": "candle", "影": "shadows",
    "春": "spring", "夏": "summer", "秋": "autumn", "冬": "winter", "草": "grass", "芝生": "lawn", "畑": "farm field", "田んぼ": "rice field",
    "水": "water", "波": "waves", "砂浜": "sandy beach", "ビーチ": "beach", "霧": "mist",
    # camera words
    "ドローン": "drone view", "空撮": "aerial view", "上から": "from above", "俯瞰": "overhead view", "全景": "wide view",
    "広角": "wide shot", "引き": "wide shot", "寄り": "close-up", "アップ": "close-up", "クローズアップ": "close-up",
    "ゆっくり": "slow", "スローモーション": "slow motion", "タイムラプス": "time-lapse", "動画": "video", "写真": "photo",
    "正面": "front view", "横から": "side view", "後ろ姿": "from behind", "大きい": "large", "小さい": "small", "古い": "old",
    "新しい": "new", "木製": "wooden", "白い": "white", "赤い": "red", "青い": "blue", "緑": "green",
}
_KEYS = sorted(GLOSSARY, key=len, reverse=True)
_JOIN = "の"


def has_ja(text: str | None) -> bool:
    return bool(_JA.search(str(text or "")))


def glossary_en(text: str) -> str | None:
    """The English search form of a Japanese shot from the glossary alone, or None when no word is known."""
    t = unicodedata.normalize("NFKC", str(text or "")).strip()
    groups: list[list[str]] = [[]]
    i = 0
    while i < len(t):
        hit = next((k for k in _KEYS if t.startswith(k, i)), None)
        if hit:
            groups[-1].append(GLOSSARY[hit])
            i += len(hit)
            continue
        if t[i] == _JOIN:  # "AのB": B is the thing, A says which one
            groups.append([])
        elif t[i].isascii() and t[i].isalnum():  # an English word or a number typed in the line ("1階", "DJI")
            m = re.match(r"[A-Za-z0-9][A-Za-z0-9'-]*", t[i:])
            groups[-1].append(m.group(0).lower())
            i += len(m.group(0))
            continue
        i += 1
    words: list[str] = []
    for g in reversed([g for g in groups if g]):
        for w in g:
            if not words or words[-1] != w:
                words.append(w)
    return " ".join(words)[:120] or None


def search_form(text: str) -> str:
    """What the picture search reads for a shot or a query: English as typed; Japanese through the glossary (the words
    as typed when the glossary knows none of them)."""
    s = str(text or "").strip()
    return (glossary_en(s) or s) if has_ja(s) else s


_SYSTEM = ("You turn short Japanese notes about what to film into plain English phrases for a picture search engine "
           "(CLIP). Keep each one short and concrete, like 'a cup of coffee on a wooden table' or 'hands kneading dough'. "
           "Never add things the note does not say. Answer JSON only: {\"shots\": [\"...\"]}, one phrase per note, in order.")


def _ai_english(lines: list[str]) -> list[str | None]:
    """The AI's English for each line, or None per line it did not answer (no key, over budget, failing, odd reply)."""
    from studio import research

    try:
        got = research._llm(_SYSTEM, json.dumps({"notes": lines}, ensure_ascii=False), purpose="shot words", max_tokens=400)
    except Exception:  # noqa: BLE001 - the glossary stands in for any failure
        got = None
    out = got.get("shots") if isinstance(got, dict) else None
    if not isinstance(out, list) or len(out) != len(lines):
        return [None] * len(lines)
    clean = []
    for x in out:
        s = re.sub(r"\s+", " ", str(x or "")).strip()[:120]
        clean.append(s if s and not has_ja(s) else None)
    return clean


def to_english(shots: list[str], ai: bool = True) -> list[str]:
    """The search form of each shot: English as typed; Japanese through the AI when `ai` and a key are there, else the
    glossary."""
    shots = [str(s or "").strip() for s in shots]
    ja = [i for i, s in enumerate(shots) if has_ja(s)]
    ai_out = _ai_english([shots[i] for i in ja]) if ai and ja else [None] * len(ja)
    out = list(shots)
    for i, got in zip(ja, ai_out):
        out[i] = got or search_form(shots[i])
    return out
