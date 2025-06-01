# TronpickMaster

Automated bot for TronPick.io platform with manual withdrawal system and VNC remote access.

## Features
- ✅ Automatic account registration and login
- ✅ Email verification handling via IMAP
- ✅ Hourly faucet claims (every 62 minutes)
- ✅ Automated roulette gameplay with Martingale strategy
- ✅ Manual withdrawal system with automatic detection
- ✅ Telegram notifications for system events and balance changes
- ✅ VNC remote access support for manual operations
- ✅ Persistent state management with recovery capabilities

## System Requirements
- Ubuntu 20.04+ (tested on Google Cloud Platform)
- Node.js 18+
- TigerVNC Viewer (for remote access)
- Gmail account with app password (for email verification)
- Telegram bot (optional, for notifications)

## Quick Setup Guide

### 1. Server Setup (SSH)
```bash
# Connect to your VPS via SSH
ssh ubuntu@YOUR_VPS_IP

# Clone the repository
git clone https://github.com/yourusername/TronpickMaster.git
cd TronpickMaster

# Run the setup script
chmod +x setup.sh
./setup.sh
```

### 2. VNC Verification
```bash
# From your local machine, use TigerVNC Viewer
# Connect to: YOUR_VPS_IP:1
# Password: 383360
```

### 3. Bot Execution
```bash
# On the VPS (via SSH or VNC terminal)
node index.js

# Follow the configuration prompts:
# - Email credentials
# - TronPick account details  
# - Telegram settings (optional)
# - Withdrawal address
```

## Configuration

The bot will prompt you for the following information on first run:

### Required Settings
- **Email**: Your email address for TronPick registration
- **TronPick Username**: Desired username (auto-generated if not provided)
- **TronPick Password**: Password for your TronPick account
- **Withdrawal Address**: Your TRX wallet address
- **IMAP Settings**: Email server details for verification

### Optional Settings
- **Referral Code**: TronPick referral code
- **Telegram Bot Token**: For system notifications
- **Telegram Channel IDs**: For system and money alerts
- **VPS Identifier**: Unique identifier for this instance

## Manual Withdrawal Process

### How It Works
1. Bot monitors balance continuously
2. When balance reaches **16.638300 TRX**, system pauses roulette
3. Telegram notification sent with VNC connection details
4. **You manually withdraw via VNC connection**
5. System automatically detects withdrawal and resumes

### VNC Connection for Withdrawals
```
IP Address: YOUR_VPS_IP
Port: 5901  
Password: 383360
Connection: YOUR_VPS_IP:1
```

### Manual Steps
1. Receive Telegram notification
2. Connect via VNC to your server
3. Navigate to TronPick withdrawal page in the browser
4. Perform withdrawal manually
5. System automatically detects balance change and resumes

## Telegram Notifications

### System Events
- Bot started/stopped
- Withdrawal threshold reached
- System resumed after withdrawal
- Critical errors and recovery

### Money Events  
- Balance changes ≥0.2%
- Withdrawal confirmations
- Balance inactivity alerts

## File Structure
```
TronpickMaster/
├── index.js                 # Entry point
├── Orchestrator.js          # Main state machine
├── setup.sh                 # Environment setup script
├── package.json            # Dependencies
├── src/
│   ├── modules/
│   │   ├── AuthHandler.js   # Login/registration
│   │   ├── BrowserManager.js # Browser control
│   │   ├── ConfigManager.js  # Configuration
│   │   ├── EmailVerifier.js  # Email verification
│   │   ├── FaucetClaimer.js  # Faucet operations
│   │   ├── RoulettePlayer.js # Roulette strategy
│   │   └── TelegramNotifier.js # Notifications
│   └── utils/
│       ├── helpers.js       # Utility functions
│       └── logger.js        # Logging system
├── screenshots/             # Diagnostic screenshots
├── temp/                   # Temporary files
└── user-data/              # Browser profile data
```

## Troubleshooting

### VNC Connection Issues
```bash
# Restart VNC service
sudo systemctl restart vncserver@1.service

# Check VNC status
sudo systemctl status vncserver@1.service

# Manual VNC start
sudo -u ubuntu vncserver :1 -geometry 1024x768 -depth 24
```

### Bot Issues
```bash
# Check logs in real-time
tail -f /path/to/logfile

# Restart the bot
# Press Ctrl+C to stop, then run: node index.js
```

### Browser Issues
```bash
# Clear browser data
rm -rf user-data/*

# Check Chromium installation
which chromium-browser
```

## Security Notes

- VNC password is hardcoded as `383360` for simplicity
- Change VNC password for production use
- Firewall is configured to allow VNC access (port 5901)
- Browser runs in non-headless mode for VNC access

## Support

For issues, questions, or contributions:
1. Check the troubleshooting section
2. Review logs and screenshots in the respective directories
3. Create an issue with detailed logs and error messages

## License

This project is for educational purposes. Use responsibly and in accordance with TronPick.io terms of service.
