@echo off
title LiveVisualUsage
echo.
echo  LiveVisualUsage - Claude Code Session Monitor
echo  ================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found.
    echo  Install from https://nodejs.org ^(LTS^) then run this again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo  First run: installing dependencies...
    echo.
    npm ci --omit=dev
    if %errorlevel% neq 0 (
        echo  ERROR: npm install failed.
        pause
        exit /b 1
    )
)

if not exist config.json (
    copy config.example.json config.json >nul
    echo  Created config.json from template.
)

node dist\server\index.js
