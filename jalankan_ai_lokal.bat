@echo off
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
if exist ".venv\Scripts\python.exe" (
    .venv\Scripts\python.exe ai_service.py
) else (
    py ai_service.py
    if %ERRORLEVEL% NEQ 0 (
        python ai_service.py
    )
)
pause

