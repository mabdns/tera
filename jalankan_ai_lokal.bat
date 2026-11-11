@echo off
setlocal
cd /d "%~dp0"
title TERA - Local AI OCR Service (Offline)
color 0A
cls
echo ===================================================================
echo             TERA - TINJAU ELEKTRONIK DOKUMEN AKTA
echo           Local Open-Source Handwriting AI OCR Engine
echo ===================================================================
echo.
echo Sedang menyalakan engine AI lokal (PaddleOCR PP-OCRv4 + PyMuPDF)...
echo URL Service : http://127.0.0.1:8000
echo.
set "TERA_AI_PYTHON=py"
if exist ".venv-ocr312\Scripts\python.exe" (
    set "TERA_AI_PYTHON=.venv-ocr312\Scripts\python.exe"
) else if exist ".venv\Scripts\python.exe" (
    set "TERA_AI_PYTHON=.venv\Scripts\python.exe"
) else (
    where py >nul 2>nul
    if errorlevel 1 set "TERA_AI_PYTHON=python"
)
"%TERA_AI_PYTHON%" -c "import sys; from importlib.metadata import version; v=version('rapidocr-onnxruntime'); print('Python: '+sys.executable); print(sys.version); print('RapidOCR: '+v); print('PERHATIAN: versi uji TERA adalah 1.4.4. Jalankan perbarui_mesin_ocr.bat.' if v!='1.4.4' else 'Versi RapidOCR sesuai pengujian TERA.')"
if errorlevel 1 goto failed
"%TERA_AI_PYTHON%" ai_service.py
set "TERA_AI_EXIT=%ERRORLEVEL%"
pause
exit /b %TERA_AI_EXIT%
:failed
echo Python atau RapidOCR belum tersedia. Jalankan perbarui_mesin_ocr.bat.
pause
exit /b 1

