"""Synthetic layout regressions; no PDFs, OCR models, or network access required.

Includes date regressions for examination and Hijriyah/Gregorian ordering.
Run: ./.venv/Scripts/python.exe -m unittest test_ocr_layout -v
"""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import numpy as np

import ocr_layout as layout


def box(text, x=30, y=30, width=180, height=20, confidence=0.97):
    quad = np.array([[x, y], [x + width, y],
                     [x + width, y + height], [x, y + height]], dtype=np.float32)
    return {"text": text, "confidence": confidence, "quad": quad,
            "x0": x, "y0": y, "x1": x + width, "y1": y + height,
            "cx": x + width / 2, "cy": y + height / 2, "h": height}


def identity(value):
    return value


def valid_name(value):
    # Deliberately permissive: anchor/header safeguards must not rely on cleanup.
    return bool(value.strip())


class FakeEngine:
    """RapidOCR 1.2.x protocol with scripted page detections and crop results."""

    def __init__(self, pages, source_shape=(800, 1000), alternatives=None):
        self.pages = pages
        self.source_shape = source_shape
        self.alternatives = alternatives or {}
        self.detector_shapes = []
        self.crop_batches = []
        self.recognition_batches = []
        self._page = None
        self._pending = []
        self._seen = {}

    def text_detector(self, img):
        self._page = len(self.detector_shapes)
        self.detector_shapes.append(img.shape)
        page = self.pages[self._page]
        if not page:
            return None, 0.001
        factors = np.array([img.shape[1] / self.source_shape[1],
                            img.shape[0] / self.source_shape[0]])
        return np.array([b["quad"] * factors for b in page]), 0.001

    def get_crop_img_list(self, image, quads):
        self._pending = []
        for quad in quads:
            matches = [i for i, b in enumerate(self.pages[self._page])
                       if np.allclose(b["quad"], quad, atol=0.001)]
            if len(matches) != 1:
                raise AssertionError("Crop must refer to exactly one source quad")
            self._pending.append(matches[0])
        self.crop_batches.append((self._page, tuple(self._pending)))
        return [np.full((20, 80, 3), 180, dtype=np.uint8) for _ in quads]

    def text_recognizer(self, crops):
        if len(crops) != len(self._pending):
            raise AssertionError("Recognizer must receive all requested crops")
        self.recognition_batches.append((self._page, tuple(self._pending)))
        predictions = []
        for index in self._pending:
            item = self.pages[self._page][index]
            key = (self._page, index)
            seen = self._seen.get(key, 0)
            predictions.append(self.alternatives.get(key, (item["text"], item["confidence"]))
                               if seen else (item["text"], item["confidence"]))
            self._seen[key] = seen + 1
        return predictions, 0.002


def load_service_without_models():
    """Execute a private module, restoring all temporary sys.modules entries."""
    rapidocr = types.ModuleType("rapidocr_onnxruntime")
    setattr(rapidocr, "RapidOCR", lambda: None)
    spec = importlib.util.spec_from_file_location(
        "_ocr_layout_test_ai_service", Path(__file__).with_name("ai_service.py"))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    stubs = {"rapidocr_onnxruntime": rapidocr,
             "pymupdf": types.ModuleType("pymupdf"),
             "fitz": types.ModuleType("fitz")}
    with patch.dict(sys.modules, stubs), contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(module)
    return module


class NameLayoutTests(unittest.TestCase):
    def extract(self, rows, role="suami", validator=valid_name):
        return layout.name_from_rows(rows, role, identity, validator)

    def test_name_requires_explicit_label_even_with_role(self):
        value, detail = self.extract([[box("CALON SUAMI")],
                                      [box("BUDI SANTOSO", y=70)]])
        self.assertEqual(value, "")
        self.assertEqual(detail["status"], "review")
        self.assertIn("name_anchor_missing", detail["warnings"])

    def test_header_is_never_a_name_even_with_permissive_validator(self):
        for text in ("Pada hari ini", "bulan November tahun 2016 Masehi",
                     "telah dilangsungkan akad nikah", "tanggal Hijriyah"):
            with self.subTest(text=text):
                value, detail = self.extract([
                    [box("SUAMI")], [box("Nama lengkap: " + text, y=70)]])
                self.assertEqual(value, "")
                self.assertIn("invalid_name_region", detail["warnings"])

    def test_header_on_next_line_is_not_a_name(self):
        value, detail = self.extract([[box("SUAMI")],
                                      [box("Nama lengkap:", y=70)],
                                      [box("Pada hari ini", y=100)]])
        self.assertEqual(value, "")
        self.assertIn("invalid_name_region", detail["warnings"])

    def test_wrong_role_is_rejected_for_either_column(self):
        for expected, actual in (("suami", "ISTRI"), ("istri", "SUAMI")):
            with self.subTest(expected=expected):
                value, detail = self.extract([[box(actual)],
                                              [box("Nama lengkap: BUDI", y=70)]], expected)
                self.assertEqual(value, "")
                self.assertIn("role_mismatch", detail["warnings"])

    def test_isteri_alias_matches_wife(self):
        value, detail = self.extract([[box("CALON ISTERI")],
                                      [box("Nama lengkap: SITI AMINAH", y=70)]], "istri")
        self.assertEqual(value, "SITI AMINAH")
        self.assertEqual(detail["status"], "extracted")

    def test_missing_spouse_anchor_does_not_fall_through_to_parent(self):
        value, detail = self.extract([
            [box("SUAMI")],
            [box("2. Tempat dan tanggal lahir", y=70)],
            [box("Nama lengkap: NAMA AYAH", y=200)],
        ])
        self.assertEqual(value, "")
        self.assertIn("name_anchor_missing_before_item_2", detail["warnings"])

    def test_missing_role_preserves_candidate_but_requires_review(self):
        value, detail = self.extract([[box("Nama lengkap: BUDI")]])
        self.assertEqual(value, "BUDI")
        self.assertEqual(detail["status"], "review")
        self.assertIn("role_anchor_missing", detail["warnings"])

    def test_split_label_and_value_exclude_distant_noise_from_evidence(self):
        label_start = box("1. Nama", x=20, y=70, width=70)
        label_end = box("lengkap:", x=95, y=70, width=75)
        first = box("BUDI", x=180, y=70, width=60)
        second = box("SANTOSO", x=250, y=70, width=90)
        noise = box("CATATAN", x=800, y=70, width=100)
        value, detail = self.extract([[box("SUAMI")],
                                      [label_start, label_end, first, second, noise]])
        self.assertEqual(value, "BUDI SANTOSO")
        self.assertEqual(detail["rawText"], value)
        self.assertEqual(detail["boxes"], [b["quad"].tolist()
                                          for b in (label_end, first, second)])
        self.assertNotIn(noise["quad"].tolist(), detail["boxes"])
        self.assertEqual(detail["coordinateSpace"], "normalized_page_pixels")

    def test_empty_detection_before_name_label_cannot_shift_anchor_offsets(self):
        label = box("Nama lengkap", x=80, y=30, width=120)
        value = box("SITI AMINAH", x=300, y=40, width=150)
        extracted, detail = self.extract([
            [box("", x=60, y=30, width=8), label], [value],
            [box("2. Tempat lahir", y=75)]], role="istri")
        self.assertEqual(extracted, "SITI AMINAH")
        self.assertEqual(detail["boxes"], [value["quad"].tolist()])
        self.assertIn("role_anchor_missing", detail["warnings"])

    def test_next_line_value_excludes_distant_noise_and_label_box(self):
        label = box("Nama lengkap:", y=70)
        first = box("BUDI", y=100, width=60)
        last = box("SANTOSO", x=100, y=100, width=100)
        noise = box("CATATAN", x=400, y=100)
        value, detail = self.extract([[box("SUAMI")], [label], [first, last, noise]])
        self.assertEqual(value, "BUDI SANTOSO")
        self.assertEqual(detail["boxes"], [b["quad"].tolist() for b in (first, last)])

    def test_absolute_y_shift_does_not_change_name_or_status(self):
        for offset in (0, 250, 1100):
            with self.subTest(offset=offset):
                value, detail = self.extract([
                    [box("SUAMI", y=30 + offset)],
                    [box("Nama lengkap:", y=70 + offset)],
                    [box("BUDI SANTOSO", y=100 + offset)]])
                self.assertEqual(value, "BUDI SANTOSO")
                self.assertEqual(detail["status"], "extracted")
                self.assertEqual(detail["boxes"][0][0][1], 100 + offset)

    def test_next_item_or_distant_next_line_cannot_supply_name(self):
        for text, y in (("2. Tempat dan tanggal lahir", 100),
                        ("Nama lengkap: SITI", 100), ("BUDI", 250)):
            with self.subTest(text=text, y=y):
                value, detail = self.extract([[box("SUAMI")],
                                              [box("Nama lengkap:", y=70)],
                                              [box(text, y=y)]])
                self.assertEqual(value, "")
                self.assertEqual(detail["status"], "review")

    def test_validator_rejection_cannot_be_overridden_by_cleanup(self):
        value, detail = self.extract([[box("SUAMI")],
                                      [box("Nama lengkap: REJECT", y=70)]],
                                     validator=lambda _: False)
        self.assertEqual(value, "")
        self.assertIn("invalid_name_region", detail["warnings"])

    def test_low_confidence_and_joined_words_require_review(self):
        for name, confidence, warning in (("BUDI", 0.60, "low_ocr_confidence"),
                                          ("ABCDEFGHIJKLMNOPQRST", 0.97,
                                           "word_boundaries_uncertain")):
            with self.subTest(warning=warning):
                value, detail = self.extract([[box("SUAMI")],
                                              [box("Nama lengkap: " + name, y=70,
                                                   confidence=confidence)]])
                self.assertEqual(value, name)
                self.assertEqual(detail["status"], "review")
                self.assertIn(warning, detail["warnings"])


class ReaderTests(unittest.TestCase):
    def setUp(self):
        # These tests isolate geometry/extraction from scanner preprocessing.
        self.preparation = patch.object(layout, "prepare_page", side_effect=lambda image: (
            image, {"paperBounds": [0, 0, image.shape[1], image.shape[0]],
                    "deskewDegrees": 0.0}))
        self.preparation.start()
        self.addCleanup(self.preparation.stop)
        self.image = np.full((800, 1000, 3), 255, dtype=np.uint8)

    def test_recognition_batches_uncached_boxes_and_detects_only_once(self):
        engine = FakeEngine([[box("A"), box("B", y=70), box("C", y=110)]])
        reader = layout.PageReader(engine, self.image)
        reader.recognize(reader.boxes[:2])
        reader.recognize(reader.boxes)
        reader.recognize(reader.boxes)
        reader.recognize([])
        self.assertEqual(engine.recognition_batches, [(0, (0, 1)), (0, (2,))])
        self.assertEqual(engine.crop_batches, engine.recognition_batches)
        self.assertEqual(len(engine.detector_shapes), 1)
        self.assertEqual(reader.recognized_count, 3)
        self.assertEqual(reader.observed_text(), ["A", "B", "C"])

    def test_contrast_retry_retains_original_prediction_and_cache(self):
        engine = FakeEngine([[box("BUDI", confidence=0.60)]],
                            alternatives={(0, 0): ("BUDI SANTOSO", 0.99)})
        reader = layout.PageReader(engine, self.image)
        reader.recognize(reader.boxes)
        reader.recognize(reader.boxes, contrast=True)
        reader.recognize(reader.boxes)
        self.assertEqual(reader.boxes[0]["text"], "BUDI")
        self.assertEqual(reader.boxes[0]["confidence"], 0.60)
        self.assertEqual(reader.boxes[0]["alternative"], "BUDI SANTOSO")
        self.assertEqual(reader.boxes[0]["alternativeConfidence"], 0.99)
        self.assertEqual(reader.recognized_count, 2)
        self.assertEqual(len(engine.detector_shapes), 1)
        self.assertEqual(len(engine.recognition_batches), 2)

    def test_recognizer_result_count_mismatch_raises(self):
        engine = FakeEngine([[box("BUDI")]])
        reader = layout.PageReader(engine, self.image)
        with patch.object(engine, "text_recognizer", return_value=([], 0.0)):
            with self.assertRaisesRegex(RuntimeError, "recognizer"):
                reader.recognize(reader.boxes)
        self.assertNotIn("text", reader.boxes[0])

    def test_rounded_detection_dimensions_restore_original_coordinates(self):
        image = np.full((1601, 1001, 3), 255, dtype=np.uint8)
        original = box("BUDI", x=501, y=1231, width=200)
        engine = FakeEngine([[original]], source_shape=image.shape[:2])
        reader = layout.PageReader(engine, image)
        self.assertEqual(engine.detector_shapes[0][:2], (1280, 800))
        np.testing.assert_allclose(reader.boxes[0]["quad"], original["quad"], atol=0.001)
        reader.recognize(reader.boxes)
        self.assertEqual(reader.observed_text(), ["BUDI"])

    def test_columns_are_disjoint_including_exact_midpoint(self):
        engine = FakeEngine([[box("LEFT", x=100, width=80),
                              box("BOUNDARY", x=480, width=40),
                              box("RIGHT", x=650, width=80)]])
        reader = layout.PageReader(engine, self.image)
        left = reader.read_column(False)
        right = reader.read_column(True)
        self.assertEqual([b["text"] for row in left for b in row], ["LEFT"])
        self.assertEqual([b["text"] for row in right for b in row], ["BOUNDARY", "RIGHT"])
        self.assertEqual(reader.recognized_count, 3)

    def test_column_stops_after_next_item_without_recognizing_whole_page(self):
        texts = ["SUAMI", "Nama lengkap: BUDI", "2. Tempat lahir", "Alamat",
                 "Pekerjaan", "NIK", "Footer", "Noise", "More noise"]
        engine = FakeEngine([[box(text, y=30 + i * 40) for i, text in enumerate(texts)]])
        reader = layout.PageReader(engine, self.image)
        rows = reader.read_column()
        self.assertEqual([row[0]["text"] for row in rows], texts[:3])
        # Four-row batches may read ahead, but later batches must stay untouched.
        self.assertEqual(engine.recognition_batches, [(0, (0, 1, 2, 3))])
        reader.read_column()
        self.assertEqual(reader.recognized_count, 4)

    def extract_document(self, pages, **kwargs):
        engine = FakeEngine(pages, alternatives=kwargs.pop("alternatives", None))
        response = layout.extract_layout_document(
            [self.image for _ in pages], engine,
            kwargs.pop("extract_number", lambda _: ""),
            kwargs.pop("extract_date", lambda _: ""),
            identity, valid_name, identity)
        if kwargs:
            raise AssertionError("Unknown fixture options")
        return response, engine

    def test_absent_fields_are_empty_and_require_review(self):
        response, engine = self.extract_document([[], []])
        self.assertTrue(response["success"])
        self.assertTrue(response["requiresReview"])
        self.assertEqual(set(response["data"]),
                         {"noAkta", "tglAkad", "namaSuami", "namaIstri"})
        for field, value in response["data"].items():
            with self.subTest(field=field):
                self.assertEqual(value, "")
                self.assertEqual(response["fieldDetails"][field]["status"], "review")
                self.assertTrue(response["fieldDetails"][field]["warnings"])
        self.assertEqual(engine.recognition_batches, [])
        self.assertEqual(len(engine.detector_shapes), 2)

    def test_two_page_extraction_keeps_spouses_and_date_context_separate(self):
        header = "Pada hari ini 12 November 2016 Masehi"
        seen_headers = []

        def extract_date(lines):
            seen_headers.append(lines)
            return "12-11-2016" if lines == [header] else ""

        response, engine = self.extract_document([
            [box("Nomor 123/IV/2016")],
            [box(header, y=20, width=420), box("SUAMI", y=60),
             box("Nama lengkap: BUDI", y=100, width=300),
             box("2. Tempat lahir 01-01-1990", y=140, width=350),
             box("ISTRI", x=550, y=60),
             box("Nama lengkap: SITI", x=550, y=100, width=300),
             box("2. Tempat lahir 02-02-1992", x=550, y=140, width=350)]],
            extract_number=lambda lines: "123/IV/2016" if "123/IV/2016" in lines[0] else "",
            extract_date=extract_date)
        self.assertEqual(response["data"], {"noAkta": "123/IV/2016", "tglAkad": "12-11-2016",
                                            "namaSuami": "BUDI", "namaIstri": "SITI"})
        self.assertEqual(seen_headers, [[header]])
        for field in ("namaSuami", "namaIstri"):
            self.assertEqual(response["fieldDetails"][field]["status"], "extracted")
            self.assertEqual(response["fieldDetails"][field]["page"], 2)
        self.assertEqual(response["fieldDetails"]["tglAkad"]["status"], "review")
        self.assertIn("verify_date_against_scan",
                      response["fieldDetails"]["tglAkad"]["warnings"])
        self.assertTrue(response["requiresReview"])
        self.assertEqual(len(engine.detector_shapes), 2)
        self.assertEqual(response["timings"]["pages"][1]["recognizedCrops"], 7)

    def test_numeric_month_is_preserved_but_requires_roman_numeral_review(self):
        response, _ = self.extract_document(
            [[box("Nomor Akta 123/004/1/2020")]],
            extract_number=lambda _: "123/004/1/2020")
        self.assertEqual(response["data"]["noAkta"], "123/004/1/2020")
        detail = response["fieldDetails"]["noAkta"]
        self.assertEqual(detail["status"], "review")
        self.assertIn("verify_numeric_month_against_roman_numeral", detail["warnings"])

    def test_failed_optional_header_retry_keeps_primary_reading(self):
        engine = FakeEngine([[], [box("Pada hari ini", width=420), box("SUAMI", y=70),
                                  box("Nama lengkap: BUDI", y=110, width=300)]])
        with patch("ocr_regions.header_date_candidate", side_effect=RuntimeError("detector unavailable")) as retry:
            response = layout.extract_layout_document(
                [self.image, self.image], engine, lambda _: "", lambda _: "",
                identity, valid_name, identity, refine_header=retry)
        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["namaSuami"], "BUDI")
        self.assertEqual(response["data"]["tglAkad"], "")
        self.assertTrue(any("detector unavailable" in warning for warning in response["warnings"]))

    def test_contrast_disagreement_is_reported_without_replacing_name(self):
        response, _ = self.extract_document([
            [], [box("SUAMI"), box("Nama lengkap: BUDI", y=70, confidence=0.60)]],
            alternatives={(1, 1): ("Nama lengkap: BUDI SANTOSO", 0.99)})
        self.assertEqual(response["data"]["namaSuami"], "BUDI")
        detail = response["fieldDetails"]["namaSuami"]
        self.assertEqual(detail["alternativeText"], "BUDI SANTOSO")
        self.assertEqual(detail["status"], "review")
        self.assertIn("preprocessing_disagreement", detail["warnings"])


class HeaderAndDateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = load_service_without_models()

    def test_isolated_service_import_restores_modules(self):
        names = ("rapidocr_onnxruntime", "pymupdf", "fitz", "ai_service",
                 "_ocr_layout_test_ai_service")
        missing = object()
        before = {name: sys.modules.get(name, missing) for name in names}
        service = load_service_without_models()
        self.assertIsNone(service.ocr_engine)
        for name in names:
            self.assertIs(sys.modules.get(name, missing), before[name], name)

    def test_date_requires_header_semantics_before_person_section(self):
        for text in ("12 November 2016", "Tanggal lahir 12 November 2016",
                     "Pemeriksaan 12-11-2016"):
            with self.subTest(text=text):
                self.assertEqual(layout.header_before_person([[box(text)]]), [])
        for text in ("Pada hari ini 12 November 2016", "Akad nikah 12-11-2016",
                     "12 November 2016 Masehi"):
            with self.subTest(text=text):
                self.assertEqual(layout.header_before_person([[box(text)]]), [text])

    def test_header_stops_at_role_or_name_and_excludes_birth_date(self):
        for anchor in ("SUAMI", "ISTRI", "Nama lengkap: BUDI"):
            with self.subTest(anchor=anchor):
                rows = [[box("Pada hari ini 12 November 2016")], [box(anchor, y=70)],
                        [box("Tempat lahir 03-04-1990", y=110)]]
                header = layout.header_before_person(rows)
                self.assertEqual(header, ["Pada hari ini 12 November 2016"])
                self.assertEqual(self.service.extract_tanggal_akad(header), "12-11-2016")

    def test_real_date_helper_validates_calendar_and_leap_year(self):
        for source, expected in (("Akad nikah 29 Februari 2020", "29-02-2020"),
                                 ("Akad nikah 29 Februari 2019", ""),
                                 ("Akad nikah 31 April 2020", ""),
                                 ("Akad nikah 12 / 11 / 2016", "12-11-2016"),
                                 ("Akad nikah 31-13-2016", ""),
                                 ("Akad nikah 00-11-2016", "")):
            with self.subTest(source=source):
                self.assertEqual(self.service.extract_tanggal_akad([source]), expected)

    def test_hijriyah_cannot_supply_gregorian_components(self):
        self.assertEqual(self.service.extract_tanggal_akad([
            "Pada hari ini 12 November 2016 Masehi",
            "bertepatan 22 Safar 1438 Hijriyah"]), "12-11-2016")
        self.assertEqual(self.service.extract_tanggal_akad([
            "Pada hari ini bertepatan 22 November 1438 Hijriyah"]), "")
        self.assertEqual(self.service.extract_tanggal_akad([
            "Hijriyah 22 November 2016"]), "")

    def test_named_month_examination_date_is_not_wedding_date(self):
        self.assertEqual(self.service.extract_tanggal_akad([
            "Tanggal pemeriksaan 12 November 2016"]), "")

    def test_gregorian_date_after_hijriyah_header_is_not_discarded(self):
        self.assertEqual(self.service.extract_tanggal_akad([
            "Pada hari ini tanggal 22 Safar 1438 Hijriyah",
            "bertepatan tanggal 12 November 2016 Masehi"]), "12-11-2016")


class PageNormalizationTests(unittest.TestCase):
    def test_dark_scanner_margin_is_removed_without_cutting_paper(self):
        import cv2
        image = np.zeros((900, 1200, 3), dtype=np.uint8)
        image[130:850, 90:1110] = 245
        cv2.putText(image, "Nama lengkap", (150, 250),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 1)
        page, geometry = layout.prepare_page(image)
        x0, y0, x1, y1 = geometry["paperBounds"]
        self.assertLessEqual(x0, 90)
        self.assertLessEqual(y0, 130)
        self.assertGreaterEqual(x1, 1110)
        self.assertGreaterEqual(y1, 850)
        self.assertLess(page.shape[0], image.shape[0])

    def test_printed_lines_support_small_angle_deskew(self):
        import cv2
        image = np.full((800, 1000, 3), 255, dtype=np.uint8)
        for y in range(120, 650, 80):
            cv2.line(image, (150, y), (850, y), (0, 0, 0), 2)
        matrix = cv2.getRotationMatrix2D((500, 400), 3, 1)
        rotated = cv2.warpAffine(image, matrix, (1000, 800), borderValue=(255, 255, 255))
        _, geometry = layout.prepare_page(rotated)
        self.assertAlmostEqual(abs(geometry["deskewDegrees"]), 3, delta=0.5)


class RowGroupingTests(unittest.TestCase):
    def test_rows_sort_by_y_then_x_without_chaining_baseline_drift(self):
        first = box("FIRST", x=30, y=20)
        same_row = box("SECOND", x=200, y=24)
        drift = box("NEXT", x=30, y=31)
        rows = layout.rows_from_boxes([drift, same_row, first])
        self.assertEqual([[b["text"] for b in row] for row in rows],
                         [["FIRST", "SECOND"], ["NEXT"]])
        self.assertEqual(layout.rows_from_boxes([]), [])


if __name__ == "__main__":
    unittest.main()
