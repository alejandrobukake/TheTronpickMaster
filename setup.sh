#!/bin/bash

# Script to configure the environment for TronpickMaster on Ubuntu
# Enhanced version with improved VNC configuration and error handling

echo "--- Starting TronpickMaster environment setup ---"

# Ensure the script stops if any command fails
set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

# 1. Create necessary directories
print_status "Creating necessary directories..."
mkdir -p screenshots temp user-data logs

# 2. Update package list
print_status "Updating package list..."
sudo apt-get update -y

# 3. Install basic dependencies
print_status "Installing curl and other basic dependencies..."
sudo apt-get install -y curl wget git build-essential software-properties-common

# 4. Install Node.js v18 using NodeSource
print_status "Setting up NodeSource repository for Node.js v18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
print_status "Installing Node.js v18..."
sudo apt-get install -y nodejs
print_status "Verifying installed versions:"
node -v
npm -v

# 5. Install display server dependencies
print_status "Installing display server dependencies..."
sudo apt-get install -y xvfb x11vnc xorg dbus-x11

# 6. Install Chromium Browser and dependencies
print_status "Installing Chromium Browser and dependencies..."
sudo apt-get install -y \
    chromium-browser \
    chromium-codecs-ffmpeg \
    chromium-codecs-ffmpeg-extra \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libasound2

print_status "Verifying Chromium installation:"
which chromium-browser || print_error "chromium-browser not found in PATH after installation."

# 7. Install TigerVNC Server and minimal desktop
print_status "Installing TigerVNC Server and minimal desktop..."
sudo apt-get install -y \
    tigervnc-standalone-server \
    tigervnc-xorg-extension \
    openbox \
    xterm \
    x11-xserver-utils

# 8. Get the server's IP address
print_status "Detecting server IP address..."
SERVER_IP=$(curl -s ifconfig.me)
echo "Server IP detected: $SERVER_IP"

# 9. Configure VNC Server for ubuntu user
print_status "Configuring VNC Server..."

# Stop any existing VNC servers
sudo -u ubuntu vncserver -kill :1 2>/dev/null || true
sleep 2

# Create VNC directory for ubuntu user
sudo -u ubuntu mkdir -p /home/ubuntu/.vnc

# Set VNC password (383360)
echo "383360" | sudo -u ubuntu vncpasswd -f > /home/ubuntu/.vnc/passwd
sudo chmod 600 /home/ubuntu/.vnc/passwd
sudo chown ubuntu:ubuntu /home/ubuntu/.vnc/passwd

# Create ultra-minimal VNC startup script
sudo -u ubuntu tee /home/ubuntu/.vnc/xstartup > /dev/null << 'EOF'
#!/bin/bash
# Ultra-minimal VNC startup for TronpickMaster

# Set display
export DISPLAY=:1

# Start window manager (openbox - very minimal)
openbox-session &

# Start a terminal automatically in the center of the screen
sleep 2
xterm -geometry 120x40+50+50 -fa 'Monospace' -fs 12 -bg black -fg green -e bash -c "cd ~/TronpickMaster && echo '=== TronpickMaster Terminal ===' && echo '' && echo 'To start the bot, run:' && echo '  node index.js' && echo '' && exec bash" &
EOF

sudo chmod +x /home/ubuntu/.vnc/xstartup
sudo chown ubuntu:ubuntu /home/ubuntu/.vnc/xstartup

# Create VNC configuration file for better performance
sudo -u ubuntu tee /home/ubuntu/.vnc/config > /dev/null << 'EOF'
# VNC server configuration
geometry=1280x1024
depth=24
dpi=96
localhost=no
alwaysshared
EOF

sudo chown ubuntu:ubuntu /home/ubuntu/.vnc/config

# 10. Configure firewall for VNC and SSH
print_status "Configuring firewall for VNC access..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 5901/tcp  # VNC
sudo ufw allow 6001/tcp  # X11 forwarding (optional)
sudo ufw --force enable

# 11. Create systemd service for VNC (more reliable than cron)
print_status "Creating VNC systemd service..."
sudo tee /etc/systemd/system/vncserver@1.service > /dev/null << 'EOF'
[Unit]
Description=TigerVNC server for display 1
After=syslog.target network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu

# Clean any existing lock files
ExecStartPre=/bin/bash -c '/usr/bin/vncserver -kill :1 > /dev/null 2>&1 || :'
ExecStartPre=/bin/bash -c 'rm -f /tmp/.X1-lock /tmp/.X11-unix/X1'
ExecStartPre=/bin/sleep 2

# Start VNC server
ExecStart=/usr/bin/vncserver :1 -fg -geometry 1280x1024 -depth 24 -localhost no

# Restart policy
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable and start VNC service
sudo systemctl daemon-reload
sudo systemctl enable vncserver@1.service
sudo systemctl start vncserver@1.service

# 12. Create helper script for managing VNC
print_status "Creating VNC management script..."
sudo tee /usr/local/bin/vnc-control > /dev/null << 'EOF'
#!/bin/bash
# VNC control script for TronpickMaster

case "$1" in
    start)
        echo "Starting VNC server..."
        sudo systemctl start vncserver@1.service
        ;;
    stop)
        echo "Stopping VNC server..."
        sudo systemctl stop vncserver@1.service
        ;;
    restart)
        echo "Restarting VNC server..."
        sudo systemctl restart vncserver@1.service
        ;;
    status)
        sudo systemctl status vncserver@1.service --no-pager
        ;;
    logs)
        sudo journalctl -u vncserver@1.service -f
        ;;
    *)
        echo "Usage: vnc-control {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
EOF

sudo chmod +x /usr/local/bin/vnc-control

# 13. Install project dependencies
print_status "Installing project-specific dependencies..."
npm install puppeteer-real-browser imapflow winston quoted-printable cheerio mailparser node-fetch@3

# 14. Create launcher script for the bot
print_status "Creating bot launcher script..."
tee run-bot.sh > /dev/null << 'EOF'
#!/bin/bash
# Bot launcher with automatic restart

while true; do
    echo "[$(date)] Starting TronpickMaster bot..."
    node index.js
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 0 ]; then
        echo "[$(date)] Bot exited normally."
        break
    else
        echo "[$(date)] Bot crashed with exit code $EXIT_CODE. Restarting in 30 seconds..."
        sleep 30
    fi
done
EOF

chmod +x run-bot.sh

# 14a. Create systemd service for the bot (for later use)
print_status "Creating bot systemd service (for later use after configuration)..."
sudo tee /etc/systemd/system/tronpickmaster.service > /dev/null << 'EOF'
[Unit]
Description=TronpickMaster Bot Service
After=network.target vncserver@1.service
Wants=vncserver@1.service

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/TronpickMaster
Environment="DISPLAY=:1"
Environment="XAUTHORITY=/home/ubuntu/.Xauthority"

# Start command
ExecStart=/home/ubuntu/TronpickMaster/run-bot.sh

# Restart configuration
Restart=always
RestartSec=30

# Logging
StandardOutput=append:/home/ubuntu/TronpickMaster/logs/bot.log
StandardError=append:/home/ubuntu/TronpickMaster/logs/bot-error.log

[Install]
WantedBy=multi-user.target
EOF

# Create bot control script
print_status "Creating bot control script..."
sudo tee /usr/local/bin/bot-control > /dev/null << 'EOF'
#!/bin/bash
# Bot control script for TronpickMaster

case "$1" in
    start)
        echo "Starting TronpickMaster bot service..."
        sudo systemctl start tronpickmaster.service
        ;;
    stop)
        echo "Stopping TronpickMaster bot service..."
        sudo systemctl stop tronpickmaster.service
        ;;
    restart)
        echo "Restarting TronpickMaster bot service..."
        sudo systemctl restart tronpickmaster.service
        ;;
    status)
        sudo systemctl status tronpickmaster.service --no-pager
        ;;
    logs)
        tail -f /home/ubuntu/TronpickMaster/logs/bot.log
        ;;
    enable)
        echo "Enabling bot to start on system boot..."
        sudo systemctl enable tronpickmaster.service
        ;;
    disable)
        echo "Disabling bot from starting on system boot..."
        sudo systemctl disable tronpickmaster.service
        ;;
    *)
        echo "Usage: bot-control {start|stop|restart|status|logs|enable|disable}"
        exit 1
        ;;
esac
EOF

sudo chmod +x /usr/local/bin/bot-control

# DON'T enable the service yet - user needs to configure first
sudo systemctl daemon-reload
# sudo systemctl enable tronpickmaster.service  # Commented out - user will enable after config

# 15. Set up log rotation
print_status "Setting up log rotation..."
sudo tee /etc/logrotate.d/tronpickmaster > /dev/null << 'EOF'
/home/ubuntu/TronpickMaster/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    create 0644 ubuntu ubuntu
}
EOF

# 16. Verify VNC service status
print_status "Verifying VNC service status..."
sleep 3
sudo systemctl status vncserver@1.service --no-pager || print_warning "VNC service not running yet"

# 17. Create connection info file
print_status "Creating connection info file..."
tee connection-info.txt > /dev/null << EOF
=== VNC CONNECTION INFORMATION ===
VNC Server IP: $SERVER_IP
VNC Port: 5901
VNC Password: 383360
Connection string: $SERVER_IP:1 or $SERVER_IP:5901

=== TO CONNECT ===
1. Using TigerVNC Viewer (Recommended):
   - Download from: https://github.com/TigerVNC/tigervnc/releases
   - Address: $SERVER_IP:1
   - Password: 383360

2. Using other VNC clients:
   - Address: $SERVER_IP:5901
   - Password: 383360

=== USEFUL COMMANDS ===
VNC Control:
- Check VNC status: vnc-control status
- Restart VNC: vnc-control restart
- View VNC logs: vnc-control logs

Bot Control (RECOMMENDED FOR 24/7):
- Start bot service: bot-control start
- Stop bot service: bot-control stop
- Check bot status: bot-control status
- View bot logs: bot-control logs
- Enable auto-start on boot: bot-control enable

Manual execution (NOT recommended for production):
- Run bot manually: ./run-bot.sh
- Run bot in background: nohup ./run-bot.sh > bot.log 2>&1 &

=== TROUBLESHOOTING ===
If VNC doesn't work:
1. Check status: sudo systemctl status vncserver@1.service
2. Check logs: sudo journalctl -u vncserver@1.service -n 50
3. Restart service: sudo systemctl restart vncserver@1.service
4. Check firewall: sudo ufw status
EOF

# 18. Final summary
echo ""
print_status "Environment setup completed successfully!"
echo ""
cat connection-info.txt
echo ""
print_status "Next steps:"
echo ""
echo "1. Connect via VNC from your local machine:"
echo "   - Use TigerVNC Viewer"
echo "   - Address: $SERVER_IP:1"
echo "   - Password: 383360"
echo ""
echo "2. You'll see a minimal desktop with a terminal already open"
echo ""
echo "3. In the terminal, simply run:"
echo "   node index.js"
echo ""
echo "4. Complete the configuration prompts"
echo ""
echo "5. The browser will open automatically and start the automation"
echo ""
print_warning "After initial setup, you can use 'bot-control start' to run 24/7"
echo ""

exit 0
