@echo off
setlocal
cd /d "%~dp0"
title TERA - Perbarui Mesin OCR
set "TERA_AI_PYTHON=py"
if exist ".venv\Scripts\python.exe" (
    set "TERA_AI_PYTHON=.venv\Scripts\python.exe"
) else (
    where py >nul 2>nul
    if errorlevel 1 set "TERA_AI_PYTHON=python"
)
echo Hentikan layanan AI lokal sebelum menjalankan pembaruan ini.
echo Python yang diperbarui:
"%TERA_AI_PYTHON%" -c "import sys; print(sys.executable)"
if errorlevel 1 goto failed
echo.
"%TERA_AI_PYTHON%" -m pip install --upgrade --requirement "%~dp0requirements-ocr.txt"
if errorlevel 1 goto failed
"%TERA_AI_PYTHON%" -c "from importlib.metadata import version; v=version('rapidocr-onnxruntime'); print('RapidOCR terpasang: '+v); raise SystemExit(0 if v=='1.4.4' else 1)"
if errorlevel 1 goto failed
echo.
echo Pembaruan selesai. Jalankan kembali jalankan_ai_lokal.bat.
pause
exit /b 0
:failed
echo.
echo Pembaruan gagal. Simpan pesan error di atas untuk pemeriksaan.
pause
exit /b 1
