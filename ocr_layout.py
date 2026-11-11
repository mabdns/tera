"""Geometry-preserving, anchor-based Model N extraction (no document training data)."""
import re
from time import perf_counter

import cv2
import numpy as np


NAME_LABEL = re.compile(
    r"(?<![A-Za-z0-9])(?:[1Il][.)]?\s*)?(?:nama|narna|nauna)\s*(?:lengkap|leugkap|keugkap)\b(?:\s+dan\s+alias)?\s*[:.=-]?",
    re.I,
)
ROLE = re.compile(r"\b(?:calon\s+)?(suami|istri|isteri)\b", re.I)
NEXT_ITEM = re.compile(
    r"\b(?:tempat|lahir|kewarganegaraan|pekerjaan|alamat|nomor\s+induk|NIK)\b|^\s*2\s*[.)]",
    re.I,
)
PARENT_SECTION = re.compile(r"\b(?:orang\s*tua|ayah|ibu|kandung|wali)\b|^\s*[89]\s*[.)]", re.I)
HEADER_WORDS = re.compile(
    r"\b(?:pada\s+hari|bulan|tahun|hijriyah|masehi|akad|tanggal|dilangsungkan)\b", re.I
)


def prepare_page(image):
    """Conservatively remove a dark scanner surround and deskew long printed lines."""
    original_h, original_w = image.shape[:2]
    scale = min(1.0, 1000 / max(original_h, original_w))
    small = cv2.resize(image, None, fx=scale, fy=scale)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    _, paper = cv2.threshold(gray, 164, 255, cv2.THRESH_BINARY)
    paper = cv2.morphologyEx(paper, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(paper, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bounds = (0, 0, original_w, original_h)
    if contours:
        contour = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(contour)
        # Only crop a substantial, predominantly light rectangular paper region.
        if (cv2.contourArea(contour) > gray.size * 0.45
                and cv2.contourArea(contour) / (w * h) > 0.8):
            pad = 5
            x0 = max(0, int((x - pad) / scale))
            y0 = max(0, int((y - pad) / scale))
            x1 = min(original_w, int((x + w + pad) / scale))
            y1 = min(original_h, int((y + h + pad) / scale))
            bounds = (x0, y0, x1, y1)
    x0, y0, x1, y1 = bounds
    page = image[y0:y1, x0:x1]
    scale = min(1.0, 1000 / max(page.shape[:2]))
    small = cv2.resize(page, None, fx=scale, fy=scale)
    edges = cv2.Canny(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 60, 160)
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 1800, threshold=60,
        minLineLength=max(60, int(small.shape[1] * 0.18)), maxLineGap=15,
    )
    angles = []
    if lines is not None:
        for x1l, y1l, x2l, y2l in lines[:, 0]:
            angle = np.degrees(np.arctan2(y2l - y1l, x2l - x1l))
            if abs(angle) <= 6:
                angles.append(angle)
    angle = 0.0
    if len(angles) >= 4:
        median = float(np.median(angles))
        if np.median(np.abs(np.array(angles) - median)) < 1.0:
            angle = median
    if abs(angle) >= 0.25:
        h, w = page.shape[:2]
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1)
        # Expand the canvas so deskewing does not clip edge fields.
        cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
        nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
        matrix[0, 2] += (nw - w) / 2
        matrix[1, 2] += (nh - h) / 2
        page = cv2.warpAffine(page, matrix, (nw, nh), borderValue=(255, 255, 255))
    return page, {"paperBounds": list(bounds), "deskewDegrees": round(angle, 3)}


def rows_from_boxes(boxes):
    """Group by the median baseline, not a chain of adjacent box centers."""
    rows = []
    for box in sorted(boxes, key=lambda b: b["cy"]):
        if rows:
            row = rows[-1]
            cy = np.median([b["cy"] for b in row])
            height = np.median([b["h"] for b in row])
            if abs(box["cy"] - cy) < 0.45 * min(height, box["h"]):
                row.append(box)
                continue
        rows.append([box])
    return [sorted(row, key=lambda b: b["x0"]) for row in rows]


class PageReader:
    """Detect once and recognize selected crops using RapidOCR 1.x components."""
    def __init__(self, engine, image):
        self.engine = engine
        # rapidocr-onnxruntime exposes text_det/text_rec. Older adapters used
        # the longer names; accept those without requiring an engine mutation.
        detector = getattr(engine, "text_det", None)
        recognizer = getattr(engine, "text_rec", None)
        if detector is None:
            detector = getattr(engine, "text_detector", None)
        if recognizer is None:
            recognizer = getattr(engine, "text_recognizer", None)
        if not callable(detector) or not callable(recognizer):
            raise RuntimeError("Engine RapidOCR tidak menyediakan komponen deteksi/pengenalan yang didukung")
        self.image, self.geometry = prepare_page(image)
        self.height, self.width = self.image.shape[:2]
        self.timings = {"detectMs": 0.0, "recognizeMs": 0.0}
        self.recognized_count = 0
        self.detailed_columns = {}
        start = perf_counter()
        scale = min(1.0, 1280 / max(self.height, self.width))
        detection_image = cv2.resize(self.image, None, fx=scale, fy=scale)
        quads, _ = detector(detection_image)
        self.timings["detectMs"] = (perf_counter() - start) * 1000
        self.boxes = []
        if quads is not None:
            # Use actual rounded resize dimensions, avoiding coordinate drift.
            factors = np.array([self.width / detection_image.shape[1],
                                self.height / detection_image.shape[0]])
            for idx, quad in enumerate(quads):
                quad = np.asarray(quad, dtype=np.float32) * factors
                x0, y0 = quad.min(axis=0)
                x1, y1 = quad.max(axis=0)
                if x1 - x0 < 3 or y1 - y0 < 3:
                    continue
                self.boxes.append({
                    "id": idx, "quad": quad.astype(np.float32),
                    "x0": float(x0), "y0": float(y0),
                    "x1": float(x1), "y1": float(y1),
                    "cx": float((x0 + x1) / 2), "cy": float((y0 + y1) / 2),
                    "h": float(y1 - y0),
                })

    def recognize(self, boxes, contrast=False):
        selected = boxes if contrast else [b for b in boxes if "text" not in b]
        if not selected:
            return
        crops = self.engine.get_crop_img_list(
            self.image, [b["quad"].copy() for b in selected]
        )
        if contrast:
            clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
            crops = [cv2.cvtColor(clahe.apply(cv2.cvtColor(c, cv2.COLOR_BGR2GRAY)),
                                  cv2.COLOR_GRAY2BGR) for c in crops]
        start = perf_counter()
        recognizer = getattr(self.engine, "text_rec", None)
        if recognizer is None:
            recognizer = self.engine.text_recognizer
        predictions, _ = recognizer(crops)
        self.timings["recognizeMs"] += (perf_counter() - start) * 1000
        self.recognized_count += len(crops)
        if len(predictions) != len(selected):
            raise RuntimeError("Jumlah keluaran recognizer tidak sesuai jumlah crop")
        for box, (text, confidence) in zip(selected, predictions):
            if contrast:
                box["alternative"] = str(text).strip()
                box["alternativeConfidence"] = float(confidence)
            else:
                box["text"] = str(text).strip()
                box["confidence"] = float(confidence)

    def read_column(self, right=False):
        # Non-overlapping columns prevent assigning a spouse's text to the other.
        boxes = [b for b in self.boxes if (b["cx"] >= self.width / 2) == right]
        rows = rows_from_boxes(boxes)
        output = []
        anchor_seen = False
        role_seen = False
        for start in range(0, len(rows), 4):
            group = rows[start:start + 4]
            self.recognize([b for row in group for b in row])
            for row in group:
                text = " ".join(b["text"] for b in row)
                output.append(row)
                if PARENT_SECTION.search(text):
                    return output
                anchor_seen = anchor_seen or bool(NAME_LABEL.search(text))
                role_seen = role_seen or bool(ROLE.search(text))
                # Do not fall through to a parent's name if item 1 is unreadable.
                if (anchor_seen or role_seen) and NEXT_ITEM.search(text):
                    return output
        return output

    def read_detailed_column(self, right=False):
        """Retry only the top of a Model N spouse column at full detail.

        This is a search region, not a source of assumed values: names still
        require their label and dates their marriage-specific evidence.
        """
        if right in self.detailed_columns:
            return self.detailed_columns[right]
        if not callable(self.engine):
            return []
        x0 = self.width // 2 if right else 0
        x1 = self.width if right else self.width // 2
        crop = self.image[:max(1, self.height // 3), x0:x1]
        start = perf_counter()
        predictions, _ = self.engine(crop)
        self.timings["detailMs"] = self.timings.get("detailMs", 0.0) + (perf_counter() - start) * 1000
        boxes = []
        for quad, text, confidence in predictions or []:
            quad = np.asarray(quad, dtype=np.float32) + np.array([x0, 0], dtype=np.float32)
            lo, hi = quad.min(axis=0), quad.max(axis=0)
            boxes.append({"quad": quad, "text": str(text).strip(), "confidence": float(confidence),
                          "x0": float(lo[0]), "x1": float(hi[0]), "y0": float(lo[1]), "y1": float(hi[1]),
                          "cx": float((lo[0] + hi[0]) / 2), "cy": float((lo[1] + hi[1]) / 2),
                          "h": float(hi[1] - lo[1])})
        rows = rows_from_boxes(boxes)
        self.detailed_columns[right] = rows
        return rows

    def observed_text(self):
        return [b["text"] for b in sorted(self.boxes, key=lambda b: (b["cy"], b["cx"]))
                if b.get("text")]


def name_from_rows(rows, expected_role, clean_name, valid_name):
    """Require an explicit item-1 label and retain the source boxes as evidence."""
    role = None
    # Empty OCR boxes must not shift label offsets or become the value anchor.
    rows = [[b for b in row if b.get("text", "").strip()] for row in rows]
    rows = [row for row in rows if row]
    for index, row in enumerate(rows):
        text = " ".join(b.get("text", "") for b in row)
        if PARENT_SECTION.search(text):
            return "", {"status": "review", "warnings": ["name_anchor_missing_before_parent_section"]}
        if re.match(r"^\s*2\s*[.)]", text):
            return "", {"status": "review", "warnings": ["name_anchor_missing_before_item_2"]}
        role_match = ROLE.search(text)
        if role_match:
            role = "istri" if role_match[1].lower() in ("istri", "isteri") else "suami"
        label = NAME_LABEL.search(text)
        if not label:
            if NEXT_ITEM.search(text):
                return "", {"status": "review", "warnings": ["name_anchor_missing_before_item_2"]}
            continue
        if role is not None and role != expected_role:
            return "", {"status": "review", "warnings": ["role_mismatch"]}
        # Identify the label's box even when the label spans multiple boxes.
        prefix = ""
        anchor_end = 0
        # Regex whitespace may include the join between detector boxes; that
        # separator must not move the anchor from the label to the value box.
        anchor_limit = label.start() + len(label.group().rstrip())
        for pos, box in enumerate(row):
            prefix += (" " if prefix else "") + box.get("text", "")
            if len(prefix) >= anchor_limit:
                anchor_end = pos
                break
        anchor = row[anchor_end]
        inline_value = text[label.end():len(prefix)].lstrip(" :.-=")
        # A standalone label is not part of the name's image evidence. Keeping
        # it in the crop makes supplementary OCR read the form label as a name.
        selected = [anchor] if inline_value else []
        pieces = [inline_value]
        previous = anchor
        distant_value = False
        for box in row[anchor_end + 1:]:
            if re.fullmatch(r"[\s.·:_=\-]+", box.get("text", "")):
                continue
            # Distant side notes must not be glued onto a person's name.
            if box["x0"] - previous["x1"] > max(3 * anchor["h"], 0.16 * (row[-1]["x1"] - row[0]["x0"])):
                # The first value can occupy a distant form column. Subsequent
                # distant text remains excluded. Keep the spatial uncertainty
                # visible rather than forcing a match or borrowing another row.
                if (previous is anchor and not any(piece.strip() for piece in pieces)
                        and valid_name(box.get("text", ""))
                        and abs(box["cy"] - anchor["cy"]) <= 0.75 * min(box["h"], anchor["h"])):
                    distant_value = True
                else:
                    break
            selected.append(box)
            pieces.append(box.get("text", ""))
            previous = box
        raw = " ".join(p for p in pieces if p).strip(" :.-=")
        aligned_previous = False
        if (not raw or HEADER_WORDS.search(raw) or NEXT_ITEM.search(raw) or re.search(r'\d', raw) or not valid_name(raw)) and index > 0:
            # A sloped form can put the value slightly above its left-hand
            # label, creating two OCR rows. Accept only the immediately prior
            # row, to the right of the label, within the same vertical band.
            # A previous full line (or item-2 value below) is not a name source.
            # A separate role heading can sit between the raised value and
            # item-1 label on a curved page. Never cross an unrelated row.
            prior_index = index - 1
            if (ROLE.search(" ".join(b["text"] for b in rows[prior_index])) and prior_index > 0
                    and not any(b["x0"] >= anchor["x1"] and valid_name(b["text"])
                                for b in rows[prior_index])):
                prior_index -= 1
            candidates = [b for b in rows[prior_index]
                          if b["x0"] >= anchor["x1"]
                          and abs(b["cy"] - anchor["cy"]) <= (1.75 if prior_index < index - 1 else 1.25) * min(b["h"], anchor["h"])]
            if candidates:
                prior_selected = [candidates[0]]
                for candidate in candidates[1:]:
                    if candidate["x0"] - prior_selected[-1]["x1"] > 3 * anchor["h"]:
                        break
                    prior_selected.append(candidate)
                prior_raw = " ".join(b.get("text", "") for b in prior_selected).strip(" :.-=")
                if valid_name(prior_raw) and not HEADER_WORDS.search(prior_raw) and not NEXT_ITEM.search(prior_raw) and not ROLE.search(prior_raw):
                    raw, selected = prior_raw, prior_selected
                    aligned_previous = True
        if not raw and index + 1 < len(rows):
            following = rows[index + 1]
            first = following[0]
            following_text = " ".join(b.get("text", "") for b in following)
            if (first["cy"] - anchor["cy"] <= 2.5 * anchor["h"]
                    and not NEXT_ITEM.search(following_text)
                    and not NAME_LABEL.search(following_text)
                    and first["x0"] >= row[0]["x0"] - anchor["h"]):
                selected = [first]
                previous = first
                for box in following[1:]:
                    if box["x0"] - previous["x1"] > 3 * anchor["h"]:
                        break
                    selected.append(box)
                    previous = box
                raw = " ".join(b.get("text", "") for b in selected)
        warnings = []
        if distant_value:
            warnings.append("distant_name_value_check_alignment")
        if aligned_previous:
            warnings.append("name_value_above_label_check_alignment")
        if role is None:
            warnings.append("role_anchor_missing")
        if HEADER_WORDS.search(raw) or NEXT_ITEM.search(raw) or re.search(r'\d', raw) or not valid_name(raw):
            return "", {"rawText": raw, "status": "review",
                        "warnings": warnings + ["invalid_name_region"]}
        value = clean_name(raw)
        confidence = min(b.get("confidence", 0.0) for b in selected)
        if confidence < 0.85:
            warnings.append("low_ocr_confidence")
        if any(len(word) >= 18 for word in value.split()):
            warnings.append("word_boundaries_uncertain")
        return value, {
            "rawText": raw, "confidence": round(confidence, 4),
            "status": "review" if warnings else "extracted",
            "warnings": warnings,
            "boxes": [b["quad"].tolist() for b in selected],
            "coordinateSpace": "normalized_page_pixels",
        }
    return "", {"status": "review", "warnings": ["name_anchor_missing"]}


def header_before_person(rows):
    header = []
    for row in rows:
        text = " ".join(b.get("text", "") for b in row)
        if NAME_LABEL.search(text) or ROLE.search(text) or NEXT_ITEM.search(text) or PARENT_SECTION.search(text):
            break
        header.append(text)
    # No semantic context means this is not a trustworthy wedding date region.
    text = " ".join(header)
    if not re.search(r"\b(?:pada\s+hari|akad\s+nikah|masehi)\b", text, re.I):
        return []
    return header


def extract_layout_document(images, engine, extract_number, extract_date,
                            clean_name, valid_name, suggest_name,
                            refine_header=None, refine_names=None, refine_number=None):
    started = perf_counter()
    data = {key: "" for key in ("noAkta", "tglAkad", "namaSuami", "namaIstri")}
    details = {}
    raw = []
    pages = []
    warnings = []
    spouse_image = None
    for page_index, image in enumerate(images[:2]):
        if image is None:
            warnings.append(f"page_{page_index + 1}_decode_failed")
            continue
        reader = PageReader(engine, image)
        if page_index == 0:
            # Cheap, broad localization with detection only; recognize batches
            # until the structured akta number is found, rather than all text.
            rows = rows_from_boxes(reader.boxes)
            for start in range(0, len(rows), 4):
                batch = rows[start:start + 4]
                reader.recognize([b for row in batch for b in row])
                for row in batch:
                    lines = [" ".join(b["text"] for b in row)]
                    value = extract_number(lines)
                    if value:
                        data["noAkta"] = value
                        details["noAkta"] = {
                            "rawText": lines[0], "status": "extracted", "page": 1,
                            "warnings": [],
                            "confidence": min(b["confidence"] for b in row),
                        }
                        if re.search(r"/\d{1,2}/(?:19|20)\d{2}$", value):
                            details["noAkta"]["status"] = "review"
                            details["noAkta"]["warnings"].append("verify_numeric_month_against_roman_numeral")
                        if details["noAkta"]["confidence"] < 0.85:
                            details["noAkta"]["status"] = "review"
                            details["noAkta"]["warnings"].append("low_ocr_confidence")
                        break
                if data["noAkta"]:
                    break
            if not data["noAkta"] and refine_number:
                try:
                    candidate = refine_number(reader.image, rows, extract_number)
                    if candidate:
                        data["noAkta"], details["noAkta"] = candidate
                except Exception as error:
                    warnings.append(f"Pembacaan ulang nomor gagal: {error}")
        else:
            spouse_image = reader.image
            left_rows = []
            for right, role, field in ((False, "suami", "namaSuami"),
                                        (True, "istri", "namaIstri")):
                rows = reader.read_column(right=right)
                if not right:
                    left_rows = rows
                value, detail = name_from_rows(rows, role, clean_name, valid_name)
                header = header_before_person(rows)
                date_value = extract_date(header) if header else ""
                # Whole-page detection can lose small header/name glyphs. A
                # bounded column retry retains detail without reading Excel or
                # falling through to a parent's name when item 1 is absent.
                if not value or (not right and not data["tglAkad"] and not date_value):
                    try:
                        detailed_rows = reader.read_detailed_column(right)
                        if detailed_rows:
                            retry_value, retry_detail = name_from_rows(detailed_rows, role, clean_name, valid_name)
                            if not value and retry_value:
                                retry_detail["previousReading"] = {"text": value, "details": detail}
                                retry_detail["source"] = "local-detailed-column"
                                retry_detail["status"] = "review"
                                retry_detail.setdefault("warnings", []).append("verify_detailed_column_against_scan")
                                value, detail = retry_value, retry_detail
                            # Date extraction must see the same high-detail
                            # header. Name candidates retain their source boxes.
                            rows = detailed_rows
                            header = header_before_person(rows)
                            date_value = extract_date(header) if header else ""
                    except Exception as error:
                        warnings.append(f"Pembacaan ulang kolom {role} gagal: {error}")
                if not right:
                    left_rows = rows
                # Selective recognition-only contrast retry; never overwrite a
                # disagreement merely because the alternative confidence rose.
                if not value or "low_ocr_confidence" in detail.get("warnings", []):
                    anchor_index = next((i for i, row in enumerate(rows)
                                         if NAME_LABEL.search(" ".join(b["text"] for b in row))), None)
                    if anchor_index is not None:
                        selected = [b for row in rows[anchor_index:anchor_index + 2] for b in row]
                        reader.recognize(selected, contrast=True)
                        alt_rows = [[dict(b, text=b.get("alternative", b["text"]),
                                         confidence=b.get("alternativeConfidence", b["confidence"]))
                                     for b in row] for row in rows]
                        alternative, _ = name_from_rows(alt_rows, role, clean_name, valid_name)
                        if alternative and alternative != value:
                            detail["alternativeText"] = alternative
                            detail.setdefault("warnings", []).append("preprocessing_disagreement")
                            detail["status"] = "review"
                detail["page"] = 2
                if value:
                    suggestion = suggest_name(value)
                    if suggestion != value:
                        detail["suggestedText"] = suggestion
                        detail["warnings"].append("name_correction_suggested")
                        detail["status"] = "review"
                data[field], details[field] = value, detail
                if date_value:
                    if data["tglAkad"] and data["tglAkad"] != date_value:
                        details["tglAkad"]["warnings"].append("conflicting_date_candidates")
                        details["tglAkad"]["alternativeText"] = date_value
                    elif not data["tglAkad"]:
                        data["tglAkad"] = date_value
                        details["tglAkad"] = {
                            "rawText": " ".join(header), "page": 2,
                            "status": "review", "warnings": ["verify_date_against_scan"],
                        }
            if refine_header and not data["tglAkad"]:
                try:
                    candidate = refine_header(reader.image, left_rows, engine, extract_date)
                    if candidate:
                        data["tglAkad"], details["tglAkad"] = candidate
                except Exception as error:
                    # A supplementary pass must not discard the primary reading.
                    warnings.append(f"Pembacaan ulang tanggal gagal: {error}")
        raw.extend(reader.observed_text())
        pages.append({"page": page_index + 1, **reader.geometry,
                      **{key: round(value, 2) for key, value in reader.timings.items()},
                      "detectedBoxes": len(reader.boxes),
                      "recognizedCrops": reader.recognized_count})
    for field, value in data.items():
        if not value:
            details.setdefault(field, {"status": "review", "warnings": ["field_not_found"]})
    response = {
        "success": True, "data": data, "fieldDetails": details,
        "rawText": "\n".join(raw), "lineCount": len(raw), "warnings": warnings,
        "requiresReview": any(d["status"] == "review" for d in details.values()),
        "timings": {"totalMs": round((perf_counter() - started) * 1000, 2), "pages": pages},
        "pipeline": "geometry-anchors-v2-regions",
    }
    if refine_names and spouse_image is not None:
        refine_names(spouse_image, response, clean_name, valid_name)
    response["timings"]["totalMs"] = round((perf_counter() - started) * 1000, 2)
    return response
