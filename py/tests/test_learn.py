

def test_each_lesson_the_loop_acts_on_is_written_down(tmp_path, monkeypatch):
    # BL-112: a reel made from a lesson, a retired headline and a test-hour booking each leave one line in lessons.jsonl.
    import studio.config as config
    from studio import learn

    monkeypatch.setattr(config, "DATA", tmp_path)
    learn.note_lesson("reel", "fire-1124", mode="learned", why="Learned: Punch look 1.7×")
    learn.note_lesson("retired", None, ja="区画がないから、好きな場所に張る。")
    got = learn.lessons()
    assert [g["kind"] for g in got] == ["retired", "reel"], "newest first"
    assert got[1]["slug"] == "fire-1124" and got[1]["mode"] == "learned"
    assert (tmp_path / "lessons.jsonl").read_text(encoding="utf-8").count("\n") == 2


def test_a_lesson_line_never_stops_the_work(monkeypatch):
    import studio.config as config
    from studio import learn

    monkeypatch.setattr(config, "DATA", None)  # no data folder: the note is skipped, nothing raises
    learn.note_lesson("reel", "x", mode="explore")
