@echo off
setlocal
cd /d "%~dp0"
title TERA - Perbarui Mesin OCR
set "TERA_AI_PYTHON=.venv-ocr312\Scripts\python.exe"
echo Hentikan layanan AI lokal sebelum menjalankan pembaruan ini.
echo OCR TERA memakai Python 3.12 64-bit dan RapidOCR 1.4.4.
echo Lingkungan lama tetap dipertahankan.
echo.
if exist "%TERA_AI_PYTHON%" goto install
py -3.12 -c "import sys, struct; raise SystemExit(0 if sys.version_info[:2]==(3,12) and struct.calcsize('P')==8 else 1)" >nul 2>nul
if not errorlevel 1 goto create_with_py
python -c "import sys, struct; raise SystemExit(0 if sys.version_info[:2]==(3,12) and struct.calcsize('P')==8 else 1)" >nul 2>nul
if not errorlevel 1 goto create_with_python
goto missing_python
:create_with_py
py -3.12 -m venv ".venv-ocr312"
if errorlevel 1 goto failed
goto install
:create_with_python
python -m venv ".venv-ocr312"
if errorlevel 1 goto failed
:install
echo Python yang digunakan:
"%TERA_AI_PYTHON%" -c "import sys, struct; print(sys.executable); print(sys.version); raise SystemExit(0 if sys.version_info[:2]==(3,12) and struct.calcsize('P')==8 else 1)"
if errorlevel 1 goto incompatible
"%TERA_AI_PYTHON%" -m pip install --upgrade --requirement "%~dp0requirements-ocr.txt"
if errorlevel 1 goto failed
"%TERA_AI_PYTHON%" -c "from importlib.metadata import version; v=version('rapidocr-onnxruntime'); print('RapidOCR terpasang: '+v); raise SystemExit(0 if v=='1.4.4' else 1)"
if errorlevel 1 goto failed
echo.
echo Pembaruan selesai. Jalankan kembali jalankan_ai_lokal.bat.
pause
exit /b 0
:missing_python
echo Python 3.12 64-bit belum ditemukan. Pasang berdampingan dengan Python yang ada.
echo Unduh installer Windows 64-bit resmi:
echo https://www.python.org/downloads/release/python-31210/
echo Aktifkan Python Launcher saat instalasi, lalu jalankan kembali skrip ini.
pause
exit /b 1
:incompatible
echo Folder .venv-ocr312 tidak memakai Python 3.12 64-bit.
echo Lingkungan tersebut tidak diubah. Kirim pesan ini untuk pemeriksaan.
goto failed
:failed
echo.
echo Pembaruan gagal. Simpan pesan error di atas untuk pemeriksaan.
pause
exit /b 1
