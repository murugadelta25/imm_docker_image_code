"""Lightweight operator face match against master reference photo (no image retention)."""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Optional, Tuple

# Minimum correlation score (0–1) to accept as same person.
MATCH_THRESHOLD = 0.72

_cv2 = None
_np = None
_import_error = None


def _ensure_cv2():
    """Lazy-load OpenCV so the API can start even if cv2 is not installed yet."""
    global _cv2, _np, _import_error
    if _cv2 is not None:
        return _cv2, _np
    if _import_error is not None:
        raise _import_error
    try:
        import cv2
        import numpy as np
        _cv2 = cv2
        _np = np
        return _cv2, _np
    except ImportError as e:
        _import_error = RuntimeError(
            "OpenCV (cv2) is not installed in this Python environment. "
            "Run: pip install opencv-python-headless numpy"
        )
        raise _import_error from e


def _largest_face(gray) -> Optional[tuple]:
    cv2, _ = _ensure_cv2()
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    return int(x), int(y), int(w), int(h)


def _face_hist(image_path: Path):
    cv2, _ = _ensure_cv2()
    img = cv2.imread(str(image_path))
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    box = _largest_face(gray)
    if not box:
        return None
    x, y, w, h = box
    roi = gray[y : y + h, x : x + w]
    roi = cv2.resize(roi, (128, 128))
    hist = cv2.calcHist([roi], [0], None, [64], [0, 256])
    cv2.normalize(hist, hist)
    return hist


def compare_faces(reference_path: Path, live_path: Path) -> Tuple[bool, float, str]:
    """
    Compare reference master photo vs live capture.
    Returns (verified, score, message). Live file should be deleted by caller.
    """
    try:
        cv2, _ = _ensure_cv2()
    except RuntimeError as e:
        return False, 0.0, str(e)

    if not reference_path.exists():
        return False, 0.0, "No reference photo on file for this operator. Ask admin to upload one in User Management."

    ref_hist = _face_hist(reference_path)
    if ref_hist is None:
        return False, 0.0, "Reference photo has no detectable face. Re-upload a clear front-facing photo."

    live_hist = _face_hist(live_path)
    if live_hist is None:
        return False, 0.0, "No face detected in live capture. Try again with better lighting."

    score = float(cv2.compareHist(ref_hist, live_hist, cv2.HISTCMP_CORREL))
    verified = score >= MATCH_THRESHOLD
    if verified:
        return True, round(score, 3), "Face verified against operator master photo."
    return False, round(score, 3), f"Face does not match operator master photo (score {score:.2f})."


def save_temp_upload(upload_bytes: bytes, suffix: str = ".jpg") -> Path:
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(upload_bytes)
    tmp.close()
    return Path(tmp.name)
