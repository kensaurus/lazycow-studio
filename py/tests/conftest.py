"""Point the catalog at a throwaway folder before studio.config is imported.

The tests' main project is the built-in reference workspace (Tsumagoi Work&Camp: its themes, place and copy rules are in
the code and shared/spec.json), so STUDIO_RANCH defaults to 1 here. Neutral projects are tested with the `neutral`
fixture (test_brand.py) and a neutral process (test_a_neutral_process_...)."""
import os
import tempfile

os.environ["STUDIO_DATA"] = tempfile.mkdtemp(prefix="tsumagoi-studio-test-")
os.environ["STUDIO_AESTHETIC_FETCH"] = "0"  # no download of the aesthetic head during tests
os.environ.setdefault("STUDIO_RANCH", "1")

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _ai_health_per_test(tmp_path, monkeypatch):
    """Each test starts with no AI service marked out (studio.fallback's <data>/ai-health.json is per test), so one
    test's "out of credit" never sends another test's step to a backup."""
    from studio import fallback

    monkeypatch.setattr(fallback, "health_file", lambda: tmp_path / "ai-health.json")


@pytest.fixture(autouse=True)
def _no_real_keys(tmp_path_factory, monkeypatch):
    """No test sees the owner's real API keys: studio.ai reads <repo>/.env before the environment, so a saved key turned
    a free-music test into a paid AI-music call (21 Nov, the day a Stability key was saved). Each test gets an empty
    .env; a test that needs a key sets it with monkeypatch.setenv or writes this file."""
    from studio import ai

    env = tmp_path_factory.mktemp("keys") / ".env"  # its own folder: some tests check their tmp_path stays empty
    monkeypatch.setattr(ai, "ENV_FILE", env)
    for name in [n for names in ai.registry.key_envs().values() for n in names] + ["FAL_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY"]:
        monkeypatch.delenv(name, raising=False)


def pytest_collection_modifyitems(config, items):
    """A test marked `ranch` reads the owner's own Tsumagoi files (the ranch overlay: shared/reels.json, words,
    house reels). A public clone has none, so it is skipped there with the reason; in the owner's checkout every one runs."""
    import pytest
    from studio.config import RANCH_MARKER

    if RANCH_MARKER.is_file():
        return
    skip = pytest.mark.skip(reason="needs the ranch overlay files (shared/reels.json); not in a public clone")
    for item in items:
        if item.get_closest_marker("ranch"):
            item.add_marker(skip)
