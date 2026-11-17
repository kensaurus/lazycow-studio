"""Your own model server (Ollama, LM Studio, vLLM, any OpenAI-compatible API) in place of OpenRouter: the writing jobs
and the picture questions go there, with no OpenRouter key and nothing charged; unset, nothing changes."""
import json

import pytest

from studio import ai, config, research


@pytest.fixture
def own(monkeypatch):
    for k in ("STUDIO_LLM_BASE_URL", "STUDIO_LLM_MODEL", "STUDIO_LLM_VISION_MODEL", "STUDIO_LLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(config, "_llm_file", lambda: {})

    def use(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
    return use


def test_unset_means_openrouter_as_before(own):
    assert config.own_llm() is None and config.own_llm(vision=True) is None
    own(STUDIO_LLM_BASE_URL="ftp://nope", STUDIO_LLM_MODEL="m")
    assert config.own_llm() is None, "only http(s) addresses"


def test_the_address_and_models_are_read_from_env(own):
    own(STUDIO_LLM_BASE_URL="http://127.0.0.1:11434/v1/", STUDIO_LLM_MODEL="qwen2.5:7b")
    assert config.own_llm() == {"url": "http://127.0.0.1:11434/v1/chat/completions", "model": "qwen2.5:7b", "key": ""}
    assert config.own_llm(vision=True) is None, "no vision model named: picture questions stay with OpenRouter"


def test_writing_jobs_go_to_your_server_without_a_key(own, monkeypatch):
    own(STUDIO_LLM_BASE_URL="http://127.0.0.1:1234/v1", STUDIO_LLM_MODEL="local-model", STUDIO_LLM_API_KEY="lm-studio")
    monkeypatch.setattr(research, "_llm_key", lambda: "")
    monkeypatch.setattr(research, "_cache_get", lambda k: None)
    monkeypatch.setattr(research, "_cache_put", lambda *a: None)
    sent = {}

    def http(method, url, data=None, headers=None, timeout=60):
        sent.update(url=url, body=json.loads(data), headers=headers)
        return 200, {}, json.dumps({"choices": [{"message": {"content": "```json\n{\"angles\": []}\n```"}}]}).encode()
    monkeypatch.setattr(research, "_http", http)
    assert research._llm("sys", "user") == {"angles": []}
    assert sent["url"] == "http://127.0.0.1:1234/v1/chat/completions" and sent["body"]["model"] == "local-model"
    assert sent["headers"]["Authorization"] == "Bearer lm-studio" and "reasoning" not in sent["body"]


def test_picture_questions_go_to_your_vision_model_and_charge_nothing(own, monkeypatch, tmp_path):
    own(STUDIO_LLM_BASE_URL="http://127.0.0.1:11434/v1", STUDIO_LLM_MODEL="qwen2.5:7b", STUDIO_LLM_VISION_MODEL="qwen2.5vl:7b")
    pic = tmp_path / "a.jpg"
    pic.write_bytes(b"\xff\xd8jpeg")
    monkeypatch.setattr(ai, "reviewer_key", lambda: "")
    monkeypatch.setattr(ai, "charge", lambda *a, **k: pytest.fail("your own model is not charged"))
    sent = {}

    def http(method, url, who="", data=None, headers=None, timeout=60):
        sent.update(url=url, body=json.loads(data), headers=headers)
        return 200, {}, json.dumps({"choices": [{"message": {"content": "Here: {\"title\": \"浅間山\"}"}}]}).encode()
    monkeypatch.setattr(ai, "_http", http)
    assert ai.vision_json([pic], "sys", "what is this", "reel-a") == {"title": "浅間山"}
    assert sent["body"]["model"] == "qwen2.5vl:7b" and "Authorization" not in sent["headers"]
    assert sent["body"]["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_a_refusal_from_your_server_says_where(own, monkeypatch, tmp_path):
    own(STUDIO_LLM_BASE_URL="http://127.0.0.1:11434/v1", STUDIO_LLM_MODEL="m", STUDIO_LLM_VISION_MODEL="v")
    pic = tmp_path / "a.jpg"
    pic.write_bytes(b"x")
    monkeypatch.setattr(ai, "_http", lambda *a, **k: (404, {}, b'{"error": "model \\"v\\" not found"}'))
    with pytest.raises(ai.AiError, match="127.0.0.1:11434"):
        ai.vision_json([pic], "s", "p", "reel-a")


def test_settings_save_checks_the_server_lists_the_model_then_writes_env(own, monkeypatch, tmp_path):
    env = tmp_path / ".env"
    env.write_text("FAL_KEY=x\n", encoding="utf-8")
    monkeypatch.setattr(ai, "ENV_FILE", env)
    monkeypatch.setattr(config, "_llm_file", lambda: {k: v for k, v in config._parse_env(env).items() if k.startswith("STUDIO_LLM_")})
    listed = json.dumps({"data": [{"id": "qwen2.5:7b-instruct"}, {"id": "qwen2.5vl:7b"}]}).encode()
    monkeypatch.setattr(ai, "_http", lambda method, url, who="", **k: (200, {}, listed) if url.endswith("/models") else pytest.fail(url))
    with pytest.raises(ai.AiError, match="not on that server. It has: qwen2.5:7b-instruct"):
        ai.save_llm({"base_url": "http://127.0.0.1:11434/v1", "model": "llama3"})
    assert "STUDIO_LLM" not in env.read_text(encoding="utf-8"), "a refused setting writes nothing"
    out = ai.save_llm({"base_url": "http://127.0.0.1:11434/v1/", "model": "qwen2.5:7b-instruct", "vision_model": "qwen2.5vl:7b"})
    assert out["ownLlm"] == {"url": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b-instruct", "visionModel": "qwen2.5vl:7b", "hasKey": False}
    assert "FAL_KEY=x" in env.read_text(encoding="utf-8"), "other settings stay"
    assert ai.save_llm({"base_url": ""})["removed"] and config.own_llm() is None
    assert "STUDIO_LLM" not in env.read_text(encoding="utf-8")


@pytest.mark.parametrize("bad", ["127.0.0.1:11434", "javascript:alert(1)", "http://x\nSTUDIO_PY=evil"])
def test_settings_refuse_an_address_that_is_not_a_plain_url(own, bad):
    with pytest.raises(ai.AiError, match="must start with http"):
        ai.save_llm({"base_url": bad, "model": "m"})


def test_a_server_that_refuses_json_mode_is_asked_again_in_plain_text(own, monkeypatch):
    """LM Studio answers 400 to response_format json_object (it takes json_schema or text only)."""
    own(STUDIO_LLM_BASE_URL="http://127.0.0.1:1234/v1", STUDIO_LLM_MODEL="local-model")
    monkeypatch.setattr(research, "_cache_get", lambda k: None)
    monkeypatch.setattr(research, "_cache_put", lambda *a: None)
    calls = []

    def http(method, url, data=None, headers=None, timeout=60):
        body = json.loads(data)
        calls.append("response_format" in body)
        if "response_format" in body:
            return 400, {}, b'{"error": "response_format.type must be json_schema or text"}'
        return 200, {}, json.dumps({"choices": [{"message": {"content": "Sure: {\"angles\": [1]}"}}]}).encode()
    monkeypatch.setattr(research, "_http", http)
    assert research._llm("sys", "user") == {"angles": [1]} and calls == [True, False]
