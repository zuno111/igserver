@echo off
chcp 65001 >nul
title igServer
cd /d "%~dp0"

echo ============================================
echo   igServer - STUDIO ig 공통 서버
echo ============================================
echo.

rem 빌드된 단독 실행파일이 있으면 Node 없이 바로 실행
if exist "igserver.exe" (
  echo [실행파일] 단독 실행파일로 시작 (Node 불필요)
  echo   관리 대시보드: http://localhost:8787/admin/
  start "" http://localhost:8787/admin/
  igserver.exe
  pause
  exit /b 0
)
if exist "dist\igserver.exe" (
  echo [실행파일] dist 단독 실행파일로 시작 (Node 불필요)
  echo   관리 대시보드: http://localhost:8787/admin/
  start "" http://localhost:8787/admin/
  dist\igserver.exe
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo [안내] Node.js 가 설치되어 있지 않습니다.
  echo        단독 실행파일(igserver.exe)을 쓰거나, https://nodejs.org 에서 Node를 설치하세요.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/2] 최초 1회 구성요소 설치 중... 잠시만 기다리세요.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [오류] 설치 실패. 인터넷 연결을 확인하세요.
    pause
    exit /b 1
  )
)

echo [2/2] 서버 시작
echo.
echo   관리 대시보드:  http://localhost:8787/admin/
echo   (종료하려면 이 창을 닫으세요)
echo.
start "" http://localhost:8787/admin/
node src/index.js
pause
