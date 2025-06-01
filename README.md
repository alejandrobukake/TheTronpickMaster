# TronpickMaster

Automated bot for TronPick.io platform with manual withdrawal system.

## Features
- Automatic account registration and login
- Email verification handling
- Hourly faucet claims (every 62 minutes)
- Roulette gameplay with Martingale strategy
- Manual withdrawal system with VNC notifications
- Telegram notifications
- VNC remote access support

## Setup
1. Clone repository
2. Run: `chmod +x setup.sh && ./setup.sh`
3. Run: `node index.js`
4. Follow configuration prompts

## VNC Access
- Port: 5901
- Password: 383360
- Use TigerVNC Viewer to connect

## Manual Withdrawal Process
1. Bot detects threshold (16.638300 TRX)
2. Telegram notification with VNC info
3. Connect via VNC to perform withdrawal
4. System resumes automatically

## Requirements
- Ubuntu 20.04+
- Node.js 18+
- TigerVNC Viewer (for remote access)"# TheTronpickMaster" 
