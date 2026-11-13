"""
FILE: py/studio/assemble.py
PURPOSE: Propose a reel from the tagged library, so a person only vets and tweaks.
OVERVIEW: A theme is a set of plain-word searches (one per beat of the story) plus
          approved copy. For each slot the best unused, at-the-ranch match is
          taken (no repeated source, no faces or CLIP "people" unless allowed,
          photos at most 30%), laid on the research rhythm (1-2 s, one hold,
          0.5 s grid), and saved as a project the editor opens and `reels --build`
          renders. Each caption starts on the cut of its cue slot (theme["cues"]).
DEPENDENCIES: studio.library, studio.projects, studio.guard
USAGE: assemble(THEMES["office"], slug="office-1102") or python -m studio assemble office
NOTES: Copy comes only from the website SSOT or the approved channel copy in
       docs/marketing/SOCIAL_CHANNELS.md. The assembler never writes new claims.
       The themes below are the Tsumagoi workspace's (RANCH_THEMES). A project made in the studio has only its
       own themes, written by a person in the theme editor (<data>/themes.json, load_themes()); their words are
       approved by being typed there and pass the project's own guard.
"""
from __future__ import annotations

import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np

from studio.aesthetic import nudge
from studio.config import DATA, RANCH, SOURCE
from studio.guard import assert_copy
from studio.library import items
from studio.projects import save
from studio.staging import DAY_ORDER, mark_for, mark_kind, number_lines, staging

RHYTHM = [2.0, 1.5, 1.0, 1.5, 1.5, 1.0, 1.5, 2.0, 3.0]

# The long explainer (variant "b-explainer", shared/spec.json): LinkedIn and Facebook reward 40-60 s with a
# caption on every claim, watched with the sound off. Same theme, more proof: the theme's own slots plus
# venue shots, held longer, and the theme's lines plus venue facts already approved in the posts (no prices
# on screen: the copy guard still runs on every line).
LONG_RHYTHM = [3.5, 3.0, 3.5, 3.0, 3.5, 3.0, 3.5, 3.0, 3.5, 3.0, 3.5, 3.0, 3.5, 4.0]  # 46.5 s; photos (held 2 s at most) bring it to ~40
VENUE_SLOTS = [
    "a laptop on a desk for remote work", "the inside of a lounge room", "a wide view of an open grass field",
    "the outside of a wooden building with a blue roof", "a wide view of mountains and ridges at dusk",
]
VENUE_LINES = [
    ("line", "標高1,444m、\n100Mbpsの光回線。", "Fibre at 1,444 m."),
    ("line", "一般開放日は、\n1日5組まで。", "Open days: five groups at most."),
    ("line", "イベントは、\n50名まで。", "Events: up to 50 people."),
]


def long_theme(theme: dict) -> dict:
    """The theme stretched into a 40-60 s explainer: up to 14 slots and 7 caption lines, spread evenly."""
    slots = list(theme["slots"]) + [s for s in VENUE_SLOTS if s not in theme["slots"]]
    for k in range(len(LONG_RHYTHM) - len(slots)):  # still short: search the theme's lines again (a file is never used twice)
        slots.append(theme["slots"][1 + k % (len(theme["slots"]) - 1)])
    seen = {ja.replace("\n", "") for _, ja, _ in theme["beats"]}
    extra = [b for b in VENUE_LINES if b[1].replace("\n", "") not in seen and not any(b[1].split("\n")[0].rstrip("、") in s for s in seen)]
    return {**theme, "slots": slots[: len(LONG_RHYTHM)], "beats": (list(theme["beats"]) + extra)[:8], "cues": []}

THEMES = {
    "office": {
        "title_ja": "山で働く。冬でも、夜通しでも。",
        "slots": [
            "a wide view of mountains from a deck", "the outside of a wooden building with a blue roof", "a laptop on a desk for remote work",
            "the inside of a lounge room", "a view of mountains through a large window", "a wooden deck with tables and a railing",
            "a car parked next to a tent on grass", "bell tents on a field", "a wide view of mountains and ridges at dusk",
        ],
        "cues": [2, 4, 6],
        "beats": [
            ("hook", "山で働く。\n冬でも、夜通しでも。", "Work in the mountains. Even in winter. Even all night."),
            ("line", "標高1,444m、\n100Mbpsの光回線。", "Fibre at 1,444 m."),
            ("line", "窓の外に、\n建物はありません。", "No buildings outside the window."),
            ("line", "寝るのは、\n自分の車かテント。", "You sleep in your own car or a tent."),
        ],
        "posts": {
            "ja": "標高1,444m、100Mbpsの光回線。窓の外に建物はありません。\n山で働く。冬でも、夜通しでも。寝るのは、自分の車かテント。",
            "en": "Fibre at 1,444 m. No buildings outside the window.\nWork in the mountains. Even in winter. Even all night. You sleep in your own car or a tent.",
            "price_ja": "ぜんぶ込みキャンプ：大人1人目 ¥7,200／泊・2人目から1名 ¥4,200。シャワー・こたつラウンジ（24時間）・ジムまで込み。",
            "linkedin": "標高1,444m、100Mbpsの光回線。窓の外に建物はありません。\n山まるごとの貸切は一律料金です。〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。\n\n山で働く。冬でも、夜通しでも。チームの合宿を、この窓の前で。",
            "path": "reserve",
            "x": "標高1,444m、100Mbpsの光回線。窓の外に建物はありません。\n山で働く。冬でも、夜通しでも。",
            "zh": "在山上工作。冬天也行，通宵也行。\n海拔1,444米，100Mbps光纤网络，窗外没有建筑。\n睡在自己的车里或帐篷里。\n群马县嬬恋村・嬬恋牧场Work&Camp",
        },
        "tags": ["#tsumagoicamp", "#嬬恋", "#ワーケーション", "#光回線"],
        "yt_title": "標高1,444mの光回線で働く｜嬬恋牧場Work&Camp",
    },
    "carstay": {
        "title_ja": "車で来て、車で寝る。",
        "slots": [
            "an aerial drone view of a field with cars", "a van parked on grass", "a car parked in a parking lot with mountains",
            "a road or path through the hills", "a white van in an open field", "the outside of a wooden building with a blue roof",
            "a wide view of mountains and ridges", "an open grass field at dusk", "a wide view of an open grass field",
        ],
        "cues": [2, 5, 7],
        "beats": [
            ("hook", "車で来て、\n車で寝る。", "Come by car. Sleep in your car."),
            ("line", "大駐車場を、\n1晩5台まで。", "The big car park, five vehicles a night."),
            ("line", "トイレ・共用キッチン・\nWi-Fi込み。", "Toilets, the shared kitchen and Wi-Fi included."),
            ("line", "フィールドに灯りはありません。\nゆっくりお走りください。", "No lights on the field. Drive slowly after dark."),
        ],
        "posts": {
            "ja": "車で来て、車で寝る。それだけの日のために、大駐車場を1晩5台まで。\nトイレ・共用キッチン・冷蔵庫・Wi-Fi込みです。",
            "en": "Come by car, sleep in your car. The big car park, five vehicles a night.\nToilets, the shared kitchen, a fridge and Wi-Fi included.",
            "price_ja": "車中泊：1台 ¥3,500／泊（大人2名まで込み・3人目から1名 +¥1,000）。",
            "linkedin": "車で来て、車で寝る。それだけの日のために、大駐車場を1晩5台まで。\n山まるごとの貸切は一律料金です。〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。駐車は100台超。",
            "path": "reserve",
            "x": "車で来て、車で寝る。\n大駐車場を1晩5台まで。トイレ・共用キッチン・Wi-Fi込み。",
            "zh": "开车来，睡在车里。\n大停车场每晚最多5辆车，含厕所、共用厨房和Wi-Fi。\n群马县嬬恋村・嬬恋牧场Work&Camp",
        },
        "tags": ["#tsumagoicamp", "#車中泊", "#嬬恋", "#群馬"],
        "yt_title": "車中泊｜大駐車場を1晩5台まで｜嬬恋牧場Work&Camp",
    },
    "autumn": {
        "title_ja": "不便だからこそ、景色がいい。",
        "slots": [
            "autumn leaves in orange and red on mountains", "a wooden deck with a pizza oven and mountains", "an aerial drone view of autumn forest",
            "a road through an autumn forest", "a fire burning in a pizza oven", "a wooden deck facing a grass field",
            "an open grass field in autumn", "bell tents on a field in autumn", "a wide view of mountains and ridges",
        ],
        "cues": [2, 5],
        "beats": [
            ("hook", "不便だからこそ、\n景色がいい。", "Hard to reach. That is why the view is this good."),
            ("line", "いちばん近い民家まで、\n道のりで約10km。", "About 10 km by road to the nearest homes."),
            ("line", "デッキの前は草原、\nその先に山の尾根。", "In front of the deck: grassland, then the ridges."),
        ],
        "posts": None,
        "tags": ["#tsumagoicamp", "#嬬恋", "#紅葉", "#浅間山"],
        "yt_title": "紅葉の嬬恋｜標高1,444m｜嬬恋牧場Work&Camp",
    },
}

# More themes, every word from the website SSOT (src/constants/reversal-lines.ts,
# place-line.ts: REVERSAL_LINES, CORE_LINE, SLEEP_LINE, POSITIONING_PILLARS).
# "posts_from" borrows the approved channel copy (prices, LinkedIn text, path) of a house reel;
# "post" replaces the opening lines with this theme's own headline and proof.
THEMES.update({
    "fire": {
        "title_ja": "お店がないからこそ、同じ火を囲む。",
        "style": "centre",
        "slots": [
            "flames in a brick fire pit at night", "a wooden deck at dusk with mountains", "a kitchen counter with cooking",
            "food cooking on a grill over fire", "a pizza oven with fire inside", "a fire pit with chairs around it at night",
            "a wooden deck with tables and lights at night", "glowing embers of a campfire", "the outside of a wooden building at dusk",
        ],
        "cues": [2, 4, 6],
        "beats": [
            ("hook", "お店がないからこそ、\n同じ火を囲む。", "No restaurant. So you sit around one fire."),
            ("line", "レストランも\n店員もいません。", "No restaurant and no staff."),
            ("line", "共用キッチンで、\n自分で作って。", "You cook in the shared kitchen,"),
            ("line", "デッキの焚き火台へ。", "and bring it to the fire on the deck."),
        ],
        "posts_from": "fire",
        "tags": ["#tsumagoicamp", "#焚き火", "#嬬恋", "#キャンプ飯"],
        "yt_title": "お店がないからこそ、同じ火を囲む｜嬬恋牧場Work&Camp",
    },
    "field": {
        "title_ja": "区画がないからこそ、好きな場所に張れる。",
        "style": "lower",
        "slots": [
            "an aerial drone view of tents on a wide grass field", "a bell tent on grass", "a tent on a hill with mountains behind",
            "a wide open grass field on a hill", "tents and cars on a field from above", "a camping chair on grass",
            "a tent at dusk", "a grass field with mountain ridges", "a wide aerial view of a green field and forest",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "区画がないからこそ、\n好きな場所に張れる。", "No marked pitches. So you pitch wherever you like."),
            ("line", "区画のない、\nひとつの草原。", "One open field with no marked pitches."),
            ("line", "1日5組までだから、\nとなりのテントが近すぎない。", "At most 5 groups a night, so the next tent is never too close."),
        ],
        "posts_from": "field",
        "tags": ["#tsumagoicamp", "#フリーサイト", "#嬬恋", "#キャンプ"],
        "yt_title": "区画がないからこそ、好きな場所に張れる｜嬬恋牧場Work&Camp",
    },
    "warm": {
        "title_ja": "寒いからこそ、ぬくもりがうれしい。",
        "style": "split",
        "slots": [
            "an aerial view of snow covered hills", "a wooden building in snow", "snow on mountain ridges",
            "a warm lounge interior with wooden tables", "a laptop on a desk by a window", "frost and snow on trees",
            "a car parked in snow", "a snowy field at dusk", "an aerial view of a snowy forest and road",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "寒いからこそ、\nぬくもりがうれしい。", "Cold. That is why warmth feels this good."),
            ("line", "外は氷点下。\n中は、こたつと光回線。", "Below zero outside. A kotatsu and fibre inside."),
            ("line", "寝るのは、\n自分の車かテント。", "You sleep in your own car or a tent."),
        ],
        "posts_from": "winter",
        "post": {"ja": "寒いからこそ、ぬくもりがうれしい。\n冬の夜は氷点下。中は、こたつと光回線。寝るのは、自分の車かテント。",
                 "en": "Cold. That is why warmth feels this good.\nWinter nights go below zero. A kotatsu and fibre inside. You sleep in your own car or a tent.",
                 "x": "寒いからこそ、ぬくもりがうれしい。\n外は氷点下。中は、こたつと光回線。"},
        "tags": ["#tsumagoicamp", "#冬キャンプ", "#嬬恋", "#雪"],
        "yt_title": "寒いからこそ、ぬくもりがうれしい｜嬬恋牧場Work&Camp",
    },
    "loud": {
        "title_ja": "遠いからこそ、騒げる。",
        "style": "centre",
        "slots": [
            "an aerial view of a long road through a forest", "a remote building on a hill from above", "a wide open field with no houses",
            "a fire pit at night", "tents and cars on a field from above", "camping chairs around a fire",
            "a wooden deck with tables at night", "a field at dusk", "a wide aerial view of mountains and forest",
        ],
        "cues": [2, 5],
        "beats": [
            ("hook", "遠いからこそ、\n騒げる。", "Far away. So you can be loud."),
            ("line", "お隣さんまで、\n道のりで約10km。", "About 10 km by road to the nearest homes."),
            ("line", "22:00までは、\n笑い声も気にせずに。", "Laugh as loud as you like until 22:00."),
        ],
        "posts_from": "view",
        "post": {"ja": "遠いからこそ、騒げる。\nお隣さんまで道のりで約10km。22:00までは笑い声も気にせずに。全面貸切なら、静かにする時間はありません。",
                 "en": "Far away. So you can be loud.\nAbout 10 km by road to the nearest homes. Laugh as loud as you like until 22:00; on a whole-site charter there are no quiet hours.",
                 "x": "遠いからこそ、騒げる。\nお隣さんまで道のりで約10km。22:00までは笑い声も気にせずに。"},
        "tags": ["#tsumagoicamp", "#貸切", "#嬬恋", "#グループキャンプ"],
        "yt_title": "遠いからこそ、騒げる｜嬬恋牧場Work&Camp",
    },
    "lookup": {
        "title_ja": "暗いからこそ、上を向く。",
        "style": "lower",
        "slots": [
            "a field at dusk with a dark blue sky", "a sunset sky over mountain ridges", "a dramatic evening sky with clouds",
            "a dark field at night", "a campfire at night", "a tent glowing at night",
            "the silhouette of mountains at dusk", "a night sky over a field", "the last light over the mountains",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "暗いからこそ、\n上を向く。", "Dark at night. So you look up."),
            ("line", "夜のフィールドに\n照明はありません。", "The field has no lights at night."),
            ("line", "晴れた夜は、\n星もくっきり見えます。", "On a clear night, the stars are sharp."),
        ],
        "posts_from": "view",
        "post": {"ja": "暗いからこそ、上を向く。\n夜のフィールドに照明はありません。晴れた夜は、星もくっきり見えます。",
                 "en": "Dark at night. So you look up.\nThe field has no lights at night. On a clear night, the stars are sharp.",
                 "x": "暗いからこそ、上を向く。\n夜のフィールドに照明はありません。晴れた夜は、星もくっきり見えます。"},
        "tags": ["#tsumagoicamp", "#夜", "#嬬恋", "#キャンプ"],
        "yt_title": "暗いからこそ、上を向く｜嬬恋牧場Work&Camp",
    },
    "focus": {
        "title_ja": "山にこもって、どこまで進むか。",
        "style": "split",
        "slots": [
            "a laptop on a wooden desk with a mountain view", "mountains seen through a large window", "the inside of a quiet lounge",
            "a wide view of mountains from a deck", "a desk by a window", "a quiet forest",
            "the outside of a wooden building with a blue roof", "a cup of coffee on a table", "a wide view of mountains and ridges at dusk",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "山にこもって、\nどこまで進むか。", "Go up the mountain. See how far you get."),
            ("line", "標高1,444m、\n100Mbpsの光回線。", "Fibre at 1,444 m."),
            ("line", "寝るのは、\n自分の車かテント。", "You sleep in your own car or a tent."),
        ],
        "posts_from": "winter",
        "post": {"ja": "山にこもって、どこまで進むか。\n標高1,444m、100Mbpsの光回線。寝るのは、自分の車かテント。",
                 "en": "Go up the mountain. See how far you get.\nFibre at 1,444 m. You sleep in your own car or a tent.",
                 "x": "山にこもって、どこまで進むか。\n標高1,444m、100Mbpsの光回線。"},
        "tags": ["#tsumagoicamp", "#ワーケーション", "#嬬恋", "#集中"],
        "yt_title": "山にこもって、どこまで進むか｜嬬恋牧場Work&Camp",
    },
    "connect": {
        "title_ja": "仕事は浅く、つながりは深く。",
        "style": "column",
        "slots": [
            "a wooden deck with long tables and mountains", "a fire pit with chairs around it", "a long table with food outdoors",
            "tents together on a field", "a wide view from a deck at dusk", "a kitchen counter with cooking",
            "a group of tents and cars from above", "a deck with lights at night", "a wide view of mountains and ridges",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "仕事は浅く、\nつながりは深く。", "Work shallower. Connect deeper."),
            ("line", "東京の逆を、\n山で。", "The opposite of Tokyo."),
            ("line", "標高1,444m。", "1,444 m up."),
        ],
        "posts_from": "fire",
        "post": {"ja": "仕事は浅く、つながりは深く。東京の逆を、山で。\n標高1,444m。寝るのは、自分の車かテント。",
                 "en": "Work shallower. Connect deeper. The opposite of Tokyo.\n1,444 m up. You sleep in your own car or a tent.",
                 "x": "仕事は浅く、つながりは深く。東京の逆を、山で。"},
        "tags": ["#tsumagoicamp", "#オフサイト", "#チームビルディング", "#嬬恋"],
        "yt_title": "仕事は浅く、つながりは深く｜嬬恋牧場Work&Camp",
    },
    "aerial": {
        "title_ja": "不便だからこそ、景色がいい。",
        "style": "centre",
        "slots": [
            "an aerial drone view of mountain ridges", "an aerial view of a forest and a winding road", "an aerial view of a building on a green hill",
            "an aerial view of an open grass field", "an aerial view of tents on a field", "an aerial view of autumn forest",
            "an aerial view of clouds over mountains", "an aerial view of a field and forest edge", "a wide aerial view of mountains",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "不便だからこそ、\n景色がいい。", "Hard to reach. That is why the view is this good."),
            ("line", "標高1,444m。", "1,444 m up."),
            ("line", "いちばん近い民家まで、\n道のりで約10km。", "About 10 km by road to the nearest homes."),
        ],
        "posts_from": "view",
        "tags": ["#tsumagoicamp", "#ドローン", "#嬬恋", "#絶景"],
        "yt_title": "標高1,444mを空から｜嬬恋牧場Work&Camp",
    },
})
THEMES["aerial"]["device"] = ["dji"]
THEMES["warm"]["boost"] = {"season": "winter", "tags": ["snow"]}
THEMES["fire"]["boost"] = {"tags": ["fire", "night", "grill"]}
THEMES["lookup"]["boost"] = {"tags": ["night", "sunset", "sky"]}
THEMES["autumn"]["boost"] = {"season": "autumn", "tags": ["autumn"]}
THEMES["office"]["style"] = "column"
THEMES["carstay"]["style"] = "lower"
THEMES["autumn"]["style"] = "split"
THEMES["autumn"]["posts_from"] = "view"

# Recipe themes (2026-11-08, docs/research/2026-11-08-reel-effects.md): the same approved lines, staged
# differently. `look` and `recipe` are defaults (studio/staging.py, src/looks.tsx); `kicker` is a framing
# label, not a claim (guard-checked like every line); `loop` ends on the opening frame.
# `slot_season` (split pairs) prefers a season per slot; marks shown on screen come from each clip's data.
THEMES.update({
    "reasons": {
        "title_ja": "ここで働く、3つの理由。",
        "recipe": "countdown", "look": "punch", "style": "centre", "loop": True,
        "kicker": {"ja": "ここで働く、3つの理由。", "en": "Three reasons to work from here."},
        "slots": [
            "a wide view of mountains from a deck", "a laptop on a desk for remote work", "a laptop on a wooden desk with a mountain view",
            "mountains seen through a large window", "a view of mountains through a large window", "a wide open field with no houses",
            "a car parked next to a tent on grass", "bell tents on a field", "a wide view of mountains and ridges at dusk",
        ],
        "cues": [2, 4, 6],
        "beats": [
            ("hook", "山で働く。\n冬でも、夜通しでも。", "Work in the mountains. Even in winter. Even all night."),
            ("line", "標高1,444m、\n100Mbpsの光回線。", "Fibre at 1,444 m."),
            ("line", "窓の外に、\n建物はありません。", "No buildings outside the window."),
            ("line", "寝るのは、\n自分の車かテント。", "You sleep in your own car or a tent."),
        ],
        "posts_from": "winter",
        "post": {"ja": "山で働く。冬でも、夜通しでも。\n標高1,444m、100Mbpsの光回線。窓の外に建物はありません。寝るのは、自分の車かテント。",
                 "en": "Work in the mountains. Even in winter. Even all night.\nFibre at 1,444 m. No buildings outside the window. You sleep in your own car or a tent.",
                 "x": "山で働く。冬でも、夜通しでも。\n標高1,444m、100Mbpsの光回線。窓の外に建物はありません。"},
        "tags": ["#tsumagoicamp", "#ワーケーション", "#嬬恋", "#リモートワーク"],
        "yt_title": "ここで働く、3つの理由｜標高1,444mの光回線｜嬬恋牧場Work&Camp",
    },
    "day": {
        "title_ja": "山の一日。",
        "recipe": "timeline", "look": "film", "style": "centre", "loop": True,
        "kicker": {"ja": "山の一日。", "en": "One day on the mountain."},
        "slots": [
            "morning light over mountain ridges", "a cup of coffee on a wooden deck", "a laptop on a desk by a window",
            "a wide open grass field in sunshine", "a kitchen counter with cooking", "a sunset sky over mountain ridges",
            "a fire pit with chairs around it at dusk", "a tent glowing at night", "a campfire at night",
        ],
        "cues": [2, 4, 6],
        "beats": [
            ("hook", "山にこもって、\nどこまで進むか。", "Go up the mountain. See how far you get."),
            ("line", "標高1,444m、\n100Mbpsの光回線。", "Fibre at 1,444 m."),
            ("line", "共用キッチンで、\n自分で作って。", "You cook in the shared kitchen,"),
            ("line", "デッキの焚き火台へ。", "and bring it to the fire on the deck."),
        ],
        "posts_from": "fire",
        "post": {"ja": "山にこもって、どこまで進むか。\n標高1,444m、100Mbpsの光回線。共用キッチンで自分で作って、デッキの焚き火台へ。",
                 "en": "Go up the mountain. See how far you get.\nFibre at 1,444 m. You cook in the shared kitchen, and bring it to the fire on the deck.",
                 "x": "山にこもって、どこまで進むか。\n標高1,444m、100Mbpsの光回線。共用キッチンで自分で作って、デッキの焚き火台へ。"},
        "tags": ["#tsumagoicamp", "#ワーケーション", "#嬬恋", "#キャンプ"],
        "yt_title": "山の一日｜標高1,444mで働いて、火を囲む｜嬬恋牧場Work&Camp",
    },
    "seasons": {
        "title_ja": "不便だからこそ、景色がいい。（季節くらべ）",
        "look": "split", "style": "centre",
        "slots": [
            "green summer mountain ridges", "mountain ridges with autumn colours",
            "a wooden deck facing a green grass field", "a wooden deck in autumn",
            "an aerial view of a green field and forest", "an aerial view of autumn forest",
            "bell tents on a green field", "bell tents on a field in autumn",
            "a wide view of mountains and ridges at dusk",
        ],
        "slot_season": ["summer", "autumn", "summer", "autumn", "summer", "autumn", "summer", "autumn", None],
        "cues": [2, 6],
        "beats": [
            ("hook", "不便だからこそ、\n景色がいい。", "Hard to reach. That is why the view is this good."),
            ("line", "デッキの前は草原、\nその先に山の尾根。", "In front of the deck: grassland, then the ridges."),
            ("line", "標高1,444m。", "1,444 m up."),
        ],
        "posts_from": "view",
        "post": {"ja": "不便だからこそ、景色がいい。\nデッキの前は草原、その先に山の尾根。標高1,444m。",
                 "en": "Hard to reach. That is why the view is this good.\nIn front of the deck: grassland, then the ridges. 1,444 m up.",
                 "x": "不便だからこそ、景色がいい。\nデッキの前は草原、その先に山の尾根。"},
        "tags": ["#tsumagoicamp", "#嬬恋", "#紅葉", "#季節"],
        "yt_title": "夏と秋、同じ山｜標高1,444m｜嬬恋牧場Work&Camp",
    },
    "pov": {
        "title_ja": "POV：今日のデスク",
        "recipe": "pov", "look": "film", "style": "lower", "loop": True,
        "kicker": {"ja": "POV：今日のデスク", "en": "POV: your desk today"},
        "slots": [
            "a laptop on a desk by a window with mountains", "mountains seen through a large window", "a cup of coffee on a table",
            "the inside of a quiet lounge", "a wide view of mountains from a deck", "a laptop on a wooden desk with a mountain view",
            "a wooden deck with tables and a railing", "a quiet forest", "a wide view of mountains and ridges at dusk",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "窓の外に、\n建物はありません。", "No buildings outside the window."),
            ("line", "標高1,444m、\n100Mbpsの光回線。", "Fibre at 1,444 m."),
            ("line", "寝るのは、\n自分の車かテント。", "You sleep in your own car or a tent."),
        ],
        "posts_from": "winter",
        "post": {"ja": "窓の外に、建物はありません。\n標高1,444m、100Mbpsの光回線。寝るのは、自分の車かテント。",
                 "en": "No buildings outside the window.\nFibre at 1,444 m. You sleep in your own car or a tent.",
                 "x": "窓の外に、建物はありません。\n標高1,444m、100Mbpsの光回線。"},
        "tags": ["#tsumagoicamp", "#ワーケーション", "#嬬恋", "#POV"],
        "yt_title": "POV：今日のデスク｜標高1,444m｜嬬恋牧場Work&Camp",
    },
    "nightfire": {
        "title_ja": "お店がないからこそ、同じ火を囲む。（夜）",
        "look": "ember", "style": "split", "loop": True,
        "slots": [
            "flames in a fire pit at night", "glowing embers of a campfire", "a tent glowing at night",
            "a dark field at night", "a wooden deck with lights at night", "a fire pit with chairs around it at night",
            "the silhouette of mountains at dusk", "a night sky over a field", "a campfire at night",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "お店がないからこそ、\n同じ火を囲む。", "No restaurant. So you sit around one fire."),
            ("line", "夜のフィールドに\n照明はありません。", "The field has no lights at night."),
            ("line", "晴れた夜は、\n星もくっきり見えます。", "On a clear night, the stars are sharp."),
        ],
        "posts_from": "fire",
        "post": {"ja": "お店がないからこそ、同じ火を囲む。\n夜のフィールドに照明はありません。晴れた夜は、星もくっきり見えます。",
                 "en": "No restaurant. So you sit around one fire.\nThe field has no lights at night. On a clear night, the stars are sharp.",
                 "x": "お店がないからこそ、同じ火を囲む。\n夜のフィールドに照明はありません。"},
        "tags": ["#tsumagoicamp", "#焚き火", "#嬬恋", "#夜キャンプ"],
        "yt_title": "火を囲む夜｜嬬恋牧場Work&Camp",
    },
    "altitude": {
        "title_ja": "標高1,444m。",
        "recipe": "altitude", "look": "punch", "style": "centre", "loop": True,
        "slots": [
            "an aerial view of a forest and a winding road", "a road or path through the hills", "an aerial view of a building on a green hill",
            "an aerial drone view of mountain ridges", "a wide view of mountains from a deck", "an aerial view of clouds over mountains",
            "a wide open grass field on a hill", "a wide aerial view of mountains", "a wide view of mountains and ridges at dusk",
        ],
        "cues": [3, 6],
        "beats": [
            ("hook", "標高1,444m。", "1,444 m up."),
            ("line", "いちばん近い民家まで、\n道のりで約10km。", "About 10 km by road to the nearest homes."),
            ("line", "不便だからこそ、\n景色がいい。", "Hard to reach. That is why the view is this good."),
        ],
        "posts_from": "view",
        "post": {"ja": "標高1,444m。\nいちばん近い民家まで、道のりで約10km。不便だからこそ、景色がいい。",
                 "en": "1,444 m up.\nAbout 10 km by road to the nearest homes. Hard to reach. That is why the view is this good.",
                 "x": "標高1,444m。\nいちばん近い民家まで、道のりで約10km。不便だからこそ、景色がいい。"},
        "tags": ["#tsumagoicamp", "#嬬恋", "#絶景", "#ドローン"],
        "yt_title": "標高1,444m｜嬬恋牧場Work&Camp",
    },
})
THEMES["nightfire"]["boost"] = {"tags": ["fire", "night"]}

# ---------- the open project's themes ----------
# Everything above is the Tsumagoi workspace's. THEMES is what the open project makes reels from: those (main
# project only) plus the project's own from <data>/themes.json, written by the theme editor (POST /api/themes).
# It stays one dict object, so every `from studio.assemble import THEMES` sees an edit after load_themes().
RANCH_THEMES = dict(THEMES)
THEME_FILE = DATA / "themes.json"
THEME_KEY = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
HOUSE_KEYS = {"view", "fire", "field", "winter"}  # the house reels (studio.reels) own these names
THEME_STYLES = ("column", "centre", "lower", "split")
SHOTS_MIN, SHOTS_MAX, LINES_MAX = 4, 12, 6
# What a new theme films when the person names no shots: plain searches that fit most places (CLIP reads them).
STARTER_SHOTS = [
    "a wide view of the place from outside", "the entrance or front of the building", "people arriving or walking in",
    "a close-up of hands at work", "the main room or space inside", "a detail that shows what is special here",
    "food, drink or a product on a table", "a view at golden hour or dusk", "a calm wide shot to end on",
]
_THEMES_SEEN: list = [object()]  # the themes.json stamp THEMES was last built from


def _one(s: str) -> str:
    return str(s or "").replace("\r", "").strip()


def _cues(n_lines: int, n_slots: int) -> list[int]:
    """The shot each line starts on: spread over the middle of the reel (office, 9 shots, 3 lines: 2, 4, 5)."""
    if n_lines <= 0:
        return []
    step = (n_slots - 2) / (n_lines + 1)
    return [max(1, min(n_slots - 2, round(step * (k + 1)))) for k in range(n_lines)]


def clean_theme(key: str, t: dict, check_copy: bool = True) -> dict:
    """A theme from the editor, checked: {hook: {ja, en}, lines: [{ja, en}], shots: [..], tags: [..], style}.
    Raises ValueError naming the field. Every line passes this project's guard (studio.guard)."""
    if not THEME_KEY.match(key or ""):
        raise ValueError("key: lowercase letters, numbers and dashes, starting with a letter (e.g. lunch-menu)")
    if key in RANCH_THEMES or key in HOUSE_KEYS:
        raise ValueError(f"key: {key} is a built-in theme; pick another name")
    hook = t.get("hook") or {}
    if isinstance(hook, str):
        hook = {"ja": hook}
    hook_ja, hook_en = _one(hook.get("ja"))[:80], _one(hook.get("en"))[:120]
    if not hook_ja:
        raise ValueError("hook: the headline the reel opens with")
    lines = []
    for ln in (t.get("lines") or [])[:LINES_MAX]:
        ln = {"ja": ln} if isinstance(ln, str) else (ln or {})
        ja, en = _one(ln.get("ja"))[:80], _one(ln.get("en"))[:120]
        if ja:
            lines.append({"ja": ja, "en": en})
    shots = [str(s).strip()[:120] for s in (t.get("shots") or []) if str(s).strip()][:SHOTS_MAX] or list(STARTER_SHOTS)
    if len(shots) < SHOTS_MIN:
        raise ValueError(f"shots: at least {SHOTS_MIN} things to film, one per line (a reel needs four clips or more)")
    tags = [x if str(x).startswith("#") else "#" + str(x) for x in (t.get("tags") or []) if str(x).strip()][:6]
    if any(re.search(r"\s", x) for x in tags):
        raise ValueError("tags: hashtags without spaces, e.g. #lunch")
    style = t.get("style") if t.get("style") in THEME_STYLES else "column"
    if check_copy:
        for text in [hook_ja, hook_en] + [x for ln in lines for x in (ln["ja"], ln["en"])]:
            if text:
                assert_copy(text)
    return {"title": _one(t.get("title"))[:60] or hook_ja.replace("\n", ""), "hook": {"ja": hook_ja, "en": hook_en}, "lines": lines,
            "shots": shots, "tags": tags, "style": style}


def theme_from_json(key: str, t: dict) -> dict:
    """The assembler's theme from a saved editor theme (clean_theme's shape)."""
    from studio.brand import brand

    t = clean_theme(key, t, check_copy=False)
    one = lambda s: s.replace("\n", "")  # noqa: E731
    name = brand()["name"]
    hook = t["hook"]
    beats = [("hook", hook["ja"], hook["en"])] + [("line", ln["ja"], ln["en"]) for ln in t["lines"]]
    ja = "\n".join([one(hook["ja"])] + [one(ln["ja"]) for ln in t["lines"]])
    en = "\n".join([hook["en"]] + [ln["en"] for ln in t["lines"] if ln["en"]]).strip()
    theme = {
        "title_ja": t["title"], "slots": t["shots"], "cues": _cues(len(t["lines"]), len(t["shots"])), "beats": beats,
        "tags": t["tags"], "yt_title": f"{one(hook['ja'])}｜{name}" if name else one(hook["ja"]), "style": t["style"],
        "own": True, "post": {"ja": ja, "en": en, "x": ja},
    }
    if RANCH:
        theme["posts_from"] = "view"  # the ranch's own prices, link and LinkedIn text, under this theme's words
    return theme


def read_own_themes() -> dict:
    """This project's saved themes as the editor wrote them: {key: {hook, lines, shots, tags, style, title}}."""
    try:
        data = json.loads(THEME_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    themes = data.get("themes") if isinstance(data, dict) else None
    return {k: v for k, v in (themes or {}).items() if isinstance(v, dict) and THEME_KEY.match(k)}


def load_themes() -> dict:
    """THEMES for the open project, re-read when themes.json changed. Returns THEMES (always the same object)."""
    try:
        st = THEME_FILE.stat()
        stamp = (st.st_mtime_ns, st.st_size)  # two saves in one clock tick still differ in size
    except OSError:
        stamp = None
    if _THEMES_SEEN[0] == stamp:
        return THEMES
    own = {}
    for key, t in read_own_themes().items():
        if key in RANCH_THEMES or key in HOUSE_KEYS:
            continue
        try:
            own[key] = theme_from_json(key, t)
        except (KeyError, TypeError, ValueError):
            continue  # a hand-edited entry that no longer reads is skipped, never fatal
    THEMES.clear()
    if RANCH:
        THEMES.update(RANCH_THEMES)
    THEMES.update(own)
    _THEMES_SEEN[0] = stamp
    return THEMES


def save_theme(key: str, t: dict) -> dict:
    """Add or replace one of this project's themes. Returns the saved (cleaned) theme."""
    clean = clean_theme(key, t)
    data = {"themes": read_own_themes()}
    data["themes"][key] = clean
    THEME_FILE.parent.mkdir(parents=True, exist_ok=True)
    THEME_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _THEMES_SEEN[0] = object()
    load_themes()
    return clean


def delete_theme(key: str) -> bool:
    """Remove one of this project's themes. Reels made from it keep their words and shots."""
    own = read_own_themes()
    if key not in own:
        return False
    del own[key]
    THEME_FILE.write_text(json.dumps({"themes": own}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _THEMES_SEEN[0] = object()
    load_themes()
    return True


def theme_list() -> dict:
    """GET /api/themes: every theme the open project can make, with what the editor needs to show and edit it."""
    load_themes()
    own = read_own_themes()
    out = {}
    for k, v in THEMES.items():
        row = {"title": v["title_ja"], "slots": len(v["slots"]), "look": v.get("look"), "recipe": v.get("recipe"), "own": bool(v.get("own"))}
        if v.get("own") and k in own:
            row["edit"] = own[k]
        out[k] = row
    return out


load_themes()

JUNK_MAX = 0.4  # skip clips whose worst keyframe is filler (weeds close-up 0.985; good scenes < 0.1)


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(a @ b)


def _beats(theme: dict, chosen: list[dict]) -> list[dict]:
    """Each line starts on the cut of the shot it describes (theme["cues"] are slot numbers)
    and ends 0.2 s before the next caption's cut; the end card sits on the held last shot."""
    starts, t = [], 0.0
    for c in chosen:
        starts.append(t)
        t += c["sec"]
    total = t
    end_start = starts[-1] + 0.1
    lines = theme["beats"][1:]
    cue_at = []
    for slot_n in theme.get("cues", []):
        i = next((k for k, c in enumerate(chosen) if c["n"] >= slot_n), None)
        cue_at.append(starts[i] if i is not None and 0 < i < len(chosen) - 1 else None)
    aligned = len(cue_at) == len(lines) and all(c is not None for c in cue_at)
    if aligned:
        bounds = cue_at + [end_start]
        aligned = all(bounds[k + 1] - bounds[k] >= 1.4 for k in range(len(lines))) and 1.5 <= bounds[0] <= 4.0
    if not aligned:  # too few shots landed: spread the lines evenly instead
        hook_end = min(3.4, total * 0.25) + 0.2
        step = ((end_start - 0.1) - hook_end) / max(1, len(lines))
        bounds = [hook_end + k * step for k in range(len(lines))] + [end_start]
    beats = [{"kind": "hook", "ja": theme["beats"][0][1], "en": theme["beats"][0][2], "startSec": 0.1, "endSec": round(bounds[0] - 0.2, 2)}]
    for k, (_, ja, en) in enumerate(lines):
        beats.append({"kind": "line", "ja": ja, "en": en, "startSec": round(bounds[k] + 0.1, 2), "endSec": round(bounds[k + 1] - 0.2, 2)})
    from studio.brand import end_card

    end_ja, end_en = end_card()  # the ranch: 嬬恋牧場Work&Camp / Tsumagoi Work&Camp; any other project, its own name
    beats.append({"kind": "end", "ja": end_ja, "en": end_en, "startSec": round(end_start, 2), "endSec": round(total, 2)})
    return beats


VARIETY = 0.03  # how far below the best score a clip may be and still be drawn; 0 = always the best


def draw(scored: list[tuple[float, dict]], rng: random.Random, variety: float = VARIETY, k: int = 4) -> int:
    """Index of the candidate to use: the top k by score, weighted by exp((score - best) / variety).
    Near-ties vary between versions; a clearly better clip still wins almost every time."""
    if not scored:
        raise ValueError("nothing to draw")
    if variety <= 0:
        return 0
    top = scored[:k]
    best = top[0][0]
    weights = [math.exp((s - best) / variety) for s, _ in top]
    return rng.choices(range(len(top)), weights=weights, k=1)[0]


def _src(path: str) -> str:
    """Footage under the media root is stored relative to it; footage from another folder stays absolute."""
    try:
        return str(Path(path).relative_to(SOURCE)).replace("\\", "/")
    except ValueError:
        return str(Path(path))


STYLES = ("column", "centre", "lower", "split")
TAG_POOL = ["#嬬恋", "#群馬", "#キャンプ", "#ワーケーション", "#車中泊", "#焚き火", "#絶景", "#浅間山", "#嬬恋村",
            "#リモートワーク", "#ソロキャンプ", "#デイキャンプ", "#山の上", "#高原"]


def vary_copy(project: dict, theme: dict, rng: random.Random) -> dict:
    """Post text, YouTube title, hashtags and text layout made from this reel's own words, so two reels of one theme
    do not post the same caption. Every sentence is an approved line already on screen; the guard checks again."""
    from studio.projects import all_projects

    hook = next(b for b in project["beats"] if b["kind"] == "hook")
    lines = [b for b in project["beats"] if b["kind"] == "line"]
    one = lambda s: s.replace("\n", "")  # noqa: E731
    ja = one(hook["ja"]) + "\n" + "".join(one(b["ja"]) for b in lines)
    en = hook["en"] + "\n" + " ".join(b["en"] for b in lines)
    post = dict(project.get("posts") or {})
    post.update({"ja": ja, "en": en, "x": ja, "zh": ""})
    if "linkedin" in post:
        post["linkedin"] = f"{ja}\n{CHARTER_LINE}\n\n{EVENT_CAP_LINE}"
    for k in ("ja", "en", "x"):  # the LinkedIn text carries the approved charter prices on purpose (as posts_for)
        if post.get(k):
            assert_copy(post[k])
    first = one(lines[0]["ja"]) if lines else ""
    if RANCH:
        title = f"{one(hook['ja'])}{first}｜嬬恋牧場Work&Camp"
        if len(title) > 90:
            title = f"{one(hook['ja'])}｜嬬恋牧場Work&Camp"
        own = [t for t in theme["tags"] if t != "#tsumagoicamp"]
        extra = [t for t in TAG_POOL if t not in own]
        tags = ["#tsumagoicamp"] + rng.sample(own, k=min(2, len(own))) + rng.sample(extra, k=2)
    else:
        # Any other project: its own name after the words, its own hashtags first, then the theme's. No ranch pool.
        from studio.brand import brand

        b = brand()
        tail = f"｜{b['name']}" if b["name"] else ""
        title = f"{one(hook['ja'])}{first}{tail}"
        if len(title) > 90:
            title = f"{one(hook['ja'])}{tail}"
        post["en"] = post["en"].strip()
        own = [t for t in theme["tags"] if t not in b["tags"]]
        tags = b["tags"] + rng.sample(own, k=min(3, len(own)))
    # Text layout: the theme's own about a third of the time, else the layout this theme used least lately.
    recent = [p.get("style") for p in sorted(all_projects(), key=lambda p: p.get("made_at") or "")[-12:]]
    if rng.random() < 0.35:
        style = theme.get("style", "column")
    else:
        style = min(STYLES, key=lambda s: (recent.count(s), rng.random()))
    # The reel is called by what it says now: cards, lists and the editor show its own headline, not the theme's.
    return {"posts": post, "yt_title": assert_copy(title), "tags": tags, "style": style, "title_ja": one(hook["ja"])}


def assemble(theme: dict, slug: str, allow_faces: bool = False, since: str | None = None, rhythm: list[float] | None = None,
             seed: int | None = None, variety: float = VARIETY, variant: str | None = None, words: str = "fresh",
             with_layers: bool = True) -> dict:
    """Pick one asset per slot and save a project. Returns the project.
    The seed makes a version reproducible; "New version" draws a new one. Every slot's search line,
    candidates and scores are kept in project["trace"] for the Log page."""
    from studio.db import connect

    seed = int(time.time() * 1000) % 2_147_483_647 if seed is None else seed
    rng = random.Random(seed)
    trace: list[dict] = []
    key = next((k for k, v in THEMES.items() if v is theme), None)
    stage = staging({"theme": key, **{k: theme[k] for k in ("look", "recipe", "kicker", "loop") if k in theme}})
    marks = mark_kind(stage)
    long_cut = variant == "b-explainer"
    if long_cut:
        theme = long_theme(theme)
    rhythm = rhythm or (LONG_RHYTHM if long_cut else RHYTHM)[: len(theme["slots"])]
    chosen: list[dict] = []
    used_names: set[str] = set()
    photos = 0
    embs: list[np.ndarray] = []
    with connect() as con:
        emb_rows = {r[0]: np.frombuffer(r[1], dtype="float32") for r in con.execute("SELECT asset_id, emb FROM library WHERE emb IS NOT NULL")}
    for n, (slot, sec) in enumerate(zip(theme["slots"], rhythm)):
        filters = {"ranch": True, "noFaces": not allow_faces}
        if n == 0:
            filters["kind"] = "video"  # open on motion
        pool = items(slot, filters, limit=80)
        if not allow_faces:
            # A person seen from behind has no face to detect; CLIP still calls it people.
            pool = [p for p in pool if "people" not in p["top"]]
        pool = [p for p in pool if p.get("junk", 0) < JUNK_MAX and not p.get("vetoed")]
        if theme.get("device"):
            pool = [p for p in pool if p.get("device") in theme["device"]]
        seasons = theme.get("slot_season") or []
        want = seasons[n] if n < len(seasons) else None

        def rank(p: dict) -> float:
            # Match first; small nudges, never a hard tier, so one recent clip cannot win every theme:
            # newer footage +0.02, the theme's season / tag +0.04, each reel already using it -0.06,
            # how good it looks (LAION aesthetic, 1-10) up to +-0.02.
            score = p.get("match", 0) - 0.06 * len(p["usedIn"]) + nudge(p.get("aesthetic"))
            if since and (p["captured"] or "") >= since:
                score += 0.02
            boost = theme.get("boost", {})
            if p.get("season") == boost.get("season") or (boost.get("tags") and set(boost["tags"]) & set(p["top"])):
                score += 0.04
            if want and p.get("season") == want:  # a split pair: this half's season
                score += 0.06
            return score

        pool.sort(key=lambda p: -rank(p))
        eligible: list[tuple[float, dict]] = []
        for cand in pool:
            if cand["file"].lower() in used_names:
                continue
            is_photo = cand["kind"] == "photo"
            if is_photo and (photos + 1) > 0.3 * len(theme["slots"]):
                continue
            if cand["kind"] == "video" and (cand["duration"] or 0) < sec + 0.8:
                continue
            emb = emb_rows.get(cand["id"])
            if emb is not None and any(_cos(emb, e) > 0.93 for e in embs):
                continue
            eligible.append((rank(cand), cand))
            if len(eligible) >= 4:
                break
        step = {"slot": n, "prompt": slot, "pool": len(pool), "candidates": [
            {"file": c["file"], "match": c.get("match"), "score": round(s, 4), "usedIn": len(c["usedIn"]), "kind": c["kind"],
             "aesthetic": c.get("aesthetic")} for s, c in eligible]}
        if not eligible:
            step["picked"] = None
            trace.append(step)
            continue
        i = draw(eligible, rng, variety)
        cand = eligible[i][1]
        is_photo = cand["kind"] == "photo"
        step["picked"] = cand["file"]
        trace.append(step)
        mark = mark_for(marks, cand.get("tod"), cand.get("season"), cand.get("captured")) if marks else None
        chosen.append({"cand": cand, "sec": min(sec, 2.0) if is_photo else sec, "slot": slot, "n": n, "mark": mark})
        used_names.add(cand["file"].lower())
        photos += int(is_photo)
        emb = emb_rows.get(cand["id"])
        if emb is not None:
            embs.append(emb)
    if stage["look"] == "split":
        chosen = keep_pairs(chosen, len(theme["slots"]))
    if stage["recipe"] == "timeline":
        chosen = morning_to_night(chosen)
    if len(chosen) < 4:
        raise RuntimeError(f"only {len(chosen)} usable assets for this theme")
    last = chosen[-1]
    if last["cand"]["kind"] == "video" and (last["cand"]["duration"] or 0) >= 3.8:
        last["sec"] = 3.0  # a held shot under the end card
    # Fitting cuts to the music's beat would squeeze the explainer back to ~20 s; it keeps its own pace.
    bpm = None if long_cut else _on_the_beat(theme, chosen, rng)
    _reach_min_length(chosen, long_cut)
    shots = []
    for c in chosen:
        shot = {"src": _src(c["cand"]["path"]), "sec": c["sec"], "role": f"auto: {c['slot']} (match {c['cand'].get('match')})"}
        if c.get("mark"):
            shot["label"], shot["labelEn"] = c["mark"]
        shots.append(shot)
    # The second picture track: B-roll cutaways and paper-print insets over running shots (studio.layers).
    reel_layers = []
    if with_layers and not long_cut and stage["look"] != "split":
        from studio.layers import plan as plan_layers

        reel_layers = plan_layers(theme, shots, set(used_names), rng, allow_faces, end_at=sum(s["sec"] for s in shots[:-1]))
    # Fresh words: a headline and lines from the approved bank (studio.wording), least used first, fitting the shots
    # they sit on, and never a set another reel already has. words="theme" keeps the theme's own script.
    drawn = None
    if key and words != "theme":
        from studio.wording import draw as draw_words

        cue_slots = [theme["slots"][c] if c < len(theme["slots"]) else theme["slots"][-1] for c in theme.get("cues", [])]
        drawn = draw_words(key, cue_slots, rng, n_lines=len(theme["beats"]) - 1)
        theme = {**theme, "beats": [("hook", *drawn["hook"])] + [("line", ja, en) for ja, en in drawn["lines"]]}
    # Timeline shots are re-ordered morning to night, so a slot's cue no longer marks its shot: spread the
    # lines evenly after a full-length headline instead.
    beats = _beats({**theme, "cues": []} if stage["recipe"] == "timeline" else theme, chosen)
    if stage["recipe"] == "countdown":
        beats = number_lines(beats)
    for b in beats:
        assert_copy(b["ja"])
        assert_copy(b["en"])
    project = {
        "slug": slug,
        "title_ja": theme["title_ja"],
        "season": "mixed",
        "shots": shots,
        "beats": beats,
        "bed": None,
        "tags": theme["tags"],
        "yt_title": theme["yt_title"],
        "style": theme.get("style", "column"),
        "bpm": bpm,
        "made_by": "assembler (vet in the editor)",
        "seed": seed,
        "variety": variety,
        "trace": trace,
        "made_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if reel_layers:
        project["layers"] = reel_layers
    if key:
        project["theme"] = key
    if any(stage.values()):
        project.update(stage)
    project["posts"] = posts_for(theme)
    if drawn:
        project.update(vary_copy(project, theme, rng))
        project["words"] = {"fresh": drawn["fresh"], "from": "bank"}
    if long_cut:
        project["variant"] = "b-explainer"
        project["made_by"] = "assembler, long explainer (vet in the editor)"
    save(project)
    return project


def keep_pairs(chosen: list[dict], slots: int) -> list[dict]:
    """Split look: shots play in slot pairs (0,1), (2,3)…; a pair that lost a half is dropped whole,
    so a summer half never sits beside the wrong partner. The last slot stays alone under the end card."""
    last = slots - 1
    by_pair: dict[int, list[dict]] = {}
    for c in chosen:
        if c["n"] < last - (last % 2):
            by_pair.setdefault(c["n"] // 2, []).append(c)
    kept = [c for p in sorted(by_pair) if len(by_pair[p]) == 2 for c in by_pair[p]]
    return kept + [c for c in chosen if c["n"] >= last - (last % 2)]


def morning_to_night(chosen: list[dict]) -> list[dict]:
    """Timeline: after the opening shot, shots run 朝 → 昼 → 夕 → 夜 by their own marks (stable within a mark)."""
    if len(chosen) < 3:
        return chosen
    head, rest = chosen[:1], chosen[1:]
    rest = sorted(rest, key=lambda c: DAY_ORDER.get((c.get("mark") or ("昼",))[0], 1))
    return head + rest


def _reach_min_length(chosen: list[dict], long_cut: bool = False) -> None:
    """A theme with few shots (4 or 5, the theme editor's minimum) cut on the short rhythm runs 6-7.5 s, under the 8 s
    the renderer requires (reels.LENGTH_RULE), so its reel could never render. Lengthen the shortest shots on the
    0.5 s grid, never past 4 s, 2 s for a photo or what the clip holds, until the reel is long enough."""
    from studio.reels import LENGTH_RULE

    lo = LENGTH_RULE["b-explainer" if long_cut else None][0]

    def room(c: dict) -> float:
        if c["cand"]["kind"] == "photo":
            return 2.0
        return min(4.0, max(1.0, (c["cand"]["duration"] or 4) - 0.6))

    while sum(c["sec"] for c in chosen) < lo:
        grow = [c for c in chosen if c["sec"] + 0.5 <= room(c)]
        if not grow:
            break
        min(grow, key=lambda c: c["sec"])["sec"] += 0.5


def _on_the_beat(theme: dict, chosen: list[dict], rng: random.Random | None = None) -> float | None:
    """Move the shot lengths onto the theme's music. Keeps the 0.5 s grid. None when the track has no beat."""
    from studio.sound import choose_music, fit_cuts, track_beats

    key = next((name for name, item in THEMES.items() if item is theme), "view")
    music = choose_music({"slug": key, "music": "auto"}, 12)
    if not music:
        return None
    lengths = fit_cuts(track_beats(music["file"]), len(chosen), rng=rng)
    if not lengths:
        return None
    for cand, length in zip(chosen, lengths):
        limit = 2.0 if cand["cand"]["kind"] == "photo" else min(4.0, max(1.0, (cand["cand"]["duration"] or 4) - 0.6))
        cand["sec"] = round(max(1.0, min(length, limit)) * 2) / 2
    gaps = [b2 - b1 for b1, b2 in zip(track_beats(music["file"]), track_beats(music["file"])[1:]) if 0.3 < b2 - b1 < 1.5]
    return round(60 / sorted(gaps)[len(gaps) // 2]) if gaps else None


def film_next() -> list[dict]:
    """Themes whose opening shot has fewer than three fresh clips left. What to film next."""
    thin = []
    for key, theme in THEMES.items():
        filters = {"ranch": True, "noFaces": True, "kind": "video"}
        pool = items(theme["slots"][0], filters, limit=40)
        pool = [p for p in pool if "people" not in p["top"] and p.get("junk", 0) < JUNK_MAX and not p.get("vetoed")]
        if theme.get("device"):
            pool = [p for p in pool if p.get("device") in theme["device"]]
        fresh = [p for p in pool if not p["usedIn"] and p.get("match", 0) >= 0.22]
        if len(fresh) < 3:
            thin.append({"theme": key, "title": theme["title_ja"], "need": theme["slots"][0], "left": len(fresh)})
    return thin


def alternate_opening(slug: str) -> dict:
    """A second reel with a different first shot, so both openings can be posted."""
    from studio.projects import load

    project = load(slug)
    if not project:
        raise KeyError(slug)
    key = project.get("theme") or slug.split("-")[0]
    theme = load_themes().get(key)
    if theme is None:
        raise ValueError(f"{slug}: its theme ({key}) is not in this project any more, so there is no opening search to try")
    pool = items(theme["slots"][0], {"ranch": True, "noFaces": True, "kind": "video"}, limit=40)
    used = {Path(s["src"]).name.lower() for s in project["shots"]}
    pool = [p for p in pool if p["file"].lower() not in used and "people" not in p["top"] and not p.get("vetoed") and (p["duration"] or 0) >= 2.5]
    if not pool:
        raise RuntimeError("no other opening clip is free")
    pick = pool[0]
    base, n = f"{slug}-b", 2
    while load(base):
        base, n = f"{slug}-b{n}", n + 1
    nxt = json.loads(json.dumps(project))
    nxt["slug"] = base
    nxt["shots"][0] = {"src": _src(pick["path"]), "sec": project["shots"][0]["sec"], "role": "alternate opening"}
    nxt["made_by"] = f"alternate opening of {slug}"
    nxt["theme"] = key
    save(nxt)
    return {"slug": base, "opening": pick["file"]}


CHARTER_LINE = "山まるごとの貸切は一律料金です。〜30名で日帰り¥120,000／テント泊¥180,000、31〜50名で¥180,000／¥250,000。"
EVENT_CAP_LINE = "イベントは50名まで — 山の水インフラに正直な上限です。"


def posts_for(theme: dict) -> dict:
    """Approved channel copy: the theme's own, else a house reel's (prices, LinkedIn, path)
    with this theme's headline and proof on top. A borrowed Chinese draft is dropped, it
    would describe another reel; the Xiaohongshu folder then asks for a native writer."""
    if theme.get("posts"):
        return theme["posts"]
    if not RANCH:
        # A project made in the studio: only its own words. No borrowed ranch prices, LinkedIn charter or link path.
        one = lambda s: s.replace("\n", "")  # noqa: E731
        hook = theme["beats"][0]
        post = dict(theme.get("post") or {"ja": "\n".join(one(b[1]) for b in theme["beats"]),
                                          "en": "\n".join(b[2] for b in theme["beats"] if b[2]), "x": one(hook[1])})
        post["zh"] = ""
        for k in ("ja", "en", "x"):
            if post.get(k):
                assert_copy(post[k])
        return post
    from studio.reels import POSTS, SHORT

    key = theme.get("posts_from", "view")
    base = {**POSTS[key], **SHORT.get(key, {})}
    if theme.get("post"):
        base.update(theme["post"])
        base["zh"] = ""
        if "linkedin" not in theme["post"]:
            # The borrowed LinkedIn text describes the other reel. Build this theme's own from its headline
            # and the charter lines approved in the house posts: the numbers in the first two lines.
            base["linkedin"] = f"{theme['post']['ja']}\n{CHARTER_LINE}\n\n{EVENT_CAP_LINE}"
    for k in ("ja", "en", "x"):
        if base.get(k):
            assert_copy(base[k])
    return base
