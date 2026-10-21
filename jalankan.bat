@echo off
echo Memeriksa instalasi Node.js...
node -v >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js tidak ditemukan! 
    echo Harap instal Node.js terlebih dahulu dari https://nodejs.org/
    pause
    exit /b
)

echo Menginstal dependensi aplikasi...
call npm install

echo Menjalankan aplikasi...
:: Ubah 'npm start' menjadi 'node index.js' atau 'node app.js' jika Anda tidak menggunakan script start di package.json
call npm run dev
pause