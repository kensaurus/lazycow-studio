"""
FILE: py/studio/shots.py
PURPOSE: Shot boundaries, keyframes, and local scores.
OVERVIEW: PySceneDetect splits a proxy (or the source). OpenCV scores sharpness,
          motion, exposure, and faces. OpenCLIP embeddings are stored when torch is installed.
DEPENDENCIES: scenedetect, cv2, optional open_clip
USAGE: log_shots(con, asset_row)
NOTES: Long scenes are also windowed every 4 seconds so the EDL can pick a piece.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np

from studio.config import DATA, ROOT, ffmpeg_bin
from studio.db import connect

WINDOW = 4.0
YUNET = DATA / "bin" / "face_detection_yunet_2023mar.onnx"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"


def _ensure_yunet() -> Path | None:
    if YUNET.exists():
        return YUNET
    try:
        import urllib.request

        YUNET.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(YUNET_URL, YUNET)
    except OSError:
        return None
    return YUNET if YUNET.exists() else None


def _scenes(path: str) -> list[tuple[float, float]]:
    from scenedetect import SceneManager, open_video
    from scenedetect.detectors import ContentDetector

    video = open_video(path)
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=27.0))
    manager.detect_scenes(video)
    scenes = manager.get_scene_list()
    if not scenes:
        duration = float(video.duration.get_seconds()) if video.duration else 0
        return [(0.0, duration or WINDOW)]
    return [(s[0].get_seconds(), s[1].get_seconds()) for s in scenes]


def _windows(start: float, end: float) -> list[tuple[float, float]]:
    if end - start <= WINDOW * 1.5:
        return [(start, end)]
    cuts = []
    t = start
    while t + 1.0 < end:
        cuts.append((t, min(end, t + WINDOW)))
        t += WINDOW
    return cuts


def _grab(path: str, t: float, dest: Path) -> Path | None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [str(ffmpeg_bin()), "-y", "-ss", f"{t:.3f}", "-i", path, "-frames:v", "1", str(dest)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        return None
    return dest if dest.exists() else None


def _scores(image: np.ndarray, prev: np.ndarray | None, face_det) -> dict:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    exposure = float(gray.mean())
    motion = 0.0
    if prev is not None and prev.shape == gray.shape:
        motion = float(np.abs(gray.astype(np.int16) - prev.astype(np.int16)).mean())
    face = 0
    if face_det is not None:
        face_det.setInputSize((image.shape[1], image.shape[0]))
        _, faces = face_det.detect(image)
        face = 1 if faces is not None and len(faces) else 0
    return {"sharpness": sharpness, "motion": motion, "exposure": exposure, "face": face, "gray": gray}


_CLIP = None


def _embed(image_path: Path) -> Path | None:
    global _CLIP
    try:
        import open_clip
        import torch
        from PIL import Image
    except ImportError:
        return None
    if _CLIP is None:
        model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
        model.eval()
        _CLIP = (model, preprocess, torch)
    model, preprocess, torch = _CLIP
    image = preprocess(Image.open(image_path).convert("RGB")).unsqueeze(0)
    with torch.no_grad():
        vec = model.encode_image(image)
        vec = vec / vec.norm(dim=-1, keepdim=True)
    dest = image_path.with_suffix(".npy")
    np.save(dest, vec.numpy().astype("float32"))
    return dest


def log_asset(asset: dict, embed: bool = False) -> int:
    source = asset["proxy_path"] or asset["path"]
    if not source or not Path(source).exists():
        return 0
    yunet = _ensure_yunet()
    face_det = cv2.FaceDetectorYN.create(str(yunet), "", (320, 320)) if yunet else None
    written = 0
    with connect() as con:
        for start, end in _scenes(source):
            for win_s, win_e in _windows(start, end):
                times = [win_s + 0.3, (win_s + win_e) / 2, max(win_s, win_e - 0.3)]
                frames = []
                paths = []
                prev = None
                score = {"sharpness": 0.0, "motion": 0.0, "exposure": 0.0, "face": 0}
                for index, t in enumerate(times):
                    dest = DATA / "keyframes" / f"{asset['id']}_{win_s:.2f}_{index}.jpg"
                    grabbed = _grab(source, t, dest)
                    if not grabbed:
                        continue
                    paths.append(str(grabbed))
                    image = cv2.imread(str(grabbed))
                    if image is None:
                        continue
                    score = _scores(image, prev, face_det)
                    prev = score.pop("gray")
                    frames.append(score)
                if not paths:
                    continue
                sharp = float(np.mean([f["sharpness"] for f in frames]))
                motion = float(np.max([f["motion"] for f in frames]))
                exposure = float(np.mean([f["exposure"] for f in frames]))
                face = int(any(f["face"] for f in frames))
                embed_path = _embed(Path(paths[1] if len(paths) > 1 else paths[0])) if embed else None
                quality = sharp / (sharp + 80.0)
                if exposure < 15 or exposure > 245:
                    quality *= 0.4
                con.execute(
                    """INSERT INTO shots (asset_id, start_s, end_s, sharpness, motion, exposure, face,
                       embedding_path, quality, keyframes)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(asset_id, start_s, end_s) DO UPDATE SET
                         sharpness=excluded.sharpness, motion=excluded.motion, exposure=excluded.exposure,
                         face=excluded.face, embedding_path=COALESCE(excluded.embedding_path, shots.embedding_path),
                         quality=excluded.quality, keyframes=excluded.keyframes""",
                    (asset["id"], win_s, win_e, sharp, motion, exposure, face, str(embed_path) if embed_path else None, quality, json.dumps(paths)),
                )
                written += 1
    return written


def log_matching(like: str, embed: bool = False, limit: int | None = None) -> int:
    with connect() as con:
        rows = con.execute(
            "SELECT * FROM assets WHERE kind = 'video' AND lower(path) LIKE ? ORDER BY id",
            (f"%{like.lower()}%",),
        ).fetchall()
    count = 0
    shots = 0
    for row in rows:
        if limit is not None and count >= limit:
            break
        shots += log_asset(dict(row), embed=embed)
        count += 1
    return shots
