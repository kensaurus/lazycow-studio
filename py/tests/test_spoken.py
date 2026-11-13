"""Word-by-word captions get the voice's own timing (reels.spoken_spans), and saving a reel from the editor keeps what
the AI tools added: the voice, the AI notes and each shot's AI clip (projects.keep_ai)."""
import studio.projects as projects
from studio.reels import spoken_spans

BEATS = [
    {"kind": "hook", "ja": "朝は\n霧の中", "startSec": 0.0, "endSec": 2.5},
    {"kind": "line", "ja": "標高1444m", "startSec": 3.0, "endSec": 5.0},
    {"kind": "end", "ja": "嬬恋牧場", "startSec": 6.0, "endSec": 8.0},
]
VOICE = {"lines": [{"text": "朝は霧の中", "at": 0.15, "seconds": 1.8, "tempo": 1.2, "file": "a.mp3"},
                   {"text": "標高1444m", "at": 3.15, "seconds": 1.5, "tempo": 1.0, "file": "b.mp3"}]}


def test_spans_follow_the_voice_clips():
    out = spoken_spans(BEATS, VOICE)
    assert out[0]["spoken"] == {"from": 0.15, "to": 1.65}  # 1.8 s at 1.2x
    assert out[1]["spoken"] == {"from": 3.15, "to": 4.65}
    assert "spoken" not in out[2]
    assert "spoken" not in BEATS[0], "the beats passed in are not changed"


def test_no_voice_or_switched_off_leaves_the_words_still():
    assert spoken_spans(BEATS, None) == BEATS
    assert all("spoken" not in b for b in spoken_spans(BEATS, VOICE, on=False))
    assert all("spoken" not in b for b in spoken_spans(BEATS, {"lines": [{"text": "別の言葉", "at": 0, "seconds": 1}]}))


def test_saving_from_the_editor_keeps_the_ai_work(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "DIR", tmp_path)
    old = {"slug": "fire-1111", "voice": VOICE, "ai": [{"tool": "voice", "label_required": True}],
           "shots": [{"src": "a.mp4", "sec": 2, "ai_clip": {"tool": "slowmo", "file": "a_slow.mp4"}}, {"src": "b.mp4", "sec": 2}]}
    projects.save(old)
    edited = {"slug": "fire-1111", "shots": [{"src": "b.mp4", "sec": 3}, {"src": "a.mp4", "sec": 2}, {"src": "c.mp4", "sec": 1}]}
    got = projects.keep_ai(edited)
    assert got["voice"] == VOICE and got["ai"][0]["label_required"] is True
    assert got["shots"][1]["ai_clip"]["file"] == "a_slow.mp4", "the clip follows its source when shots move"
    assert "ai_clip" not in got["shots"][0] and "ai_clip" not in got["shots"][2]
    assert projects.keep_ai({"slug": "new-reel", "shots": []}) == {"slug": "new-reel", "shots": []}
