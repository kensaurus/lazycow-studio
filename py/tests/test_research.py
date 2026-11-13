"""Research (studio.research) against a fake HTTP layer, no real network: ideas and trends, the website check
against the approved facts, a page read, local events, the link check, status and the key check; the 24 h
cache, the daily cap, and every error as one plain sentence that never carries the key."""
import io
import json
import socket
import urllib.error
from datetime import date

import pytest

from studio import posting, research

KEY = "fc-testkey0123456789abcdef"


class Fake:
    """Answers by (method, a piece of the URL); each route pops its next reply, the last one repeats.
    A reply is (status, body) or (status, body, headers), or an exception to raise."""

    def __init__(self, routes):
        self.routes = [(m, part, list(replies)) for m, part, replies in routes]
        self.calls = []

    def __call__(self, method, url, *, data=None, headers=None, timeout=60):
        self.calls.append({"method": method, "url": url, "body": json.loads(data) if data else None,
                           "headers": {k.lower(): v for k, v in (headers or {}).items()}})
        for m, part, replies in self.routes:
            if m == method and part in url:
                reply = replies.pop(0) if len(replies) > 1 else replies[0]
                if isinstance(reply, BaseException):
                    raise reply
                status, body = reply[0], reply[1]
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                return status, (reply[2] if len(reply) > 2 else {}), raw
        raise AssertionError(f"unexpected call {method} {url}")

    def find(self, part):
        return [c for c in self.calls if part in c["url"]]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(research, "HOME", tmp_path)
    monkeypatch.setattr(research, "api_key", lambda: KEY)
    monkeypatch.setattr(research, "openrouter_key", lambda: "")
    monkeypatch.setattr("studio.ai.reviewer_key", lambda: "")  # never the real saved key in tests
    monkeypatch.setattr(research, "_today", lambda: date(2026, 11, 9))
    monkeypatch.delenv("STUDIO_RESEARCH_DAILY_CAP", raising=False)
    return tmp_path


def use(monkeypatch, routes):
    fake = Fake(routes)
    monkeypatch.setattr(research, "_call", fake)
    monkeypatch.setattr(research, "_ping_call", fake)  # the link check's own no-redirect request, same answers
    return fake


SEARCH = {"success": True, "creditsUsed": 4, "data": {
    "web": [
        {"url": "https://example.jp/workation-gunma", "title": "群馬でワーケーション #ワーケーション", "description": "嬬恋の高原でワーケーション。紅葉と光回線のある宿 #ワーケーション"},
        {"url": "https://example.com/tsumagoi-camp", "title": "Tsumagoi camping guide", "description": "Camping in Tsumagoi: ワーケーション and autumn foliage, camping spots"},
    ],
    "news": [
        {"url": "https://news.example.jp/a", "title": "嬬恋村 紅葉 ワーケーション", "snippet": "紅葉の嬬恋村", "date": "3 days ago"},
        {"url": "https://news.example.jp/old", "title": "古い記事", "snippet": "old", "date": "2 years ago"},
    ],
}}


# ---------- ideas, cache, cap ----------

def test_ideas_search_ja_and_en_and_cite_sources(env, monkeypatch):
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    r = research.run("ideas", {"days": 14})
    calls = fake.find("/v2/search")
    assert len(calls) == 2, "one search in Japanese, one in English"
    sent = calls[0]["body"]
    assert sent["sources"] == ["web", "news"] and sent["country"] == "JP" and sent["limit"] == 8
    assert sent["tbs"] == "cdr:1,cd_min:10/26/2026,cd_max:11/9/2026", "the last 14 days"
    assert calls[0]["headers"]["authorization"] == f"Bearer {KEY}"
    urls = {it["url"] for it in r["items"]}
    assert "https://news.example.jp/old" not in urls, "news older than asked is dropped (tbs does not filter news)"
    assert set(r["sources"]) == urls and len(r["items"]) == 3, "deduplicated across the two searches"
    assert {"title", "url", "source", "date", "snippet"} <= set(r["items"][0])
    assert r["hashtags"][0]["tag"] == "#ワーケーション"
    words = [k["word"] for k in r["keywords"]]
    assert "紅葉" in words, "a word two pages share"
    assert "ワーケーション" not in words, "the topic's own words are not news"
    assert 3 <= len(r["angles"]) <= 5
    for a in r["angles"]:
        assert a["from"] == "template" and a["sources"] and set(a["sources"]) <= urls, "every angle cites pages that were read"
    assert r["cached"] is False and r["cost"]["firecrawlCalls"] == 2 and r["cost"]["credits"] == 8
    assert "approved copy" in r["note"]


def test_ideas_search_where_the_project_is_and_never_name_the_ranch(env, monkeypatch):
    """A public user's project searched "Tsumagoi Gunma camping" in Japan's results when no topic was typed."""
    from studio import brand
    monkeypatch.setattr(brand, "RANCH", False)
    monkeypatch.setattr(brand, "brand", lambda: {"name": "Cafe Kumo"})
    monkeypatch.setattr(brand, "home_place", lambda: {"lat": 52.52, "lon": 13.40, "radiusKm": 5, "names": ["Berlin Mitte"]})
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    r = research.run("ideas", {"days": 14})
    calls = fake.find("/v2/search")
    assert len(calls) == 1, "one English search outside Japan"
    body = calls[0]["body"]
    assert body["query"] == "Cafe Kumo Berlin Mitte" and body["location"] == "Germany" and "country" not in body
    assert "Tsumagoi" not in r["summary"] and "Cafe Kumo Berlin Mitte" in r["summary"]
    monkeypatch.setattr(brand, "home_place", lambda: None)
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    research.run("ideas", {"days": 14, "fresh": True})
    body = fake.find("/v2/search")[0]["body"]
    assert body["query"] == "Cafe Kumo" and "country" not in body and "location" not in body, "no home place: no country"
    monkeypatch.setattr(brand, "home_place", lambda: {"lat": 35.68, "lon": 139.76, "radiusKm": 5, "names": ["千代田区"]})
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    research.run("ideas", {"days": 14, "fresh": True})
    calls = fake.find("/v2/search")
    assert len(calls) == 2 and all(c["body"]["country"] == "JP" for c in calls), "a home place in Japan: Japan's results"


def test_ideas_come_from_the_cache_the_second_time(env, monkeypatch):
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    research.run("ideas", {})
    again = research.run("ideas", {})
    assert len(fake.calls) == 2, "the second run made no request"
    assert again["cached"] is True and again["cost"] == {"firecrawlCalls": 0, "fromCache": 2, "credits": 0}
    research.run("ideas", {"fresh": True})
    assert len(fake.calls) == 4, "fresh skips the cache"
    assert research.cache_info()["entries"] == 2


def test_the_daily_cap_stops_live_calls_but_not_the_cache(env, monkeypatch):
    monkeypatch.setenv("STUDIO_RESEARCH_DAILY_CAP", "2")
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    research.run("ideas", {})
    with pytest.raises(research.ResearchError) as e:
        research.run("ideas", {"topic": "冬キャンプ"})
    assert e.value.code == "cap" and e.value.status == 429
    assert "daily research limit (2" in str(e.value) and "STUDIO_RESEARCH_DAILY_CAP" in str(e.value)
    assert len(fake.calls) == 2, "the capped request never left the computer"
    assert research.run("ideas", {})["cached"] is True, "cached results still work after the cap"
    assert research.usage_today()["requests"] == 2


def test_ideas_use_the_ai_when_a_key_and_budget_allow_and_keep_only_real_sources(env, monkeypatch):
    monkeypatch.setattr(research, "openrouter_key", lambda: "or-key")
    monkeypatch.setattr(research, "daily_budget", lambda: 5.0)
    angles = {"angles": [
        {"title": "紅葉の嬬恋", "why": "Autumn pages are trending", "sources": ["https://news.example.jp/a"]},
        {"title": "Workation at altitude", "why": "Gunma workation pages", "sources": ["https://example.jp/workation-gunma", "https://made-up.example/x"]},
        {"title": "No source", "why": "invented", "sources": ["https://made-up.example/y"]},
    ]}
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)]),
                             ("POST", "openrouter.ai", [(200, {"choices": [{"message": {"content": json.dumps(angles)}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 200}})])])
    r = research.run("ideas", {})
    assert [a["from"] for a in r["angles"]] == ["ai", "ai"], "an angle without a real source is dropped"
    assert r["angles"][1]["sources"] == ["https://example.jp/workation-gunma"]
    assert "DATA" in fake.find("openrouter")[0]["body"]["messages"][0]["content"], "results are passed as data, not instructions"
    from studio.db import connect

    with connect() as con:
        row = con.execute("SELECT purpose, usd FROM spend WHERE purpose = 'research'").fetchone()
    assert row and row["usd"] > 0, "the AI call is counted in the studio's spend"


def test_ideas_fall_back_to_templates_when_over_budget(env, monkeypatch):
    monkeypatch.setattr(research, "openrouter_key", lambda: "or-key")
    monkeypatch.setattr(research, "daily_budget", lambda: 0.0)
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, SEARCH)])])
    r = research.run("ideas", {})
    assert not fake.find("openrouter") and all(a["from"] == "template" for a in r["angles"])


# ---------- errors: one plain sentence each ----------

@pytest.mark.parametrize("reply, code, status, words", [
    ((401, {"success": False, "error": "Unauthorized: Invalid token"}), "bad_key", 400, "did not accept the key"),
    ((402, {"success": False, "error": "Payment Required: Insufficient credits"}), "no_credits", 402, "out of credits"),
    ((429, {"success": False, "error": "Rate limit exceeded"}, {"Retry-After": "30"}), "rate_limited", 429, "Wait 30 seconds"),
    ((408, {"success": False, "error": "Request Timeout"}), "timeout", 504, "too long"),
    ((503, {"success": False, "error": "busy"}), "upstream", 502, "on its side"),
    ((403, {"success": False, "error": "We apologize for the inconvenience but we do not support this site."}), "blocked", 422, "cannot read that site"),
    (urllib.error.URLError("getaddrinfo failed"), "network", 503, "internet connection"),
    (socket.timeout("timed out"), "timeout", 504, "too long"),
])
def test_firecrawl_errors_are_plain_sentences(env, monkeypatch, reply, code, status, words):
    use(monkeypatch, [("POST", "/v2/search", [reply])])
    with pytest.raises(research.ResearchError) as e:
        research.run("ideas", {})
    assert e.value.code == code and e.value.status == status
    assert words in str(e.value) and KEY not in str(e.value)
    assert str(e.value).count(".") <= 3, "a sentence or two, not a dump"


def test_no_key_says_where_to_add_one_and_calls_nothing(env, monkeypatch):
    monkeypatch.setattr(research, "api_key", lambda: "")
    fake = use(monkeypatch, [])
    for action, req in (("ideas", {}), ("events", {}), ("site-check", {}), ("page", {"url": "https://example.com/"})):
        with pytest.raises(research.ResearchError) as e:
            research.run(action, req)
        assert e.value.code == "no_key" and str(e.value) == "Add your Firecrawl key in Settings › Keys & AI."
    assert fake.calls == []
    s = research.run("status", {})
    assert s["ready"] is False and s["credits"] is None and "Settings › Keys & AI" in s["summary"]


def test_bad_input_is_refused_before_any_call(env, monkeypatch):
    fake = use(monkeypatch, [])
    for req in ({"url": "ftp://example.com"}, {"url": "http://localhost:4317/"}, {"url": "http://192.168.1.10/"}, {}):
        with pytest.raises(research.ResearchError) as e:
            research.run("page", req)
        assert e.value.code == "bad_input"
    with pytest.raises(research.ResearchError) as e:
        research.run("page", {"url": "https://x.com/someone/status/1"})
    assert "X and LinkedIn" in str(e.value), "pages billed through paid providers are never sent"
    with pytest.raises(research.ResearchError):
        research.run("ideas", {"days": 0})
    with pytest.raises(research.ResearchError):
        research.run("events", {"days": 400})
    assert fake.calls == []


# ---------- website check ----------

def _scrape(json_part, markdown, status=200, url="https://tsumagoi.kensaur.us/"):
    return (200, {"success": True, "data": {"markdown": markdown, "json": json_part, "summary": "A mountain work camp.",
                                            "metadata": {"statusCode": status, "url": url, "title": "嬬恋牧場Work&Camp"}}})


def test_site_check_reports_matches_and_mismatches_in_plain_words(env, monkeypatch):
    # The page reader (JSON) proposes; only numbers the page text writes beside the plan's name count.
    home = _scrape({"altitude_m": 1444, "field_first_yen": 5500, "camp_first_yen": 11800, "camp_extra_yen": 1200, "fibre_mbps": 100,
                    "camp_two_adults_yen": 11800, "inclusions": ["シャワー", "こたつラウンジ24時間", "サウナ"], "booking_url": "/reserve"},
                   "標高1,444 m、いちばん近い民家まで約10km。光回線100Mbps。1日5組まで。[貸切](https://tsumagoi.kensaur.us/charter)\n"
                   "ぜんぶ込みキャンプ 大人2名1泊 ¥11,800〜。ぜんぶ込みキャンプは1人目 ¥7,200／泊。\n"
                   "フィールドだけは1人目 ¥5,500・追加1名 ¥2,200／泊。\nラウンジ日帰り 1日 ¥2,000・4時間 ¥1,200")
    reserve = _scrape({}, "ご予約はこちら", url="https://tsumagoi.kensaur.us/reserve")
    charter = _scrape(None, "山まるごと貸切。日帰り ¥120,000〜／テント泊 ¥180,000〜（30名まで）。31〜50名は 日帰り ¥180,000／テント泊 ¥250,000。イベントは50名まで。",
                      url="https://tsumagoi.kensaur.us/charter")
    fake = use(monkeypatch, [("POST", "/v2/scrape", [home, reserve, charter])])
    r = research.run("site-check", {})
    sent = [c["body"] for c in fake.find("/v2/scrape")]
    assert [x["url"] for x in sent] == ["https://tsumagoi.kensaur.us/", "https://tsumagoi.kensaur.us/reserve", "https://tsumagoi.kensaur.us/charter"], \
        "the profile link, the booking page, then the private-hire page it links to"
    assert sent[0]["formats"][0] == "markdown" and sent[0]["formats"][1]["type"] == "json" and "field_first_yen" in sent[0]["formats"][1]["schema"]["properties"]
    assert sent[2]["formats"] == ["markdown"], "the extra page is read as text only (1 credit)"
    by = {f["fact"]: f for f in r["facts"]}
    assert by["altitude_m"]["status"] == "match" and by["altitude_m"]["message"] == "Altitude: the website and your copy both say 1,444 m."
    field = by["field_first_yen"]
    assert field["status"] == "mismatch" and field["site"] == 5500 and field["ours"] == 5200 and field["onPage"] is True
    assert field["message"].startswith("Field only: first adult per night: the website says ¥5,500; your copy says ¥5,200 (")
    assert by["field_extra_yen"]["status"] == "match", "¥2,200 is written beside フィールドだけ"
    assert by["camp_first_yen"]["status"] == "match", "the reader misfiled the 2-adult price; the text has ¥7,200 per person"
    extra = by["camp_extra_yen"]
    assert extra["status"] == "unsure" and extra["site"] == 1200 and "check it by eye" in extra["message"], "¥1,200 sits beside the lounge, not the camp"
    two = by["camp_two_adults_yen"]
    assert two["status"] == "mismatch" and two["message"] == ("All-in camp, 2 adults for 1 night: the website quotes ¥11,800; your copy's prices add up to "
                                                             "¥11,400 (¥7,200 + ¥4,200).")
    for k in ("charter30_day_yen", "charter30_tent_yen", "charter50_day_yen", "charter50_tent_yen", "event_cap"):
        assert by[k]["status"] == "match" and by[k]["source"] == "https://tsumagoi.kensaur.us/charter", k
    assert r["mismatches"] == [field["message"], two["message"]]
    inc = {i["item"]: i["status"] for i in r["inclusions"]}
    assert inc["shower"] == "match" and inc["parking"] == "not_on_site"
    assert r["booking"]["status"] == "match"
    assert r["sources"] == ["https://tsumagoi.kensaur.us/", "https://tsumagoi.kensaur.us/reserve", "https://tsumagoi.kensaur.us/charter"]
    assert r["summary"].startswith("Checked 3 pages of tsumagoi.kensaur.us:") and "2 differ, 1 to check by eye" in r["summary"]


def test_site_check_a_two_adult_price_proves_the_extra_person_price(env, monkeypatch):
    use(monkeypatch, [("POST", "/v2/scrape", [_scrape({}, "| 人数 | フィールドだけ |\n| 1名 | ¥5,200 |\n| 2名 | ¥7,400 |")])])
    r = research.run("site-check", {"url": "https://tsumagoi.kensaur.us/"})
    by = {f["fact"]: f for f in r["facts"]}
    assert by["field_first_yen"]["status"] == "match" and by["field_two_adults_yen"]["status"] == "match"
    assert by["field_extra_yen"]["status"] == "match" and "¥7,400 = ¥5,200 + ¥2,200" in by["field_extra_yen"]["message"]


def test_site_check_does_not_trust_a_number_the_page_text_does_not_have(env, monkeypatch):
    use(monkeypatch, [("POST", "/v2/scrape", [_scrape({"altitude_m": 1500, "charter30_tent_yen": 0}, "高原のキャンプ場です")])])
    r = research.run("site-check", {"url": "https://tsumagoi.kensaur.us/"})
    by = {f["fact"]: f for f in r["facts"]}
    alt = by["altitude_m"]
    assert alt["status"] == "unsure" and alt["onPage"] is False and alt["site"] == 1500 and "check it by eye" in alt["message"]
    assert by["charter30_tent_yen"]["status"] == "not_on_site", "a 0 from the reader means not stated, never ¥0"
    assert r["mismatches"] == []


@pytest.mark.parametrize("status, code", [(403, "blocked"), (404, "not_found")])
def test_a_page_the_site_refuses_is_a_plain_error(env, monkeypatch, status, code):
    use(monkeypatch, [("POST", "/v2/scrape", [_scrape({}, "", status=status)])])
    with pytest.raises(research.ResearchError) as e:
        research.run("page", {"url": "https://competitor.example/"})
    assert e.value.code == code and e.value.status == 422 and "competitor.example" in str(e.value)


# ---------- read a page ----------

def test_page_read_gives_summary_points_and_what_they_say_that_we_dont(env, monkeypatch):
    fake = use(monkeypatch, [("POST", "/v2/scrape", [(200, {"success": True, "data": {
        "summary": "A glamping site in Karuizawa with a sauna.", "markdown": "Forest Glamp. 1泊 ¥30,000〜。サウナ付き。焚き火ができる。",
        "json": {"name": "Forest Glamp", "selling_points": ["Private sauna", "Dog friendly"], "amenities": ["sauna", "BBQ"],
                 "claims": ["ペット同伴可", "焚き火ができる"],
                 "prices": [{"label": "1 night", "yen": 30000}, {"label": "made up by the reader", "yen": 5200}]},
        "metadata": {"statusCode": 200, "url": "https://glamp.example/", "title": "Forest Glamp"}}})])])
    r = research.run("page", {"url": "https://glamp.example/"})
    assert r["summary"].startswith("A glamping site") and r["sellingPoints"] == ["Private sauna", "Dog friendly"]
    assert r["prices"] == [{"label": "1 night", "yen": 30000}] and r["pricesDropped"] == 1, "a price the page text does not write is dropped"
    gap = r["theySayWeDont"]
    assert "ペット同伴可" in gap and "sauna" in gap, "points our approved copy never mentions"
    assert "焚き火ができる" not in gap, "our copy talks about 焚き火 already"
    assert r["sources"] == ["https://glamp.example/"] and "Do not copy" in r["note"]
    sent = fake.calls[0]["body"]
    assert [f if isinstance(f, str) else f["type"] for f in sent["formats"]] == ["markdown", "summary", "json"]
    prompt = sent["formats"][2]["prompt"]
    assert "5,200" not in prompt and "1,444" not in prompt, "our facts never go to the page reader (it copied them into theirs)"


# ---------- events ----------

def test_events_keep_dated_ones_in_the_window_with_a_post_by_date(env, monkeypatch):
    found = {"success": True, "data": {"web": [
        {"url": "https://tsumagoi.example/marathon", "title": "嬬恋キャベツマラソン 2026年11月21日", "description": "嬬恋村で開催"},
        {"url": "https://karuizawa.example/lights", "title": "軽井沢 ウィンターイルミネーション", "description": "11月14日～2月28日 軽井沢で"},
        {"url": "https://gunma.example/past", "title": "群馬 秋祭り 2026年10月3日", "description": "終了しました"},
        {"url": "https://gunma.example/nodate", "title": "草津温泉 冬のイベント", "description": "詳細は公式サイトで"},
    ]}}
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, found)])])
    r = research.run("events", {"days": 30})
    assert len(fake.calls) == 3 and "2026年11月" in fake.calls[0]["body"]["query"]
    assert r["window"] == {"from": "2026-11-09", "to": "2026-12-09", "days": 30}
    assert [e["url"] for e in r["events"]] == ["https://karuizawa.example/lights", "https://tsumagoi.example/marathon"]
    marathon = r["events"][1]
    assert marathon["dates"] == ["2026-11-21"] and marathon["postBy"] == "2026-11-18" and "嬬恋" in marathon["place"]
    assert r["events"][0]["range"] == {"from": "2026-11-14", "to": "2027-02-28"}
    assert [u["url"] for u in r["undated"]] == ["https://gunma.example/nodate"]
    assert "https://gunma.example/past" not in r["sources"]


def test_events_search_where_the_project_is_not_japan_by_default(env, monkeypatch):
    """A public user's project in Berlin searched Japanese words in Japan's results (country was always JP)."""
    from studio import brand
    monkeypatch.setattr(brand, "RANCH", False)
    monkeypatch.setattr(brand, "home_place", lambda: {"lat": 52.52, "lon": 13.40, "radiusKm": 5, "names": ["Berlin Mitte"]})
    found = {"success": True, "data": {"web": [{"url": "https://berlin.example/lights", "title": "Festival of Lights",
                                                "description": "Nov 20 2026 in Berlin Mitte"}]}}
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, found)])])
    r = research.run("events", {"days": 30})
    body = fake.calls[0]["body"]
    assert body["query"] == "Berlin Mitte events November 2026 December 2026"
    assert body.get("country") != "JP" and body["location"] == "Germany" and "イベント" not in body["query"]
    assert [e["url"] for e in r["events"]] == ["https://berlin.example/lights"]
    monkeypatch.setattr(brand, "home_place", lambda: {"lat": 35.68, "lon": 139.76, "radiusKm": 5, "names": ["千代田区"]})
    fake = use(monkeypatch, [("POST", "/v2/search", [(200, found)])])
    research.run("events", {"days": 30, "fresh": True})
    assert fake.calls[0]["body"]["country"] == "JP" and "イベント" in fake.calls[0]["body"]["query"]
    # No home place: a sentence that says where to set one and a 400, not "a problem in the studio" (500).
    monkeypatch.setattr(brand, "home_place", lambda: None)
    with pytest.raises(research.ResearchError) as err:
        research.run("events", {"days": 30, "fresh": True})
    assert err.value.status == 400 and err.value.code == "no_home_place" and "This project" in str(err.value)


def test_find_dates_reads_the_common_ways_of_writing_a_date():
    dates, rng = research.find_dates("2026年12月5日 / 12月6日 / 12/7(月) / Dec 8 / 1月10日～1月12日", date(2026, 11, 9))
    assert [d.isoformat() for d in dates] == ["2026-12-05", "2026-12-06", "2026-12-07", "2026-12-08", "2027-01-10", "2027-01-12"]
    assert rng == (date(2027, 1, 10), date(2027, 1, 12))
    # Last season's page: the weekday beside the date (and 令和7年度) place it in 2025, not this year.
    today = date(2026, 11, 9)
    dates, rng = research.find_dates("11/22(土)～2026/2/28(土)『軽井沢ウインターフェスティバル』", today)
    assert [d.isoformat() for d in dates] == ["2025-11-22", "2026-02-28"]
    dates, rng = research.find_dates("【令和7年度】キャンドルイベント 11月22日（土）～12月6日（土）", today)
    assert rng == (date(2025, 11, 22), date(2025, 12, 6))
    dates, _ = research.find_dates("令和8年12月5日 開催", today)
    assert dates == [date(2026, 12, 5)]
    _, rng = research.find_dates("ウインターイルミネーション 11月14日～2月28日", today)
    assert rng == (date(2026, 11, 14), date(2027, 2, 28)), "a range end follows its start into the next year"


# ---------- links ----------

def test_links_finds_broken_ones_in_planned_posts_and_the_profile_kit(env, monkeypatch, tmp_path):
    drafts = tmp_path / "drafts"
    (drafts / "fire-1107" / "x").mkdir(parents=True)
    (drafts / "fire-1107" / "x" / "post.txt").write_text("焚き火\nhttps://ok.example/events?utm_source=x\nhttps://gone.example/old。", encoding="utf-8")
    monkeypatch.setattr(research, "_drafts", lambda: drafts)
    monkeypatch.setattr(posting, "posts", lambda: [
        {"id": 3, "slug": "story-fire-1107", "network": "x", "status": "planned", "url": None},
        {"id": 4, "slug": "view-1107", "network": "x", "status": "posted", "url": "https://posted.example/never-checked"},
        {"id": 5, "slug": "view-1107", "network": "facebook", "status": "scheduled", "url": "https://shy.example/p"},
    ])
    monkeypatch.setattr(research, "profile_kit", lambda: {"networks": {"tiktok": {"bio": "山", "link": "https://ok.example/?utm_source=tiktok"},
                                                                       "x": {"link": "https://x.com/tsumagoicamp"}}})
    fake = use(monkeypatch, [
        ("HEAD", "ok.example", [(200, b"")]),
        ("HEAD", "gone.example", [(404, b"")]),
        ("HEAD", "shy.example", [(403, b"")]), ("GET", "shy.example", [(403, b"")]),
        ("HEAD", "x.com", [(403, b"")]), ("GET", "x.com", [(403, b"")]),
        ("POST", "/v2/scrape", [(200, {"success": True, "data": {"metadata": {"statusCode": 200}}})]),
    ])
    r = research.run("links", {})
    by = {x["url"]: x for x in r["links"]}
    assert "https://posted.example/never-checked" not in by, "only planned and scheduled posts"
    assert by["https://gone.example/old"]["status"] == "broken" and by["https://gone.example/old"]["usedIn"] == ["post #3 (fire-1107 on x, planned)"]
    assert by["https://ok.example/events?utm_source=x"]["status"] == "ok"
    assert by["https://shy.example/p"]["status"] == "ok" and "Firecrawl" in by["https://shy.example/p"]["why"]
    assert by["https://x.com/tsumagoicamp"]["status"] == "blocked", "X is never sent to Firecrawl (paid provider)"
    assert [c["body"]["url"] for c in fake.find("/v2/scrape")] == ["https://shy.example/p"]
    assert r["summary"].startswith("1 of 5 links are broken: https://gone.example/old (page not found, in post #3")
    assert r["broken"][0]["url"] == "https://gone.example/old" and set(r["sources"]) == set(by)


# ---------- status, the key, the wire ----------

def test_status_reports_credits_and_cache_but_never_the_key(env, monkeypatch):
    fake = use(monkeypatch, [("GET", "/v2/team/credit-usage", [(200, {"success": True, "data": {"remainingCredits": 86319, "planCredits": 100000, "billingPeriodEnd": "2026-12-03T00:25:32Z"}})])])
    s = research.run("status", {})
    assert s["ready"] is True and s["credits"] == {"remaining": 86319, "plan": 100000, "used": 13681, "periodEnd": "2026-12-03T00:25:32Z"}
    assert s["summary"] == "Research is ready. 86,319 Firecrawl credits left."
    assert s["dailyCap"] == 60 and s["cache"]["entries"] == 0 and s["today"]["requests"] == 0
    research.run("status", {})
    assert len(fake.calls) == 1, "credits are cached for 10 minutes"
    assert KEY not in json.dumps(s)


def test_check_key_validates_with_the_free_call(env, monkeypatch):
    fake = use(monkeypatch, [("GET", "/v2/team/credit-usage", [(401, {"success": False, "error": "Unauthorized: Invalid token"}),
                                                               (200, {"success": True, "data": {"remainingCredits": 500, "planCredits": 500}})])])
    with pytest.raises(research.ResearchError) as e:
        research.run("check-key", {"key": "not-a-key"})
    assert e.value.code == "bad_key" and fake.calls == []
    with pytest.raises(research.ResearchError) as e:
        research.run("check-key", {"key": "fc-wrongwrongwrong123"})
    assert e.value.code == "bad_key" and "fc-wrongwrongwrong123" not in str(e.value)
    ok = research.run("check-key", {"key": "fc-rightrightright123"})
    assert ok == {"valid": True, "credits": {"remaining": 500, "plan": 500, "used": 0, "periodEnd": None}}
    assert fake.calls[-1]["headers"]["authorization"] == "Bearer fc-rightrightright123"


def test_main_prints_one_result_line_and_scrubs_the_key(env, monkeypatch, capsys):
    use(monkeypatch, [("POST", "/v2/search", [(400, {"success": False, "error": f"bad request for key {KEY}"})])])
    monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
    assert research.main(["ideas"]) == 0
    out = capsys.readouterr().out.strip()
    assert out.startswith("RESULT ") and "\n" not in out
    r = json.loads(out[7:])
    assert r["ok"] is False and r["code"] == "bad_input" and r["status"] == 400
    assert KEY not in out and "fc-…" in r["error"]
    monkeypatch.setattr("sys.stdin", io.StringIO("not json"))
    research.main(["ideas"])
    assert json.loads(capsys.readouterr().out.strip()[7:])["error"] == "The request was not valid JSON."


def test_the_studio_key_wins_over_a_machine_wide_one(tmp_path, monkeypatch):
    monkeypatch.setattr(research, "ROOT", tmp_path)
    monkeypatch.setenv("FIRECRAWL_API_KEY", "fc-machinewide000000")
    assert research.api_key() == "fc-machinewide000000", "the environment is the fallback"
    (tmp_path / ".env").write_text("STUDIO_TZ=Asia/Tokyo\nFIRECRAWL_API_KEY=fc-studioown11111111\n", encoding="utf-8")
    assert research.api_key() == "fc-studioown11111111", "the key saved in Settings (.env) wins, read fresh"


def test_the_approved_facts_come_from_the_studio_copy():
    f = research.approved_facts()
    assert f["facts"]["altitude_m"]["value"] == 1444
    assert f["facts"]["field_first_yen"]["value"] == 5200 and f["facts"]["camp_extra_yen"]["value"] == 4200
    assert f["facts"]["charter50_tent_yen"]["value"] == 250000
    assert f["booking"].endswith("/reserve") and "parking" in f["inclusions"]


def test_the_reviewer_knows_the_car_park_quiet_hours_and_winter_facts():
    """39 booked reels were flagged for true words (5 vehicles a night, laugh until 22:00, below freezing in winter):
    the reviewer was never given those facts."""
    from studio.ai import _facts_text

    f = research.approved_facts()
    assert f["facts"]["stopover_vehicles"]["value"] == 5 and f["facts"]["quiet_from_h"]["value"] == 22
    text = " | ".join(_facts_text())
    assert "5 vehicles" in text and "22 o'clock" in text and "below freezing" in text


def test_the_places_own_pages_are_not_trends():
    body = {"data": {"web": [
        {"url": "https://www.instagram.com/p/abc/", "title": "東京新聞に載りました", "description": "嬬恋牧場Work&Campを取り上げていただきました。"},
        {"url": "https://www.youtube.com/watch?v=x", "title": "Autumn at 1444 m: Tsumagoi Work&Camp from the air", "description": "A drone flight."},
        {"url": "https://example.com/glamping", "title": "群馬 グランピング15選", "description": "標高の高い施設。"},
    ]}}
    assert [i["url"] for i in research._items(body, "ja", 30)] == ["https://example.com/glamping"]


def test_the_link_check_never_reaches_this_computer_by_name_or_redirect(monkeypatch):
    """Security review 13 Nov: a public-looking name can resolve to 127.0.0.1 or a LAN host, and a redirect can lead
    there. The free link check refuses both and never connects."""
    import socket

    called = []
    monkeypatch.setattr(research, "_ping_call", lambda *a, **k: called.append(a) or (200, {}, b""))
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("127.0.0.1", 0))])
    assert research._ping("https://looks-public.example/")["why"] == "not a public web address" and not called
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("192.168.1.20", 0))])
    assert research._ping("https://lan.example/")["status"] == "broken" and not called
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: [(2, 1, 6, "", ("93.184.216.34", 0))])
    assert research._ping("https://example.com/")["status"] == "ok" and called
    assert research._NoRedirect().redirect_request(None, None, 302, "Found", {}, "http://127.0.0.1/") is None
