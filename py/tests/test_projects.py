"""A reel project's slug becomes a command-line argument (`studio reels --build <slug>`), so it may never start
with "-", where argparse would read it as an option."""
import pytest

from studio import projects


@pytest.mark.parametrize("slug", ["--build", "-h", "-x1", "", "Fire-1", "fire_1", "../x"])
def test_a_slug_that_could_be_an_option_or_a_path_is_refused(slug, monkeypatch, tmp_path):
    monkeypatch.setattr(projects, "DIR", tmp_path)
    with pytest.raises(ValueError, match="slug"):
        projects.save({"slug": slug})
    assert not list(tmp_path.iterdir())


def test_an_ordinary_slug_is_saved(monkeypatch, tmp_path):
    monkeypatch.setattr(projects, "DIR", tmp_path)
    assert projects.save({"slug": "fire-1110"}).name == "fire-1110.json"
