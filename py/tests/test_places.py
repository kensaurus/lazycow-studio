"""Place names, offline (studio.places): small GeoNames-shaped files stand in for the real downloads."""
import io
import zipfile

import pytest

from studio import places


def _row(gid, name, alts, lat, lon, fclass, fcode, cc, admin1, pop=0):
    # GeoNames' 19 tab-separated columns (https://download.geonames.org/export/dump/readme.txt)
    return "\t".join([str(gid), name, name, alts, str(lat), str(lon), fclass, fcode, cc, "", admin1, "", "", "", str(pop), "", "0", "Asia/Tokyo", "2026-01-01"])


WORLD = [
    _row(1, "Midori", "Midori,みどりむら,緑村", 36.516, 138.530, "P", "PPLA3", "JP", "10", 9000),
    _row(2, "Naganohara", "Naganohara,長野原町", 36.552, 138.637, "P", "PPL", "JP", "10", 5000),
    _row(3, "Tokyo", "Tokyo,東京,とうきょう", 35.6895, 139.6917, "P", "PPLC", "JP", "40", 9000000),
    _row(4, "Nairobi", "Nairobi,内罗毕,ナイロビ", -1.2833, 36.8167, "P", "PPLC", "KE", "05", 2750547),
]
JP = [
    _row(1863501, "Gunma", "Gunma,Gunma-ken,群馬県", 36.5, 139.0, "A", "ADM1", "JP", "10"),
    _row(11, "Kanbara", "Kanbara,鎌原", 36.588, 138.512, "P", "PPL", "JP", "10", 300),
    _row(12, "Yunomaru-yama", "Yunomaru,ゆのまるやま,湯ノ丸山", 36.570, 138.520, "T", "MT", "JP", "10"),
    _row(13, "Asama-yama", "Asama,浅間山", 36.4064, 138.5231, "T", "VLC", "JP", "10"),
    _row(14, "Some stream", "", 36.589, 138.510, "H", "STM", "JP", "10"),  # not a notable feature
]
ADMIN1 = "JP.10\tGunma\tGunma\t1863501\nJP.40\tTokyo\tTokyo\t1850144\nKE.05\tNairobi Area\tNairobi Area\t184742\n"
RANCH = (36.5893, 138.5096)


@pytest.fixture
def pdir(tmp_path, monkeypatch):
    monkeypatch.setattr(places, "places_dir", lambda: tmp_path)
    places._CACHE.update(key=None, index=None)
    return tmp_path


def test_without_the_files_nothing_is_named_and_nothing_breaks(pdir):
    assert places.index() is None and places.reverse(*RANCH) is None and places.label(*RANCH) is None
    assert places.status() == {"world": False, "countries": [], "admin": False, "bytes": 0}
    assert places.suggest_country([RANCH]) is None


def test_world_towns_name_the_nearest_town_and_suggest_the_countrys_detail(pdir):
    (pdir / "cities1000.txt").write_text("\n".join(WORLD) + "\n", encoding="utf-8")
    (pdir / "admin1CodesASCII.txt").write_text(ADMIN1, encoding="utf-8")
    p = places.reverse(*RANCH)
    assert (p["name"], p["nameJa"], p["admin"], p["country"]) == ("Midori", "緑村", "Gunma", "JP")
    assert 7 < p["km"] < 10
    assert places.label(*RANCH)["feature"] is None, "the world file has towns only"
    nai = places.reverse(-1.30, 36.80)
    assert (nai["name"], nai["nameJa"], nai["admin"]) == ("Nairobi", "ナイロビ", "Nairobi Area"), "abroad: the katakana name"
    assert places.reverse(-40.0, -140.0) is None, "the middle of the Pacific: no town within 300 km"
    assert places.suggest_country([RANCH, (35.68, 139.69)]) == "JP"
    assert places.status()["world"] is True


def test_a_country_file_adds_villages_mountains_and_the_prefectures_japanese_name(pdir):
    (pdir / "cities1000.txt").write_text("\n".join(WORLD) + "\n", encoding="utf-8")
    (pdir / "JP.txt").write_text("\n".join(JP) + "\n", encoding="utf-8")
    (pdir / "admin1CodesASCII.txt").write_text(ADMIN1, encoding="utf-8")
    p = places.label(*RANCH)
    assert (p["name"], p["nameJa"], p["admin"], p["adminJa"]) == ("Kanbara", "鎌原", "Gunma", "群馬県")
    assert p["km"] < 0.5
    assert p["feature"]["name"] == "Yunomaru-yama" and p["feature"]["nameJa"] == "湯ノ丸山" and p["feature"]["kind"] == "mountain"
    assert p["feature"]["km"] < 5, "Asama (20 km off) is not named; the stream is not a notable feature"
    assert places.suggest_country([RANCH]) is None, "Japan's detail is here already"
    assert places.status()["countries"] == ["JP"]


def _zip(member, text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(member, text)
    return buf.getvalue()


class _Resp:
    def __init__(self, data, length=None):
        self.data, self.headers = io.BytesIO(data), {"Content-Length": str(len(data) if length is None else length)}

    def read(self, n):
        return self.data.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_a_country_download_is_unpacked_checked_and_named_with_who_asked(pdir):
    asked = []
    body = _zip("JP.txt", "\n".join(JP * 10) + "\n")

    def opener(req, timeout):
        asked.append((req.full_url, req.get_header("User-agent")))
        return _Resp(body)

    out = places.download("jp", progress=lambda *a, **k: None, opener=opener)
    assert out["file"] == "JP.txt" and out["countries"] == ["JP"] and (pdir / "JP.txt").exists()
    assert asked[0][0] == "https://download.geonames.org/export/dump/JP.zip"
    assert asked[0][1].startswith("LazycowStudio/") and "github.com" in asked[0][1]
    assert not list(pdir.glob("*.part")) and "JP.txt" in (pdir / "sources.json").read_text(encoding="utf-8")


def test_a_cut_short_or_wrong_download_is_refused_and_leaves_nothing(pdir):
    body = _zip("JP.txt", "\n".join(JP * 10) + "\n")
    with pytest.raises(OSError, match="cut short"):
        places.download("JP", progress=lambda *a, **k: None, opener=lambda req, timeout: _Resp(body[:500], length=len(body)))
    with pytest.raises(OSError, match="not the GeoNames file"):
        places.download("JP", progress=lambda *a, **k: None, opener=lambda req, timeout: _Resp(_zip("other.txt", "x" * 5000)))
    with pytest.raises(ValueError):
        places.download("../etc", progress=lambda *a, **k: None, opener=lambda req, timeout: _Resp(body))
    assert not (pdir / "JP.txt").exists() and not list(pdir.glob("*.part"))
