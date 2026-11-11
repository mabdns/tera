"""Independent, label-bounded OCR retries; no spreadsheet or name dictionary input."""
import base64
import json
from pathlib import Path
from collections import Counter
import re
import shutil
import subprocess

import cv2
import numpy as np

from ocr_layout import NAME_LABEL, ROLE, NEXT_ITEM, PARENT_SECTION

ROOT = Path(__file__).resolve().parent
GREGORIAN_MONTH = re.compile(
    r"\b(?:januari|februari|pebruari|maret|april|mei|juni|juli|agustus|"
    r"september|oktober|november|nopember|desember)\b", re.I)
HIJRI_MONTH = re.compile(r"\b(?:muharr?am|safar|shafar|rabi\w*|rabt\w*|jumad\w*|rajab|sya\w*|ramad\w*|dzul\w*|zul\w*)\b", re.I)


def line_crop(image, quads):
    """Straighten just the detected value, not the two differently tilted pages."""
    points = np.concatenate([np.asarray(q, np.float32) for q in quads])
    rect = cv2.minAreaRect(points)
    corners = cv2.boxPoints(rect)
    ordered = corners[np.argsort(corners[:, 0])]
    left = ordered[:2][np.argsort(ordered[:2, 1])]
    right = ordered[2:][np.argsort(ordered[2:, 1])]
    quad = np.array([left[0], right[0], right[1], left[1]], np.float32)
    width = int(max(np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[2] - quad[3])))
    height = int(max(np.linalg.norm(quad[3] - quad[0]), np.linalg.norm(quad[2] - quad[1])))
    if width < 3 or height < 3:
        return None
    # Retain a little context outside detector bounds so thin edge strokes survive.
    center = quad.mean(axis=0)
    quad = center + (quad - center) * np.array([1 + 8 / width, 1 + 6 / height])
    width, height = width + 8, height + 6
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], np.float32)
    crop = cv2.warpPerspective(image, cv2.getPerspectiveTransform(quad.astype(np.float32), target),
                               (width, height), borderValue=(255, 255, 255))
    # Upscaling helps the existing Tesseract model with small printed glyphs.
    scale = max(1.0, min(3.0, 64 / height))
    return cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def clean_form_dots(crop):
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink)
    clean = np.zeros_like(ink)
    for index in range(1, count):
        _, _, width, height, area = stats[index]
        if height >= crop.shape[0] * 0.22 and area >= crop.shape[0] * 0.45:
            clean[labels == index] = 255
    return cv2.copyMakeBorder(255 - clean, 16, 16, 16, 16, cv2.BORDER_CONSTANT, value=255)


def curved_day_slot(day, month, boxes):
    """Require the printed tanggal/bulan labels around a curved date slot."""
    # Explicit Hijriyah month/year evidence rules out borrowing that row's day
    # even when curved printing makes it close to the Gregorian baseline.
    for hijri_month in boxes:
        if not HIJRI_MONTH.search(hijri_month["text"]):
            continue
        for year in boxes:
            if not re.fullmatch(r"[\s.,:=-]*1[2-5]\d{2}[\s.,:=-]*", year["text"]):
                continue
            if not day["cx"] < hijri_month["cx"] < year["cx"]:
                continue
            slope = (year["cy"] - hijri_month["cy"]) / (year["cx"] - hijri_month["cx"])
            projected = hijri_month["cy"] + slope * (day["cx"] - hijri_month["cx"])
            if abs(slope) <= 0.1 and abs(day["cy"] - projected) <= 0.65 * min(day["h"], hijri_month["h"], year["h"]):
                return []
    labels = lambda word: [b for b in boxes if re.fullmatch(r"[\s.,:=-]*" + word + r"[\s.,:=-]*", b["text"], re.I)]
    for right in labels("bulan"):
        # This must be the label immediately before the Gregorian month word,
        # rather than a lower Hijriyah line's bulan label.
        if not day["cx"] < right["cx"] < month["cx"]:
            continue
        if abs(right["cy"] - month["cy"]) > 1.5 * min(right["h"], month["h"]):
            continue
        for left in labels("tanggal"):
            if not left["cx"] < day["cx"]:
                continue
            if (np.max(left["quad"][:, 0]) >= np.min(day["quad"][:, 0])
                    or np.max(day["quad"][:, 0]) >= np.min(right["quad"][:, 0])):
                continue
            projected = left["cy"] + (right["cy"] - left["cy"]) * (day["cx"] - left["cx"]) / (right["cx"] - left["cx"])
            if abs(day["cy"] - projected) <= min(day["h"], left["h"], right["h"]):
                return [left, right]
    return []


def header_date_candidate(image, rows, engine, extract_date):
    """Redetect the bounded header at full detail, then require a same-line date."""
    header_boxes = []
    for row in rows:
        text = " ".join(b.get("text", "") for b in row)
        if ROLE.search(text) or NAME_LABEL.search(text) or NEXT_ITEM.search(text) or PARENT_SECTION.search(text):
            break
        header_boxes.extend(row)
    context = " ".join(b.get("text", "") for b in header_boxes)
    if not header_boxes or not re.search(r"(?:pada\s*hari|akad\s*nikah|masehi)", context, re.I):
        return None
    x0 = max(0, int(min(b["x0"] for b in header_boxes)) - 12)
    y0 = max(0, int(min(b["y0"] for b in header_boxes)) - 12)
    x1 = min(image.shape[1] // 2, int(max(b["x1"] for b in header_boxes)) + 12)
    y1 = min(image.shape[0], int(max(b["y1"] for b in header_boxes)) + 6)
    crop = image[y0:y1, x0:x1]
    if not crop.size:
        return None
    # Tiny day digits can disappear in a detector's rounded resize. Redetect the
    # small header at 2x, while reporting all evidence in original page pixels.
    predictions, _ = engine(cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
    boxes = []
    for quad, text, confidence in predictions or []:
        quad = np.asarray(quad, np.float32) / 2 + np.array([x0, y0], np.float32)
        center = quad.mean(axis=0)
        boxes.append({"quad": quad, "text": str(text), "confidence": float(confidence),
                      "cx": float(center[0]), "cy": float(center[1]),
                      "h": float(max(quad[:, 1]) - min(quad[:, 1]))})
    # Day/month/year must share a baseline; never borrow a Hijriyah day or birth date.
    candidates = []
    for month in boxes:
        match = GREGORIAN_MONTH.search(month["text"])
        if not match:
            continue
        for year in boxes:
            year_match = re.fullmatch(r"[\s.,:=-]*((?:19|20)\d{2})[\s.,:=-]*", year["text"])
            if not year_match or year["cx"] <= month["cx"]:
                continue
            slope = (year["cy"] - month["cy"]) / (year["cx"] - month["cx"])
            if abs(slope) > 0.10:
                continue
            for day in boxes:
                day_match = re.fullmatch(r"[\s.,:=-]*([0-3]?\d)[\s.,:=-]*", day["text"])
                if not day_match or day["cx"] >= month["cx"]:
                    continue
                projected = month["cy"] + slope * (day["cx"] - month["cx"])
                slot_labels = []
                if abs(day["cy"] - projected) > 0.65 * min(day["h"], month["h"], year["h"]):
                    # On a curved book, nearby printed field labels can provide
                    # local alignment that a straight month/year baseline lacks.
                    # Do not loosen the baseline test without that evidence.
                    if abs(day["cy"] - projected) > 3 * min(day["h"], month["h"], year["h"]):
                        continue
                    slot_labels = curved_day_slot(day, month, boxes)
                    if not slot_labels:
                        continue
                raw = f"{day_match[1]} {match[0]} {year_match[1]}"
                value = extract_date(["Akad nikah " + raw])
                if value:
                    candidates.append((value, raw, [day, month, year] + slot_labels))
    if len({value for value, _, _ in candidates}) != 1:
        return None
    value, raw, selected = candidates[0]
    return value, {"rawText": raw, "headerContext": context, "status": "review", "page": 2,
                   "source": "local-header-region", "warnings": ["verify_date_against_scan"] + (["curved_date_slot_check_labels"] if len(selected) > 3 else []),
                   "confidence": min(b["confidence"] for b in selected),
                   "boxes": [b["quad"].tolist() for b in selected],
                   "coordinateSpace": "normalized_page_pixels"}


def recognize_regions(regions):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js tidak tersedia untuk pembacaan area Tesseract lokal")
    completed = subprocess.run([node, str(ROOT / "ocr_refine.mjs")],
                               input=json.dumps({"regions": regions}), capture_output=True,
                               text=True, encoding="utf-8", cwd=ROOT, timeout=45, check=False)
    if completed.returncode:
        raise RuntimeError("Pembacaan area Tesseract lokal gagal: " + completed.stderr.strip()[:300])
    return json.loads(completed.stdout)["results"]


def number_region_candidate(image, rows, extract_number):
    """Reread a detected four-part number; never repair glyphs by substitution."""
    boxes = [b for row in rows for b in row]
    labels = [b for b in boxes if re.search(r"nomor\s*akta", b.get("text", ""), re.I)]
    if not labels:
        return None
    candidates = [b for b in boxes if re.fullmatch(
        r"[\s.]*[0-9QO]{1,4}/\d{1,4}/[I1VX]+/(?:19|20)\d{2}[\s.]*", b.get("text", ""), re.I)
        and any(b['cx'] > label['cx'] and abs(b['cy'] - label['cy']) <=
                1.5 * max(b['h'], label['h']) for label in labels)]
    if len(candidates) != 1:
        return None
    target = candidates[0]
    crop = line_crop(image, [target["quad"]])
    if crop is None:
        return None
    regions = []
    cleaned = clean_form_dots(crop)
    for index, variant in enumerate((crop, cleaned, cv2.resize(cleaned, None, fx=1.5, fy=1.5))):
        ok, png = cv2.imencode('.png', variant)
        if ok:
            regions.append({"id": f"number_{index}", "kind": "number", "image":
                            "data:image/png;base64," + base64.b64encode(png).decode('ascii')})
    readings = recognize_regions(regions)
    requested = {r['id'] for r in regions}
    values = {r.get('id'): extract_number([r.get('text', '')]) for r in readings
              if r.get('id') in requested and isinstance(r.get('text'), str)}
    values = {key: value for key, value in values.items() if value}
    if len(values) < 2 or len(set(values.values())) != 1:
        return None
    value = next(iter(values.values()))
    warnings = ["verify_number_against_scan"]
    if re.search(r'/\d{1,2}/(?:19|20)\d{2}$', value):
        warnings.append('verify_numeric_month_against_roman_numeral')
    return value, {"rawText": value, "status": "review", "page": 1,
                   "source": "local-number-region", "warnings": warnings,
                   "previousReading": target.get('text'), "regionReadings": readings,
                   "boxes": [target['quad'].tolist()], "coordinateSpace": "normalized_page_pixels"}


def refine_spouse_names(image, response, clean_name, valid_name):
    regions = []
    for field in ("namaSuami", "namaIstri"):
        detail = response["fieldDetails"].get(field, {})
        quads = detail.get("boxes")
        if not quads or (response["data"][field] and detail.get("status") != "review"):
            continue
        crop = line_crop(image, quads)
        if crop is None:
            continue
        cleaned = clean_form_dots(crop)
        # Require repeated readings at different raster sizes rather than picking
        # the highest confidence (which can still confidently confuse I and T).
        for index, scale in enumerate((0.75, 1.0, 1.5)):
            variant = cv2.resize(cleaned, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            ok, png = cv2.imencode(".png", variant)
            if ok:
                regions.append({"id": f"{field}_{index}", "kind": "name",
                                "image": "data:image/png;base64," + base64.b64encode(png).decode("ascii")})
    if not regions:
        return
    try:
        results = recognize_regions(regions)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        response["warnings"].append(f"Pembacaan ulang nama belum tersedia: {error}")
        return
    requested = {r["id"] for r in regions}
    readings = {field: [] for field in ("namaSuami", "namaIstri")}
    seen = set()
    for result in results:
        region_id, raw = result.get("id"), result.get("text", "")
        if region_id not in requested or region_id in seen:
            continue
        seen.add(region_id)
        if not isinstance(raw, str) or not valid_name(raw):
            continue
        value = clean_name(raw)
        if value and valid_name(value):
            readings[region_id.rsplit("_", 1)[0]].append({
                "text": value, "rawText": raw, "confidence": result.get("confidence", 0) / 100})
    for field, candidates in readings.items():
        if not candidates:
            continue
        detail = response["fieldDetails"][field]
        detail["regionReadings"] = candidates
        letter_key = lambda text: re.sub(r"[\s.,]", "", text.upper())
        votes = Counter(letter_key(candidate["text"]) for candidate in candidates)
        voted_key, count = votes.most_common(1)[0]
        value = Counter(candidate["text"] for candidate in candidates
                        if letter_key(candidate["text"]) == voted_key).most_common(1)[0][0]
        if count < 2:
            detail["status"] = "review"
            detail.setdefault("warnings", []).append("region_readings_disagree")
            continue
        selected = [candidate for candidate in candidates if letter_key(candidate["text"]) == voted_key]
        previous = response["data"][field]
        # Variants from one OCR engine are correlated, not independent votes.
        # When its minority candidate agrees with the primary engine's letters,
        # retain that cross-engine reading instead of replacing F with E merely
        # because two raster sizes repeat the same error. Preserve every raw
        # candidate and keep the result subject to review.
        if (previous and letter_key(previous) != letter_key(value)
                and detail.get("confidence", 0) >= 0.94
                and not any(w in detail.get("warnings", []) for w in
                            ("low_ocr_confidence", "word_boundaries_uncertain", "preprocessing_disagreement"))):
            detail["alternativeText"] = value
            detail["status"] = "review"
            detail.setdefault("warnings", []).append("ocr_engine_disagreement_primary_retained")
            continue
        shared = [candidate for candidate in candidates
                  if previous and letter_key(candidate["text"]) == letter_key(previous)]
        cross_engine_agreement = bool(shared and letter_key(value) != letter_key(previous))
        consensus_value = value
        if cross_engine_agreement:
            value = shared[0]["text"]
            selected = [candidate for candidate in shared if candidate["text"] == value]
        raw = selected[0]["rawText"]
        # A bounded, dot-cleaned line is the new reading, not a dictionary correction.
        # Preserve the earlier model output as evidence when engines disagree.
        warnings = ["verify_name_against_scan", "form_dots_removed_check_punctuation"]
        if cross_engine_agreement:
            warnings.append("cross_engine_candidate_agreement_check_alternatives")
        if previous and previous != value:
            warnings.append("ocr_engine_disagreement")
        response["data"][field] = value
        response["fieldDetails"][field] = {
            "rawText": raw, "status": "review", "page": 2, "source": "local-tesseract-region",
            "confidence": min(candidate["confidence"] for candidate in selected),
            "regionReadings": candidates,
            "boxes": detail["boxes"], "coordinateSpace": detail["coordinateSpace"],
            "warnings": list(dict.fromkeys(detail.get("warnings", []) + warnings)),
            "previousReading": {"text": previous, "details": detail},
        }
        if cross_engine_agreement:
            response["fieldDetails"][field]["alternativeText"] = consensus_value
    response["requiresReview"] = True
