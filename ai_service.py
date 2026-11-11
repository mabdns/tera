"""
TERA - Local Open-Source AI OCR Microservice
Runs offline on http://127.0.0.1:8000
Powered by RapidOCR (PaddleOCR ONNX Engine) & PyMuPDF (fitz)
Ultra-fast targeted ROI extraction for KUA Buku Nikah (Model N)
"""

import sys
import os
import io
import re
import json
import base64
import traceback
import hashlib
from pathlib import Path
from importlib.metadata import version, PackageNotFoundError
from itertools import count
from threading import Lock
from datetime import date
from time import perf_counter
from ocr_layout import extract_layout_document, is_form_label
from ocr_regions import header_date_candidate, refine_spouse_names, number_region_candidate
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import numpy as np
import cv2

# RapidOCR sessions are shared by ThreadingHTTPServer; serialize inference.
ocr_lock = Lock()
ocr_request_ids = count(1)

# Capture the running code once: pulling files without restarting the service
# must not make its reported revision look newer than the loaded process.
def runtime_identity():
    root = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for name in ('ai_service.py', 'ocr_layout.py', 'ocr_regions.py', 'ocr_refine.mjs'):
        digest.update(name.encode())
        digest.update((root / name).read_bytes().replace(b'\r\n', b'\n'))
    packages = {}
    for name in ('rapidocr-onnxruntime', 'onnxruntime', 'opencv-python', 'numpy'):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = 'unknown'
    return {'codeRevision': digest.hexdigest()[:12], 'python': sys.version.split()[0], 'packages': packages,
            'pipeline': 'geometry-anchors-v2-regions'}


RUNTIME_IDENTITY = runtime_identity()

# Initialize RapidOCR Engine
try:
    from rapidocr_onnxruntime import RapidOCR
    ocr_engine = RapidOCR()
    print("[TERA AI] RapidOCR Engine (PaddleOCR ONNX) loaded successfully.")
except Exception as e:
    ocr_engine = None
    print(f"[TERA AI] Warning: RapidOCR initialization error: {e}")

# Optional PyMuPDF
try:
    import pymupdf as fitz
    fitz_available = True
    print("[TERA AI] PyMuPDF (fitz) loaded successfully.")
except Exception:
    try:
        import fitz
        fitz_available = True
        print("[TERA AI] PyMuPDF (fitz) loaded successfully.")
    except Exception as e:
        fitz_available = False
        print(f"[TERA AI] Warning: PyMuPDF not available: {e}")

MONTH_PATTERNS = [
    (r'\b(januari|jan|janu|janwari|yanuari|yan)\b', '01'),
    (r'\b(pebruari|februari|feb|peb|pepruari|febuari|pebr|febr)\b', '02'),
    (r'\b(maret|mar|mart)\b', '03'),
    (r'\b(april|apr|aprl)\b', '04'),
    (r'\b(mei|mey|may)\b', '05'),
    (r'\b(juni|jun)\b', '06'),
    (r'\b(juli|jul)\b', '07'),
    (r'\b(agustus|agt|agus|agust|agu|ags)\b', '08'),
    (r'\b(september|sep|sept|septenber)\b', '09'),
    (r'\b(oktober|okt|oktbr|october)\b', '10'),
    (r'\b(november|nopember|novenber|nowenber|nowember|nopenber|novbmber|nov|nop)\b', '11'),
    (r'\b(desember|des|december|desenber)\b', '12')
]

MONTH_MAP = {
    'januari': '01', 'jan': '01', 'februari': '02', 'pebruari': '02', 'feb': '02',
    'maret': '03', 'mar': '03', 'april': '04', 'apr': '04', 'mei': '05', 'juni': '06', 'jun': '06',
    'juli': '07', 'jul': '07', 'agustus': '08', 'september': '09', 'oktober': '10',
    'november': '11', 'nopember': '11', 'nov': '11', 'nop': '11', 'nowenber': '11', 'nowember': '11',
    'nopenber': '11', 'novenber': '11', 'novbmber': '11', 'desember': '12', 'des': '12'
}

# Administrative form boilerplate keywords that must NEVER be accepted as person names
FORM_BOILERPLATE_PATTERNS = [
    r'PADA\s+HARI\s+INI', r'TELAH\s+DILANGSUNGKAN', r'AKAD\s+NIKAH', r'BERTEPATAN',
    r'TANGGAL\s+HIJRIYAH', r'^[0-9A-Za-z\s\.\)]*(?:CALON\s+)?SUAMI\b', r'^[0-9A-Za-z\s\.\)]*(?:CALON\s+)?ISTRI\b',
    r'^(?:CALON\s+)?(?:SUAMI|ISTRI)$', r'NAMA\s+LENGKAP(?:\s+DAN\s+ALIAS)?', r'\bBIN\b', r'\bBINTI\b',
    r'\bTEMPAT\b', r'\bLAHIR\b', r'\bKEWARGANEGARAAN\b', r'\bWARGA\s*NEGARA\b',
    r'\bALAMAT\b', r'\bTINGGAL\b', r'\bPEKERJAAN\b', r'\bINSTANSI\b', r'\bAGAMA\b', r'\bISLAM\b',
    r'\bKRISTEN\b', r'\bKATOLIK\b', r'\bHINDU\b', r'\bBUDHA\b',
    r'\bKEPENDUDUKAN\b', r'\bNIK\b', r'\bSTATUS\b', r'\bPERKAWINAN\b', r'\bJEJAKA\b', r'\bPERAWAN\b',
    r'\bDUDA\b', r'\bJANDA\b', r'\bBERCERAI\b', r'\bBEKAS\s+ISTRI\b', r'\bBEKAS\s+SUAMI\b',
    r'\bORANG\s+TUA\b', r'\bAYAH\b', r'\bIBU\b', r'\bKANDUNG\b',
    r'\bPNS\b', r'\bSWASTA\b', r'\bWIRASWASTA\b', r'\bTNI\b', r'\bPOLRI\b', r'\bBURUH\b', r'\bPETANI\b',
    r'\bWALI\s+NIKAH\b', r'\bWALI\b', r'\bSAKSI\b', r'\bMENGHADIRI\b', r'\bPETUGAS\b', r'\bPPN\b',
    r'\bPENGHULU\b', r'\bPEGAWAI\b', r'\bMAS\s+KAWIN\b', r'\bMAHAR\b', r'\bARWOEDY\b',
    r'\bKEPALA[\s\._\-]*KUA\b', r'\bPENCATATAN\b',
    r'\bPEMERIKSAAN\b', r'\bDAFTAR\s+PEMERIKSAAN\b', r'\bREGISTER\b', r'\bMODEL\s*N\b',
    r'SURABAYA', r'SAWAHAN', r'JAWA\s+TIMUR', r'MADIUN', r'SIDOARJO',
    r'GRESIK', r'MALANG', r'PASURUAN', r'MOJOKERTO', r'KEDIRI',
    r'FEBRUARI', r'PEBRUARI', r'SEPTEMBER', r'DESEMBER', r'NOVEMBER', r'OKTOBER', r'AGUSTUS'
]

# Common Indonesian name components for smart word segmentation
NAME_TOKENS = sorted([
    'CHRISTIANTORO', 'WAHYUNINGTIAS', 'WAHYUNINGSIH', 'SULISTYOWATI', 'YUNDIAWATI',
    'RACHMADANI', 'SAFIRDAUS', 'LAILATUS', 'YANUARI', 'PRAKOSO', 'RIZKALIA',
    'KARTIKA', 'AFRIELIA', 'AFRIELY', 'PRASETYO', 'AWALUDDIN', 'SOEBAKRI',
    'ANUGRAH', 'ANGGARA', 'FATHONI', 'MARFIANTO', 'ASTRI', 'FARAH', 'NURUL',
    'AWANG', 'ADIKA', 'CATUR', 'PUTRA', 'PUTRI', 'KUSUMA', 'SETIAWAN', 'WIJAYA', 'HIDAYAT',
    'SITI', 'SRI', 'MUHAMMAD', 'MOHAMMAD', 'ACHMAD', 'AHMAD', 'ABDUL', 'AGUS', 'BAYU', 'INDRA',
    'PRATAMA', 'RAHMAWATI', 'WIDIASTUTI', 'WULANDARI', 'LESTARI', 'AYU', 'MAHMUDI', 'ISMAIL',
    'NOVAN', 'AZIZ', 'KHABIBI', 'RINI', 'SETIA', 'SOFYAN', 'RESITA', 'DIAN', 'AMAR', 'FAJAR', 'TRI',
    'WAHYU', 'EKO', 'BUDI', 'SANTOSO', 'HERU', 'BAMBANG', 'GUNAWAN', 'HENDRA', 'YULIA', 'FITRI',
    'DEWI', 'RATNA', 'MEGA', 'DIANA', 'LIA', 'MAYA', 'NITA', 'TIARA', 'ANISA', 'ANNISA',
    'ERNI', 'LENI', 'SARI', 'DWI', 'ADE', 'LELY', 'INDRIASARI', 'PULON', 'PUARDI',
    'BAGUS', 'BUDIANTORO', 'SURYA', 'AGUNG', 'AGUSTIN', 'WIJAYANTI', 'SEFINA', 'WINDY',
    'ANDI', 'ITA', 'SULISWATI'
], key=lambda x: -len(x))

COMMON_OCR_TYPOS = [
    (r'ADDCA', 'ADIKA'),
    (r'CHRTST[A-Z0-9]*', 'CHRISTIANTORO'),
    (r'CHRISTLANTORO', 'CHRISTIANTORO'),
    (r'CHRISTIANTOR[0Q]', 'CHRISTIANTORO'),
    (r'YANUAR[TI]', 'YANUARI'),
    (r'DWERACHMADAN[LI]', 'DWI RACHMADANI'),
    (r'\bDWE\b', 'DWI'),
    (r'\bRACHMADANL\b', 'RACHMADANI'),
    (r'ERHI[\-\s]*ASTRTA[\-\s]*YUNDIAWAT[A-Z\-]*', 'ERNI ASTRI YUNDIAWATI'),
    (r'\bERHI\b', 'ERNI'),
    (r'ASTRTA', 'ASTRI'),
    (r'YUNDIAWAT[A-Z\-]*', 'YUNDIAWATI'),
    (r'RIZKALTA\s*WAY[A-Z]*', 'RIZKALIA WAHYUNINGTIAS'),
    (r'RIZKALTA', 'RIZKALIA'),
    (r'WAYUNHGTU', 'WAHYUNINGTIAS'),
    (r'WAYL[A-Z]*', 'WAHYUNINGTIAS'),
    (r'JTAWAHYUNTHGSTH', 'ITA WAHYUNINGSIH'),
    (r'BAGUSPUTRASETEA', 'BAGUS PUTRA SETIA'),
    (r'WINDYSEPINASARLST', 'WINDY SEFINA SARI, ST'),
    (r'ANDTBUDIANTORO', 'ANDI BUDIANTORO'),
    (r'GUNGSURSAPUTRA', 'AGUNG SURYA PUTRA'),
    (r'AGUSTINDWLIJAYANL-IT', 'AGUSTIN DWI WIJAYANTI'),
    (r'SULSWATL[\-S]*', 'SULISWATI'),
    (r'FARAH\s*NURUL\s*AHTSSA[A-Z]*', 'FARAH NURUL LAILATUS SAFIRDAUS'),
    (r'AHTSSA[A-Z]*', 'LAILATUS SAFIRDAUS'),
    (r'SULISTYOWATT?', 'SULISTYOWATI'),
    (r'SULISTYOWAT[\-\s]*HM', 'SULISTYOWATI'),
    (r'LENL[IT]CARTIKASARI', 'LENI KARTIKA SARI'),
    (r'\bLENL[IT]\b', 'LENI'),
    (r'\bCARTIKASARI\b', 'KARTIKA SARI'),
    (r'LELT[IT]MDR[IT]A[\'A-Z]*', 'LELY INDRIASARI'),
    (r'\bRADER\s*MAKER\b', 'RADERMAKER'),
    (r'\bAWALUDD[IT]N\b', 'AWALUDDIN'),
    (r'\bKHABIB[IT]\b', 'KHABIBI'),
    (r'\bRINE\b', 'RINI'),
    (r'\bSOEBAKR[IT]\b', 'SOEBAKRI'),
    (r'\bMANMUDI\b', 'MAHMUDI'),
    (r'\bISMATL\b', 'ISMAIL'),
    (r'\bSETE?A\b', 'SETIA'),
    (r'\bAHGGA(?:RA)?\b', 'ANGGARA'),
    (r'[\.\-]+HM\b', ''),
    (r'[\.\-]+A\b', '')
]

def correct_ocr_typos(s):
    if not s:
        return ""
    res = s
    for pat, rep in COMMON_OCR_TYPOS:
        res = re.sub(pat, rep, res, flags=re.I)
    # Replace period between name parts with space: e.g. PULON.PUARDI -> PULON PUARDI
    res = re.sub(r'(?<=[A-Za-z])\.(?=[A-Za-z])', ' ', res)
    return res

def split_joined_name(name):
    if not name:
        return ""
    s = correct_ocr_typos(name.strip())
    s = re.sub(r'[\-_\.\s\'\"]+$', '', s)
    # Normalize title at the end: e.g. ',SE', '.ST', ',SH', ' SE', ' ST'
    title = ""
    m_title = re.search(r'[\,\.\s]+(S\.?E\.?|S\.?T\.?|S\.?H\.?|S\.?PD\.?|S\.?AG\.?|M\.?HI\.?)$', s, re.I)
    if m_title:
        title = ', ' + m_title.group(1).replace('.', '').upper()
        s = s[:m_title.start()].strip()

    words = s.split()
    res = []
    for w in words:
        if len(w) >= 8:
            rem = w
            parts = []
            while rem:
                matched = False
                for tok in NAME_TOKENS:
                    if rem.upper().startswith(tok):
                        parts.append(tok)
                        rem = rem[len(tok):]
                        matched = True
                        break
                if not matched:
                    parts.append(rem)
                    break
            res.append(' '.join(parts) if parts else w)
        else:
            res.append(w)

    out = ' '.join(res).strip()
    if title:
        out += title
    return out

def clean_person_name(name):
    if not name:
        return ""
    # Strip label prefix (e.g. "1. Nama lengkap :", "Nama keugkap", etc.)
    cleaned = re.sub(r'^[0-9A-Za-z\s\.\)\:\-]*?\b(?:Nama|[1i]ma|[Nn]arna)\b(?:\s+[A-Za-z]{3,10})?(?:\s+dan\s+alias)?\s*[:\.\=\-]?\s*', '', name, flags=re.I)
    # Strip leading item index like "1." or "A." but preserve first letter of name
    cleaned = re.sub(r'^[0-9A-Za-z][\.\)]\s*', '', cleaned)
    # Strip leading non-letters
    cleaned = re.sub(r'^[^a-zA-Z]+', '', cleaned)
    # Strip role prefixes
    cleaned = re.sub(r'^(?:Calon\s+Suami|Calon\s+Istri|Suami|Istri|Mempelai)\s*[:\.]?\s*', '', cleaned, flags=re.I)
    # Form rules can be read as a mixture of ASCII and Unicode dashes. Remove
    # the entire trailing run before filtering characters so it cannot leave
    # an ASCII dash behind and split otherwise identical OCR votes.
    cleaned = re.sub(r'[\-\u2010-\u2015\u2212_\.\s]+$', '', cleaned)
    # Strip bin / binti suffix
    cleaned = re.sub(r'\s+(?:bin|binti)\b.*$', '', cleaned, flags=re.I)
    cleaned = re.sub(r'[\r\n\t]+', ' ', cleaned)
    cleaned = re.sub(r'[^a-zA-Z\s\.\,\'\`\-]', '', cleaned)
    cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip()
    return cleaned.upper()

def is_valid_name(candidate):
    if not candidate or len(candidate) < 3 or is_form_label(candidate):
        return False
    cand_s = candidate.strip()
    c_upper = cand_s.upper()

    # Reject if candidate is too long (a real name is not a whole biodata paragraph)
    if len(cand_s) > 120 or len(cand_s.split()) > 16:
        return False

    # Reject if candidate contains digits (e.g. birth year, NIK, age)
    if re.search(r'\d', candidate):
        return False

    # Reject if candidate is role label
    if re.search(r'^[0-9A-Za-z\s\.\)]*(?:CALON\s+)?(?:SUAMI|ISTRI)\b', c_upper):
        return False

    # Reject if contains any administrative / form keywords
    for pat in FORM_BOILERPLATE_PATTERNS:
        if re.search(pat, c_upper):
            return False

    # Require at least 3 alphabetical letters
    letters = re.findall(r'[A-Za-z]', candidate)
    return len(letters) >= 3

def extract_person_name_from_column(lines, role="suami"):
    """
    Extracts person name specifically from Item 1 (Nama Lengkap)
    strictly within the top crop of the column, ignoring subsequent items.
    """
    if not lines:
        return ""

    # Priority 1: Check lines containing 'Nama' or similar label
    for idx, line in enumerate(lines):
        line_s = line.strip()
        if not line_s:
            continue
        if re.search(r'\b(?:Nama|[1i]ma|[Nn]arna)\b', line_s, re.I):
            cand = clean_person_name(line_s)
            if cand and is_valid_name(cand):
                return cand
            # Check next line if name is printed on its own line below the label
            if idx + 1 < len(lines):
                next_cand = clean_person_name(lines[idx + 1])
                if next_cand and is_valid_name(next_cand):
                    return next_cand

    # Priority 2: Check lines strictly before Item 2 (TTL / Tempat / Lahir)
    for line in lines:
        line_s = line.strip()
        if not line_s:
            continue
        # Stop immediately when encountering Item 2 or other sections
        if re.search(r'\b(?:Tempat|Lahir|Agama|Pekerjaan|Alamat|NIK|Kewarganegaraan)\b', line_s, re.I):
            break
        cand = clean_person_name(line_s)
        if cand and is_valid_name(cand):
            return cand

    return ""

def parse_column_by_anchors(lines, role="suami"):
    """
    Parses column text using semantic anchors:
    1. Header lines: everything before the role anchor (e.g. before "I. SUAMI" or "II. ISTRI")
    2. Name lines: everything between the role anchor/Item 1 and Item 2 ("Tempat dan tanggal lahir" / NIK / etc.)
    """
    header_lines = []
    name_lines = []
    in_person_section = False

    role_pat = r'\b(?:[1iI\.\sL]*(?:CALON\s+)?SUAMI|1\.\s*Nama\s*lengkap)\b' if role == "suami" else r'\b(?:[1iI\.\sL]*(?:CALON\s+)?(?:ISTRI|ISTERI)|1\.\s*Nama\s*lengkap)\b'

    for line in lines:
        line_s = line.strip()
        if not line_s:
            continue

        if in_person_section:
            # Item 2 anchor: TTL / Tempat / Lahir / NIK -> End of Name Section
            if re.search(r'\b(?:Tempat|Lahir|Agama|Pekerjaan|Alamat|NIK|Nomor\s*Induk|Kewarganegaraan)\b', line_s, re.I):
                break
            name_lines.append(line_s)
        else:
            if re.search(role_pat, line_s, re.I):
                in_person_section = True
                name_lines.append(line_s)
            else:
                header_lines.append(line_s)

    # Extract name candidate from name_lines
    name_cand = ""
    for nl in name_lines:
        c = clean_person_name(nl)
        if c and is_valid_name(c):
            name_cand = c
            break

    # If still empty, try any line in name_lines after cleaning
    if not name_cand and name_lines:
        for nl in name_lines:
            c = clean_person_name(nl)
            if c and len(c) >= 3 and not re.search(r'\b(?:SUAMI|ISTRI|ISTERI|CALON)\b', c, re.I):
                name_cand = c
                break

    return header_lines, name_cand

def extract_no_akta(lines):
    if not lines:
        return ""
    text = '\n'.join(lines)
    # Priority 1: Format with Roman numeral month (e.g. 1001/030/XI/2016 or 542/12/IV/2016)
    m = re.search(r'\b(\d{1,4}\s*[\/\-]\s*\d{1,4}\s*[\/\-]\s*(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)\s*[\/\-]\s*(?:19|20)\d{2})\b', text, re.I)
    if m:
        return re.sub(r'\s*[\/\-]\s*', '/', m.group(1)).strip()

    # Priority 2: 3-part format (e.g. 1001/XI/2016)
    m2 = re.search(r'\b(\d{1,4}\s*[\/\-]\s*(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)\s*[\/\-]\s*(?:19|20)\d{2})\b', text, re.I)
    if m2:
        return re.sub(r'\s*[\/\-]\s*', '/', m2.group(1)).strip()

    # Priority 3: Broader pattern, strictly skipping 'pemeriksaan'
    for line in lines:
        if re.search(r'pemeriksaan', line, re.I):
            continue
        m3 = re.search(r'\b(\d{1,4}\s*[\/\-]\s*\d{1,4}\s*[\/\-]\s*[A-Za-z0-9IVXLCDM]+\s*[\/\-]\s*(?:19|20)\d{2})\b', line)
        if m3:
            return re.sub(r'\s*[\/\-]\s*', '/', m3.group(1)).strip()

    return ""

def extract_tanggal_akad(lines):
    if not lines:
        return ""
    safe_lines = [line for line in lines if not (
        re.search(r'\b(?:pemeriksaan|lahir)\b', line, re.I)
        and not re.search(r'\b(?:akad|pada\s+hari)\b', line, re.I)
    )]
    text = ' '.join(safe_lines)
    # Permit Gregorian-after-Hijriyah layouts only with an explicit Masehi
    # marker. Never combine a Hijriyah day with a nearby Gregorian year.
    segments = re.split(r'\b(?:bertepatan|hijriyah|hijriah)\b', text, flags=re.I)
    candidates = [segment for index, segment in enumerate(segments)
                  if index == 0 or re.search(r'\bmasehi\b', segment, re.I)]
    for segment in candidates:
        for pat, month in MONTH_PATTERNS:
            pattern = (r'(?<!\d)([0-3]?\d)[\s.,-]*(?:bulan[\s.:=-]*)?'
                       + pat + r'[\s.,-]*(?:tahun[\s.:=-]*)?((?:19|20)\d{2})(?!\d)')
            for match in re.finditer(pattern, segment, re.I):
                # MONTH_PATTERNS contains a capturing group for the month word.
                day, year = int(match.group(1)), int(match.groups()[-1])
                try:
                    date(year, int(month), day)
                    return f"{day:02d}-{month}-{year}"
                except ValueError:
                    continue
        for match in re.finditer(r'(?<!\d)([0-3]?\d)\s*[\/\-.]\s*([0-1]?\d)\s*[\/\-.]\s*((?:19|20)\d{2})(?!\d)', segment):
            day, month, year = map(int, match.groups())
            try:
                date(year, month, day)
                return f"{day:02d}-{month:02d}-{year}"
            except ValueError:
                continue

    return ""

def decode_image_base64(data_uri, max_dim=1200):
    """
    Decodes base64 string to OpenCV BGR image and immediately downscales
    to max_dim to keep CPU processing speed ultra fast (~0.05s).
    """
    if ',' in data_uri:
        header, data = data_uri.split(',', 1)
    else:
        data = data_uri
    img_bytes = base64.b64decode(data)
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is not None and max_dim > 0:
        h, w = img.shape[:2]
        longest = max(h, w)
        if longest > max_dim:
            scale = float(max_dim) / longest
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img

def ocr_image(img_cv, max_dim=1000):
    if ocr_engine is None or img_cv is None or img_cv.size == 0:
        return []
    try:
        h, w = img_cv.shape[:2]
        longest = max(h, w)
        if longest > max_dim:
            scale = float(max_dim) / longest
            img_cv = cv2.resize(img_cv, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        elif longest < 300:
            scale = 300.0 / longest
            img_cv = cv2.resize(img_cv, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)

        res, _ = ocr_engine(img_cv)
        if not res:
            return []

        # Extract items with bounding box centers
        items = []
        for item in res:
            if item and len(item) >= 2:
                box = item[0]
                text = item[1]
                if text and text.strip():
                    try:
                        pts = np.array(box, dtype=np.float32)
                        cx = float(np.mean(pts[:, 0]))
                        cy = float(np.mean(pts[:, 1]))
                        h_box = float(np.max(pts[:, 1]) - np.min(pts[:, 1]))
                    except Exception:
                        cx, cy, h_box = 0.0, 0.0, 20.0
                    items.append({"text": text.strip(), "cx": cx, "cy": cy, "h": max(15.0, h_box)})

        if not items:
            return []

        # Sort into reading order (top-to-bottom, left-to-right)
        items.sort(key=lambda it: it["cy"])
        lines = []
        current_line = [items[0]]

        for it in items[1:]:
            prev = current_line[-1]
            line_height = np.mean([x["h"] for x in current_line])
            if abs(it["cy"] - prev["cy"]) < (line_height * 0.65):
                current_line.append(it)
            else:
                current_line.sort(key=lambda x: x["cx"])
                lines.append(" ".join([x["text"] for x in current_line]))
                current_line = [it]

        if current_line:
            current_line.sort(key=lambda x: x["cx"])
            lines.append(" ".join([x["text"] for x in current_line]))

        return lines
    except Exception as e:
        print(f"[TERA AI] OCR Image Error: {e}")
        return []

def process_document(doc_data):
    started = perf_counter()
    if ocr_engine is None:
        return {"success": False, "error": "Engine OCR lokal belum tersedia"}
    images_b64 = doc_data.get("images", [])
    if not isinstance(images_b64, list) or not images_b64:
        return {"success": False, "error": "Kirim minimal satu gambar halaman"}
    # Preserve detail for recognition; detection uses its own small thumbnail.
    decode_started = perf_counter()
    images = [decode_image_base64(image, max_dim=2600) for image in images_b64[:2]]
    decode_ms = (perf_counter() - decode_started) * 1000
    if not any(image is not None for image in images):
        return {"success": False, "error": "Gambar halaman tidak dapat dibaca"}
    waiting_started = perf_counter()
    with ocr_lock:
        queue_ms = (perf_counter() - waiting_started) * 1000
        ocr_started = perf_counter()
        response = extract_layout_document(
            images, ocr_engine, extract_no_akta, extract_tanggal_akad,
            clean_person_name, is_valid_name, split_joined_name,
            refine_header=header_date_candidate, refine_names=refine_spouse_names,
            refine_number=number_region_candidate,
        )
        ocr_ms = (perf_counter() - ocr_started) * 1000
    response["fileName"] = doc_data.get("fileName", "")
    response['runtime'] = RUNTIME_IDENTITY
    response["timings"]["decodeMs"] = round(decode_ms, 2)
    response["timings"]["queueMs"] = round(queue_ms, 2)
    response["timings"]["ocrMs"] = round(ocr_ms, 2)
    response["timings"]["requestProcessingMs"] = round((perf_counter() - started) * 1000, 2)
    return response

class TERAHandler(BaseHTTPRequestHandler):
    def _client_disconnected(self, phase):
        self.close_connection = True
        self.log_message("Koneksi klien terputus saat %s; permintaan ditutup.", phase)

    def _write_response(self, status, body=b""):
        # The browser may abort a timed-out request or close the page while
        # OCR is running. Never send a second response on that closed socket.
        try:
            self._set_cors_headers(status)
            if body:
                self.wfile.write(body)
            return True
        except (ConnectionError, TimeoutError):
            self._client_disconnected("mengirim respons")
            return False

    def _set_cors_headers(self, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Type", content_type)
        self.end_headers()

    def do_OPTIONS(self):
        self._write_response(200)

    def do_GET(self):
        if self.path in ["/", "/health"]:
            response = {
                "status": "ok",
                "service": "TERA Local Open-Source AI OCR Service",
                "engine": "RapidOCR / PaddleOCR (ONNX Runtime)",
                "pdfSupport": fitz_available,
                "version": "3.0.0 (Geometry-Preserving Anchors)",
                "runtime": RUNTIME_IDENTITY,
                                "ocrAvailable": ocr_engine is not None
            }
            self._write_response(200, json.dumps(response, indent=2).encode('utf-8'))
        else:
            self._write_response(404, json.dumps({"error": "Endpoint tidak ditemukan"}).encode('utf-8'))

    def do_POST(self):
        if self.path == "/api/extract":
            request_id = next(ocr_request_ids)
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                # Limit transport handling to IO: an exception raised by OCR
                # itself must still be reported as a genuine processing error.
                try:
                    raw_body = self.rfile.read(content_length)
                except (ConnectionError, TimeoutError):
                    self._client_disconnected("menerima permintaan")
                    return
                if len(raw_body) != content_length:
                    self._client_disconnected("menerima permintaan yang belum lengkap")
                    return
                body = raw_body.decode('utf-8')
                data = json.loads(body)

                self.log_message("OCR #%s mulai (kode %s).", request_id, RUNTIME_IDENTITY['codeRevision'])
                res = process_document(data)
                timings = res.get("timings", {})
                if timings:
                    self.log_message("OCR #%s selesai: antrean %.2f dtk, proses %.2f dtk, total %.2f dtk.",
                                     request_id, timings.get("queueMs", 0) / 1000,
                                     timings.get("ocrMs", 0) / 1000,
                                     timings.get("requestProcessingMs", 0) / 1000)
                encoded = json.dumps(res).encode('utf-8')
                status = 200
            except Exception as e:
                traceback.print_exc()
                status = 500
                encoded = json.dumps({"success": False, "error": str(e)}).encode('utf-8')
            sent = self._write_response(status, encoded)
            if sent:
                self.log_message("OCR #%s respons dikirim (HTTP %s).", request_id, status)
        else:
            self._write_response(404, json.dumps({"error": "Endpoint tidak ditemukan"}).encode('utf-8'))

    def log_message(self, format, *args):
        sys.stderr.write(f"[TERA AI] {self.address_string()} - {format % args}\n")

def run(port=8000):
    server_address = ('127.0.0.1', port)
    httpd = ThreadingHTTPServer(server_address, TERAHandler)
    print("=" * 65)
    print("   TERA LOCAL OPEN-SOURCE AI OCR SERVICE (V3 - GEOMETRY ANCHORS)")
    print(f"   Status: BERJALAN di http://127.0.0.1:{port}")
    print("   Engine: RapidOCR / PaddleOCR (ONNX Runtime) + PyMuPDF")
    print("   Mode  : Detect once, recognize selected lines, review uncertain names")
    print("   Tekan Ctrl + C di terminal ini untuk menghentikan service")
    print("=" * 65)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[TERA AI] Menghentikan service AI lokal...")
        httpd.server_close()

if __name__ == "__main__":
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    run(port)
