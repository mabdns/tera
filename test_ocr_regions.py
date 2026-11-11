"""Synthetic region OCR regressions; no models, Node, PDFs, or name dictionaries.

Run: python -m unittest test_ocr_regions -v
"""
import base64
from copy import deepcopy
import json
import re
import subprocess
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

import ocr_regions as regions
from test_ocr_layout import box, load_service_without_models


def token(text, cx, cy, height=20, width=30, confidence=0.97):
    return box(text, cx - width / 2, cy - height / 2, width, height, confidence)


def clean_name(value):
    return " ".join(value.split()).upper()


def valid_name(value):
    return bool(isinstance(value, str) and
                re.fullmatch(r"[A-Za-z' .-]+", value.strip()) and
                sum(character.isalpha() for character in value) >= 3)


class HeaderDateRegionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = load_service_without_models()

    def setUp(self):
        self.image = np.full((500, 1200, 3), 255, dtype=np.uint8)
        self.rows = [[box("Pada hari ini akad nikah", 40, 40, 440)],
                     [box("Masehi", 40, 120, 440)]]
        # The bounded header is [28:146, 28:492], before its 2x resize.
        self.origin = np.array([28, 28], dtype=np.float32)
        self.date_boxes = [token("12", 100, 90, confidence=0.93),
                           token("November", 220, 90, width=80),
                           token("2016", 360, 90, width=50)]

    def detect(self, boxes=None, rows=None, extract_date=None):
        boxes = self.date_boxes if boxes is None else boxes
        predictions = [((item["quad"] - self.origin) * 2,
                        item["text"], item["confidence"]) for item in boxes]
        engine = Mock(return_value=(predictions, 0.001))
        result = regions.header_date_candidate(
            self.image, self.rows if rows is None else rows, engine,
            extract_date or self.service.extract_tanggal_akad)
        return result, engine

    def test_same_baseline_date_reports_global_not_doubled_crop_coordinates(self):
        result, engine = self.detect()
        self.assertIsNotNone(result)
        value, evidence = result
        self.assertEqual(value, "12-11-2016")
        engine.assert_called_once()
        expected = cv2.resize(self.image[28:146, 28:492], None, fx=2, fy=2,
                              interpolation=cv2.INTER_CUBIC)
        np.testing.assert_array_equal(engine.call_args.args[0], expected)
        self.assertEqual(evidence["rawText"], "12 November 2016")
        self.assertEqual(evidence["headerContext"], "Pada hari ini akad nikah Masehi")
        self.assertEqual(evidence["status"], "review")
        self.assertEqual(evidence["source"], "local-header-region")
        self.assertEqual(evidence["coordinateSpace"], "normalized_page_pixels")
        self.assertEqual(evidence["page"], 2)
        self.assertAlmostEqual(evidence["confidence"], 0.93)
        self.assertIn("verify_date_against_scan", evidence["warnings"])
        np.testing.assert_allclose(evidence["boxes"],
                                   [item["quad"] for item in self.date_boxes])

    def test_semantic_header_anchor_is_required_before_calling_engine(self):
        for text in ("12 November 2016", "Tanggal lahir 12 November 2016",
                     "Tanggal pemeriksaan 12 November 2016", ""):
            with self.subTest(text=text):
                result, engine = self.detect(rows=[[box(text)]])
                self.assertIsNone(result)
                engine.assert_not_called()
        result, engine = self.detect(rows=[])
        self.assertIsNone(result)
        engine.assert_not_called()

    def test_header_crop_stops_at_birth_section_even_when_name_label_is_missing(self):
        rows = [[box("Pada hari ini akad nikah", 40, 40, 440)],
                [box("2. Tempat dan tanggal lahir", 40, 80, 440)],
                [box("12 November 1984", 40, 110, 440)]]
        result, engine = self.detect([], rows=rows)
        self.assertIsNone(result)
        expected = cv2.resize(self.image[28:66, 28:492], None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        np.testing.assert_array_equal(engine.call_args.args[0], expected)

    def test_each_supported_header_anchor_allows_a_date(self):
        for anchor in ("Pada hari ini", "Akad nikah", "Masehi"):
            with self.subTest(anchor=anchor):
                rows = deepcopy(self.rows)
                rows[0][0]["text"] = anchor
                rows[1][0]["text"] = "tanggal"
                result, _ = self.detect(rows=rows)
                self.assertEqual(result[0], "12-11-2016")

    def test_header_crop_stops_before_role_or_name_and_excludes_birth_date(self):
        for label in ("SUAMI", "ISTRI", "Nama lengkap: BUDI"):
            with self.subTest(label=label):
                rows = self.rows + [[box(label, 20, 180, 500)],
                                    [box("Lahir 03 April 1990", 20, 260, 500)]]
                result, engine = self.detect(rows=rows)
                self.assertEqual(engine.call_args.args[0].shape, (236, 928, 3))
                self.assertNotIn(label, result[1]["headerContext"])
                self.assertNotIn("1990", result[1]["headerContext"])
                # A semantic anchor only after the person section cannot qualify.
                result, engine = self.detect(rows=[[box(label)]] + self.rows)
                self.assertIsNone(result)
                engine.assert_not_called()

    def test_header_crop_never_crosses_page_midpoint(self):
        rows = deepcopy(self.rows)
        for row in rows:
            row[0]["x1"] = 1100
        result, engine = self.detect(rows=rows)
        self.assertEqual(result[0], "12-11-2016")
        self.assertEqual(engine.call_args.args[0].shape[1], (600 - 28) * 2)

    def test_day_and_year_must_be_on_correct_sides_of_month(self):
        for day_x, year_x in ((250, 360), (220, 360), (100, 200), (100, 220)):
            with self.subTest(day_x=day_x, year_x=year_x):
                items = [token("12", day_x, 90), token("November", 220, 90),
                         token("2016", year_x, 90)]
                extract = Mock(return_value="12-11-2016")
                result, _ = self.detect(items, extract_date=extract)
                self.assertIsNone(result)
                extract.assert_not_called()

    def test_projected_baseline_accepts_both_slope_limits(self):
        for slope in (-0.10, 0.10):
            with self.subTest(slope=slope):
                items = [token("12", 100, 90 + slope * (100 - 220)),
                         token("November", 220, 90),
                         token("2016", 360, 90 + slope * (360 - 220))]
                result, _ = self.detect(items)
                self.assertEqual(result[0], "12-11-2016")

    def test_steeper_baselines_are_rejected_even_when_all_tokens_align(self):
        for slope in (-0.11, 0.11):
            with self.subTest(slope=slope):
                items = [token("12", 100, 90 + slope * (100 - 220)),
                         token("November", 220, 90),
                         token("2016", 360, 90 + slope * (360 - 220))]
                result, _ = self.detect(items)
                self.assertIsNone(result)

    def test_day_residual_uses_smallest_token_height_and_inclusive_limit(self):
        for short_index in range(3):
            for direction in (-1, 1):
                for residual, accepted in ((6.5, True), (7.0, False)):
                    with self.subTest(short_index=short_index, direction=direction,
                                      residual=residual):
                        items = [token("12", 100, 90 + direction * residual),
                                 token("November", 220, 90), token("2016", 360, 90)]
                        item = items[short_index]
                        items[short_index] = token(item["text"], item["cx"], item["cy"],
                                                   height=10)
                        result, _ = self.detect(items)
                        self.assertEqual(result is not None, accepted)

    def test_hijri_day_on_another_row_cannot_supply_missing_gregorian_day(self):
        items = [token("22", 100, 55), token("Safar", 220, 55),
                 token("1438", 360, 55), token("November", 220, 100),
                 token("2016", 360, 100)]
        result, _ = self.detect(items)
        self.assertIsNone(result)
        items.append(token("12", 100, 100))
        result, _ = self.detect(items)
        self.assertEqual(result[0], "12-11-2016")

    def test_curved_gregorian_day_requires_its_printed_date_slot_labels(self):
        items = [token("12", 100, 108), token("November", 220, 90), token("2016", 360, 90),
                 token("tanggal", 50, 108, width=40), token("bulan", 160, 108, width=40)]
        result, _ = self.detect(items)
        self.assertEqual(result[0], "12-11-2016")
        self.assertIn("curved_date_slot_check_labels", result[1]["warnings"])
        self.assertEqual(len(result[1]["boxes"]), 5)
        for missing in (3, 4):
            self.assertIsNone(self.detect([b for i, b in enumerate(items) if i != missing])[0])

    def test_stronger_curvature_still_requires_local_slot_and_rejects_hijri_day(self):
        items = [token('12', 100, 130), token('November', 220, 90), token('2016', 360, 90),
                 token('tanggal', 50, 130, width=40), token('bulan', 160, 115, width=40)]
        self.assertEqual(self.detect(items)[0][0], '12-11-2016')
        self.assertIsNone(self.detect(items[:3])[0])
        self.assertIsNone(self.detect(items + [token('Safar', 220, 130), token('1438', 360, 130)])[0])

    def test_curved_date_cannot_take_day_outside_slot_or_labels_on_another_line(self):
        for day_x, label_y in ((40, 108), (180, 108), (100, 145)):
            with self.subTest(day_x=day_x, label_y=label_y):
                items = [token("22", day_x, 108), token("November", 220, 90), token("2016", 360, 90),
                         token("tanggal", 50, label_y, width=40), token("bulan", 160, label_y, width=40)]
                self.assertIsNone(self.detect(items)[0])

    def test_curved_slot_cannot_borrow_explicit_hijri_day_when_gregorian_day_is_missing(self):
        items = [token("22", 100, 108), token("November", 220, 90), token("2016", 360, 90),
                 token("tanggal", 50, 108, width=40), token("bulan", 160, 108, width=40),
                 token("Safar", 220, 108), token("1438", 360, 108)]
        self.assertIsNone(self.detect(items)[0])

    def test_multiple_distinct_valid_dates_are_ambiguous(self):
        for extra in (token("13", 140, 90), token("2017", 420, 90)):
            with self.subTest(extra=extra["text"]):
                result, _ = self.detect(self.date_boxes + [extra])
                self.assertIsNone(result)

    def test_repeated_evidence_for_the_same_date_is_not_ambiguous(self):
        result, _ = self.detect(self.date_boxes + [token("12", 140, 90)])
        self.assertEqual(result[0], "12-11-2016")

    def test_real_calendar_helper_rejects_impossible_dates(self):
        self.assertIsNone(self.service.ocr_engine)
        for day, month, year, expected in (
                ("29", "Februari", "2020", "29-02-2020"),
                ("29", "Februari", "2019", None),
                ("31", "April", "2020", None),
                ("00", "November", "2016", None),
                ("32", "November", "2016", None)):
            with self.subTest(day=day, month=month, year=year):
                result, _ = self.detect([token(day, 100, 90), token(month, 220, 90),
                                         token(year, 360, 90)])
                self.assertEqual(result[0] if result else None, expected)

    def test_empty_region_predictions_have_no_candidate(self):
        for predictions in ([], None):
            with self.subTest(predictions=predictions):
                engine = Mock(return_value=(predictions, 0.001))
                self.assertIsNone(regions.header_date_candidate(
                    self.image, self.rows, engine, self.service.extract_tanggal_akad))


class SpouseNameRegionTests(unittest.TestCase):
    def test_strong_primary_letters_are_retained_when_other_engine_disagrees(self):
        self.response['fieldDetails']['namaSuami']['confidence'] = 0.95
        self.refine([self.reading(i, 'BUDI BARU') for i in range(3)])
        self.assertEqual(self.response['data']['namaSuami'], 'BUDI LAMA')
        detail = self.response['fieldDetails']['namaSuami']
        self.assertEqual(detail['alternativeText'], 'BUDI BARU')
        self.assertEqual(len(detail['regionReadings']), 3)
        self.assertEqual(detail['status'], 'review')

    def test_votes_agree_on_letters_despite_title_spacing_and_dots(self):
        self.refine([self.reading(0, 'BUDI BARU A. Md'),
                     self.reading(1, 'BUDI BARU A MD'),
                     self.reading(2, 'BUDI BARU A ND')])
        self.assertEqual(self.response['data']['namaSuami'], 'BUDI BARU A. MD')
        self.assertEqual(len(self.response['fieldDetails']['namaSuami']['regionReadings']), 3)

    def setUp(self):
        self.image = np.full((180, 500, 3), 255, dtype=np.uint8)
        cv2.putText(self.image, "BUDI", (32, 55), cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, (0, 0, 0), 2)
        cv2.putText(self.image, "SITI", (252, 55), cv2.FONT_HERSHEY_SIMPLEX,
                    0.7, (0, 0, 0), 2)
        self.response = {
            "data": {"namaSuami": "BUDI LAMA", "namaIstri": "SITI LAMA"},
            "fieldDetails": {}, "warnings": [], "requiresReview": False,
        }
        for field, x in (("namaSuami", 30), ("namaIstri", 250)):
            self.response["fieldDetails"][field] = {
                "rawText": "baseline raw " + field, "status": "review", "page": 2,
                "source": "rapidocr-layout", "confidence": 0.88,
                "boxes": [box("", x, 30, 150, 30)["quad"].tolist()],
                "coordinateSpace": "normalized_page_pixels",
                "warnings": ["baseline_warning"], "baselineEvidence": {"text": "BUDT"},
            }

    def reading(self, index, text="BUDI BARU", confidence=98, field="namaSuami"):
        return {"id": f"{field}_{index}", "text": text, "confidence": confidence}

    def refine(self, results=None, error=None):
        with patch.object(regions, "recognize_regions", return_value=results or [],
                          side_effect=error) as recognize:
            regions.refine_spouse_names(self.image, self.response, clean_name, valid_name)
        return recognize

    def test_builds_three_local_png_sizes_for_each_review_field(self):
        recognize = self.refine()
        recognize.assert_called_once()
        requested = recognize.call_args.args[0]
        self.assertEqual([item["id"] for item in requested],
                         [f"{field}_{i}" for field in ("namaSuami", "namaIstri")
                          for i in range(3)])
        for offset in (0, 3):
            sizes = []
            for item in requested[offset:offset + 3]:
                self.assertEqual(item["kind"], "name")
                prefix, payload = item["image"].split(",", 1)
                self.assertEqual(prefix, "data:image/png;base64")
                encoded = np.frombuffer(base64.b64decode(payload, validate=True), np.uint8)
                decoded = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
                self.assertIsNotNone(decoded)
                self.assertLess(decoded.min(), 128)
                sizes.append(decoded.shape)
            base_height, base_width = sizes[1]
            self.assertEqual(sizes[0], (round(base_height * 0.75), round(base_width * 0.75)))
            self.assertEqual(sizes[2], (round(base_height * 1.5), round(base_width * 1.5)))

    def test_two_exact_clean_votes_replace_original_and_preserve_all_evidence(self):
        previous = deepcopy(self.response["fieldDetails"]["namaSuami"])
        wife = deepcopy(self.response["fieldDetails"]["namaIstri"])
        self.refine([self.reading(0, "  Budi   Baru  ", 96),
                     self.reading(1, "BUDI BARU", 84), self.reading(2, "BUDI BARI", 99)])
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI BARU")
        detail = self.response["fieldDetails"]["namaSuami"]
        self.assertEqual(detail["rawText"], "  Budi   Baru  ")
        self.assertEqual(detail["status"], "review")
        self.assertEqual(detail["source"], "local-tesseract-region")
        self.assertEqual(detail["page"], 2)
        self.assertAlmostEqual(detail["confidence"], 0.84)
        self.assertEqual(detail["boxes"], previous["boxes"])
        self.assertEqual(detail["coordinateSpace"], previous["coordinateSpace"])
        self.assertEqual(len(detail["regionReadings"]), 3)
        self.assertEqual(detail["regionReadings"][0]["rawText"], "  Budi   Baru  ")
        for warning in ("baseline_warning", "verify_name_against_scan",
                        "form_dots_removed_check_punctuation", "ocr_engine_disagreement"):
            self.assertIn(warning, detail["warnings"])
        self.assertTrue(self.response["requiresReview"])
        self.assertEqual(detail["previousReading"]["text"], "BUDI LAMA")
        retained = detail["previousReading"]["details"]
        for key, value in previous.items():
            self.assertEqual(retained[key], value, key)
        self.assertEqual(retained["regionReadings"], detail["regionReadings"])
        self.assertEqual(self.response["fieldDetails"]["namaIstri"], wife)
        self.assertEqual(self.response["data"]["namaIstri"], "SITI LAMA")

    def test_single_or_disagreeing_votes_never_replace_even_empty_original(self):
        for original in ("BUDI LAMA", "", "BUDI BARU"):
            for texts in (("BUDI BARU",), ("BUDI BARU", "BUDI BARI"),
                          ("BUDI BARU", "BUDI BARI", "BUDI BARA")):
                with self.subTest(original=original, texts=texts):
                    self.setUp()
                    self.response["data"]["namaSuami"] = original
                    before = deepcopy(self.response["fieldDetails"]["namaSuami"])
                    self.refine([self.reading(i, text) for i, text in enumerate(texts)])
                    self.assertEqual(self.response["data"]["namaSuami"], original)
                    detail = self.response["fieldDetails"]["namaSuami"]
                    self.assertEqual(detail["rawText"], before["rawText"])
                    self.assertEqual(detail["source"], before["source"])
                    self.assertEqual(detail["status"], "review")
                    self.assertIn("region_readings_disagree", detail["warnings"])
                    self.assertNotIn("previousReading", detail)

    def test_empty_original_is_filled_only_after_two_votes(self):
        self.response["data"]["namaSuami"] = ""
        self.refine([self.reading(0), self.reading(1)])
        detail = self.response["fieldDetails"]["namaSuami"]
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI BARU")
        self.assertEqual(detail["previousReading"]["text"], "")
        self.assertNotIn("ocr_engine_disagreement", detail["warnings"])

    def test_shared_primary_and_region_reading_beats_correlated_wrong_majority(self):
        self.response["data"]["namaSuami"] = "BUDI.SANTOSO"
        self.refine([self.reading(0, "BUDT SANTOSO"), self.reading(1, "BUDT SANTOSO"),
                     self.reading(2, "BUDI SANTOSO", 80)])
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI SANTOSO")
        detail = self.response["fieldDetails"]["namaSuami"]
        self.assertEqual(detail["alternativeText"], "BUDT SANTOSO")
        self.assertEqual(detail["previousReading"]["text"], "BUDI.SANTOSO")
        self.assertEqual(len(detail["regionReadings"]), 3)
        self.assertEqual(detail["status"], "review")
        self.assertIn("cross_engine_candidate_agreement_check_alternatives", detail["warnings"])

    def test_confirmed_same_name_keeps_baseline_raw_and_does_not_flag_disagreement(self):
        self.refine([self.reading(0, "BUDI LAMA"), self.reading(1, "BUDI LAMA")])
        detail = self.response["fieldDetails"]["namaSuami"]
        self.assertEqual(detail["previousReading"]["details"]["rawText"],
                         "baseline raw namaSuami")
        self.assertNotIn("ocr_engine_disagreement", detail["warnings"])
        self.assertIn("form_dots_removed_check_punctuation", detail["warnings"])

    def test_votes_are_independent_for_each_spouse(self):
        self.refine([self.reading(0, "NAMA BARU"),
                     self.reading(0, "NAMA BARU", field="namaIstri")])
        self.assertEqual(self.response["data"],
                         {"namaSuami": "BUDI LAMA", "namaIstri": "SITI LAMA"})
        self.setUp()
        self.refine([self.reading(0, "SITI BARU", field="namaIstri"),
                     self.reading(2, "SITI BARU", field="namaIstri")])
        self.assertEqual(self.response["data"]["namaIstri"], "SITI BARU")
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI LAMA")

    def test_duplicate_and_unrequested_ids_cannot_manufacture_consensus(self):
        self.refine([self.reading(0), self.reading(0), self.reading(0),
                     self.reading(3), self.reading(-1), self.reading("00"),
                     {"id": "other_1", "text": "BUDI BARU", "confidence": 99},
                     {"text": "BUDI BARU", "confidence": 99}])
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI LAMA")
        detail = self.response["fieldDetails"]["namaSuami"]
        self.assertEqual(len(detail["regionReadings"]), 1)
        self.assertIn("region_readings_disagree", detail["warnings"])

    def test_skipped_field_ids_are_not_accepted_even_if_other_field_is_requested(self):
        self.response["fieldDetails"]["namaIstri"]["status"] = "extracted"
        before = deepcopy(self.response["fieldDetails"]["namaIstri"])
        recognize = self.refine([self.reading(0, "SITI BARU", field="namaIstri"),
                                 self.reading(1, "SITI BARU", field="namaIstri")])
        self.assertEqual([item["id"] for item in recognize.call_args.args[0]],
                         [f"namaSuami_{i}" for i in range(3)])
        self.assertEqual(self.response["data"]["namaIstri"], "SITI LAMA")
        self.assertEqual(self.response["fieldDetails"]["namaIstri"], before)

    def test_invalid_raw_or_cleaned_names_do_not_vote(self):
        for invalid in ("", "12345", "??", None, 123):
            with self.subTest(invalid=invalid):
                self.setUp()
                self.refine([self.reading(0), self.reading(1, invalid),
                             self.reading(2, invalid)])
                self.assertEqual(self.response["data"]["namaSuami"], "BUDI LAMA")
                self.assertEqual(len(self.response["fieldDetails"]["namaSuami"]
                                     ["regionReadings"]), 1)
        self.setUp()
        with patch.object(regions, "recognize_regions", return_value=[
                self.reading(0), self.reading(1)]):
            regions.refine_spouse_names(self.image, self.response, lambda raw: "123", valid_name)
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI LAMA")
        self.assertNotIn("regionReadings", self.response["fieldDetails"]["namaSuami"])

    def test_invalid_raw_cannot_be_rescued_by_cleanup(self):
        cleanup = Mock(return_value="BUDI BARU")
        with patch.object(regions, "recognize_regions", return_value=[
                self.reading(0, "123"), self.reading(1, "123")]):
            regions.refine_spouse_names(self.image, self.response, cleanup, valid_name)
        cleanup.assert_not_called()
        self.assertEqual(self.response["data"]["namaSuami"], "BUDI LAMA")

    def test_timeout_or_missing_runtime_models_preserve_originals_and_details(self):
        for error in (subprocess.TimeoutExpired("node", 45),
                      FileNotFoundError("Node.js missing"),
                      RuntimeError("Tesseract model missing"),
                      ValueError("Invalid JSON"), KeyError("results")):
            with self.subTest(error=type(error).__name__):
                self.setUp()
                before = deepcopy(self.response)
                self.refine(error=error)
                self.assertEqual(self.response["data"], before["data"])
                self.assertEqual(self.response["fieldDetails"], before["fieldDetails"])
                self.assertEqual(self.response["requiresReview"], before["requiresReview"])
                self.assertEqual(len(self.response["warnings"]), 1)
                self.assertIn("Pembacaan ulang nama belum tersedia", self.response["warnings"][0])

    def test_no_regions_means_no_recognizer_or_subprocess(self):
        for reason in ("confident", "no_boxes", "degenerate", "encoding_failed"):
            with self.subTest(reason=reason):
                self.setUp()
                for detail in self.response["fieldDetails"].values():
                    if reason == "confident":
                        detail["status"] = "extracted"
                    elif reason == "no_boxes":
                        detail.pop("boxes")
                    elif reason == "degenerate":
                        detail["boxes"] = [[[30, 30]] * 4]
                before = deepcopy(self.response)
                with patch.object(regions.cv2, "imencode", return_value=(False, None)) if (
                        reason == "encoding_failed") else patch.object(
                            regions, "ROOT", regions.ROOT):
                    with patch.object(regions, "recognize_regions") as recognize, \
                            patch.object(regions.subprocess, "run") as run:
                        regions.refine_spouse_names(self.image, self.response,
                                                    clean_name, valid_name)
                recognize.assert_not_called()
                run.assert_not_called()
                self.assertEqual(self.response, before)


class CropPreprocessingTests(unittest.TestCase):
    def test_line_crop_keeps_thin_strokes_just_outside_detector_edges(self):
        image = np.full((100, 180, 3), 255, dtype=np.uint8)
        # Four disconnected strokes outside the detected rectangle need padding.
        image[40:61, 48:50] = 0
        image[40:61, 111:113] = 0
        image[38:40, 60:100] = 0
        image[61:63, 60:100] = 0
        crop = regions.line_crop(image, [box("", 50, 40, 60, 20)["quad"]])
        self.assertIsNotNone(crop)
        self.assertEqual(crop.dtype, np.uint8)
        self.assertEqual(crop.shape[2], 3)
        self.assertGreater(crop.shape[0], 26)
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        count, _, stats, _ = cv2.connectedComponentsWithStats((gray < 128).astype(np.uint8))
        substantial = [stat for stat in stats[1:count] if stat[cv2.CC_STAT_AREA] >= 10]
        self.assertEqual(len(substantial), 4)

    def test_line_crop_rejects_degenerate_geometry(self):
        image = np.full((50, 100, 3), 255, dtype=np.uint8)
        for width, height in ((0, 0), (2, 20), (20, 2)):
            with self.subTest(width=width, height=height):
                self.assertIsNone(regions.line_crop(image, [
                    box("", 10, 10, width, height)["quad"]]))

    def test_clean_form_dots_removes_small_dots_but_retains_tall_edge_strokes(self):
        image = np.full((40, 100, 3), 255, dtype=np.uint8)
        image[8:32, 0:3] = 0
        image[8:32, 97:100] = 0
        image[9:31, 35:40] = 0
        image[30:32, 55:57] = 0
        image[30:32, 65:67] = 0
        before = image.copy()
        cleaned = regions.clean_form_dots(image)
        self.assertEqual(cleaned.shape, (72, 132))
        self.assertEqual(cleaned.dtype, np.uint8)
        expected = np.full((40, 100), 255, dtype=np.uint8)
        expected[8:32, 0:3] = 0
        expected[8:32, 97:100] = 0
        expected[9:31, 35:40] = 0
        np.testing.assert_array_equal(cleaned[16:-16, 16:-16], expected)
        self.assertTrue(np.all(cleaned[:16] == 255))
        self.assertTrue(np.all(cleaned[-16:] == 255))
        self.assertTrue(np.all(cleaned[:, :16] == 255))
        self.assertTrue(np.all(cleaned[:, -16:] == 255))
        np.testing.assert_array_equal(image, before)


class RecognizeRegionsWrapperTests(unittest.TestCase):
    def test_wrapper_passes_json_and_45_second_timeout_without_running_node(self):
        requested = [{"id": "namaSuami_0", "kind": "name", "image": "synthetic"}]
        expected = [{"id": "namaSuami_0", "text": "BUDI", "confidence": 92}]
        completed = subprocess.CompletedProcess([], 0, json.dumps({"results": expected}), "")
        with patch.object(regions.shutil, "which", return_value="mock-node") as which, \
                patch.object(regions.subprocess, "run", return_value=completed) as run:
            self.assertEqual(regions.recognize_regions(requested), expected)
        which.assert_called_once_with("node")
        run.assert_called_once_with(
            ["mock-node", str(regions.ROOT / "ocr_refine.mjs")],
            input=json.dumps({"regions": requested}), capture_output=True,
            text=True, encoding="utf-8", cwd=regions.ROOT, timeout=45, check=False)

    def test_missing_node_fails_without_subprocess(self):
        with patch.object(regions.shutil, "which", return_value=None), \
                patch.object(regions.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Node.js"):
                regions.recognize_regions([])
        run.assert_not_called()

    def test_timeout_propagates_to_refinement_fallback(self):
        with patch.object(regions.shutil, "which", return_value="mock-node"), \
                patch.object(regions.subprocess, "run",
                             side_effect=subprocess.TimeoutExpired("mock-node", 45)):
            with self.assertRaises(subprocess.TimeoutExpired):
                regions.recognize_regions([])

    def test_nonzero_exit_reports_bounded_stderr(self):
        completed = subprocess.CompletedProcess([], 1, "", "x" * 1000)
        with patch.object(regions.shutil, "which", return_value="mock-node"), \
                patch.object(regions.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError) as caught:
                regions.recognize_regions([])
        self.assertTrue(str(caught.exception).endswith("x" * 300))
        self.assertNotIn("x" * 301, str(caught.exception))


class NumberRegionTests(unittest.TestCase):
    def test_requires_label_and_two_distinct_raster_readings(self):
        image = np.full((120, 500, 3), 255, np.uint8)
        rows = [[box('Nomor Akta')], [box('Q025/025/1/2019', x=260, y=60)]]
        extract = load_service_without_models().extract_no_akta
        readings = [{'id': 'number_0', 'text': '0025/025/1/2019'},
                    {'id': 'number_1', 'text': '0025/025/1/2019'}]
        with patch.object(regions, 'recognize_regions', return_value=readings):
            result = regions.number_region_candidate(image, rows, extract)
        self.assertEqual(result[0], '0025/025/1/2019')
        self.assertEqual(result[1]['status'], 'review')
        for invalid in (readings[:1], [readings[0], dict(readings[1], text='0035/025/1/2019')],
                        [readings[0], readings[0]]):
            with patch.object(regions, 'recognize_regions', return_value=invalid):
                self.assertIsNone(regions.number_region_candidate(image, rows, extract))
        with patch.object(regions, 'recognize_regions') as recognize:
            self.assertIsNone(regions.number_region_candidate(image, rows[1:], extract))
            self.assertIsNone(regions.number_region_candidate(image, [[rows[0][0]], [box('Q025/025/1/2019', x=260, y=100)]], extract))
        recognize.assert_not_called()


if __name__ == "__main__":
    unittest.main()
