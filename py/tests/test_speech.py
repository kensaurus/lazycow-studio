"""Subtitles from what people say (studio.speech): placed on the edit's timeline, inside subtitle reading rules."""
import studio.speech as speech


def test_speech_lands_where_the_edit_plays_it():
    said = {"segments": [{"start": 1.0, "end": 3.0, "text": "Look, a lion on the left."},
                         {"start": 9.0, "end": 12.0, "text": "This part is cut out of the edit."}]}
    cs = speech.cues([{"at": 100.0, "from": 0.5, "sec": 6.0, "speech": said}])
    assert len(cs) == 1, "speech outside the used part of the clip is not shown"
    assert cs[0]["start"] == 100.5 and cs[0]["text"] == "Look, a lion on the left."


def test_long_speech_splits_into_two_line_cues_that_never_overlap():
    long = " ".join(["word"] * 40)  # 199 characters
    cs = speech.cues([{"at": 0.0, "from": 0.0, "sec": 20.0, "speech": {"segments": [{"start": 0.0, "end": 16.0, "text": long}]}},
                      {"at": 5.0, "from": 0.0, "sec": 5.0, "speech": {"segments": [{"start": 0.0, "end": 3.0, "text": "Someone else."}]}}])
    assert all(len(line) <= 42 for c in cs for line in c["text"].split("\n"))
    assert all(len(c["text"].split("\n")) <= 2 for c in cs)
    assert all(a["end"] <= b["start"] for a, b in zip(cs, cs[1:]))


def test_srt_format():
    out = speech.srt([{"start": 61.25, "end": 63.0, "text": "Hello\nthere"}])
    assert out == "1\n00:01:01,250 --> 00:01:03,000\nHello\nthere\n\n"
