"""Shared upload size limits and safe streaming writes."""
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, UploadFile

MAX_PDF_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024

# Work-instruction document uploads (Part Master / revision history)
WI_DOC_EXTENSIONS = frozenset({".pdf", ".jpg", ".jpeg", ".png", ".svg"})
WI_DOC_IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".svg"})
WI_DOC_ALLOWED_MSG = "Allowed formats: PDF, JPEG, PNG, SVG"


def wi_doc_max_bytes(ext: str) -> int:
    if ext in WI_DOC_IMAGE_EXTENSIONS:
        return MAX_IMAGE_BYTES
    return MAX_PDF_BYTES


def assert_wi_doc_extension(ext: str) -> None:
    if ext not in WI_DOC_EXTENSIONS:
        raise HTTPException(400, WI_DOC_ALLOWED_MSG)

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
MAX_OPTIONS_LIMIT = 500
MAX_REVISION_HISTORY = 200

_CHUNK = 64 * 1024


def _mb_label(max_bytes: int) -> str:
    return f"{max_bytes // (1024 * 1024)} MB"


async def save_upload_limited(upload: UploadFile, dest: Path, max_bytes: int) -> int:
    """Stream upload to disk; abort and delete partial file if over max_bytes."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with dest.open("wb") as buf:
            while True:
                chunk = await upload.read(_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise HTTPException(
                        400,
                        f"File exceeds maximum size of {_mb_label(max_bytes)}",
                    )
                buf.write(chunk)
    except HTTPException:
        if dest.exists():
            dest.unlink(missing_ok=True)
        raise
    except OSError as exc:
        if dest.exists():
            dest.unlink(missing_ok=True)
        raise HTTPException(500, f"Failed to save file: {exc}") from exc
    return written


def clamp_page_size(page_size: int, default: int = DEFAULT_PAGE_SIZE) -> int:
    if page_size < 1:
        return default
    return min(page_size, MAX_PAGE_SIZE)
