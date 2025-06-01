#!/bin/bash

# Script to configure the environment for TronpickMaster on Ubuntu

echo "--- Starting TronpickMaster environment setup ---"

# Ensure the script stops if any command fails
set -e

# 1. Create necessary directories
echo "--> Creating necessary directories..."
mkdir -p screenshots temp user-data

# 2. Update package list
echo "--> Updating package list..."
sudo apt-get update -y

# 3. Install basic dependencies (curl, if not present)
echo "--> Installing curl and other basic dependencies..."
sudo apt-get install curl wget git build-essential -y

# 4. Install Node.js v18 using NodeSource
echo "--> Setting up NodeSource repository for Node.js v18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
echo "--> Installing Node.js v18..."
sudo apt-get install nodejs -y
echo "--> Verifying installed versions:"
node -v
npm -v

# 5. Install Xvfb (needed for headless:false on server)
echo "--> Installing Xvfb..."
sudo apt-get install xvfb -y

# 6. Install Chromium Browser
echo "--> Installing Chromium Browser..."
sudo apt-get install chromium-browser -y
echo "--> Verifying Chromium installation:"
which chromium-browser || echo "WARNING: chromium-browser not found in PATH after installation."

# 7. Install TigerVNC Server and minimal desktop environment
echo "--> Installing TigerVNC Server and desktop environment..."
sudo apt-get install tigervnc-standalone-server tigervnc-xorg-extension xfce4 xfce4-terminal dbus-x11 -y

# 8. Get the server's IP address
echo "--> Detecting server IP address..."
SERVER_IP=$(curl -s ifconfig.me)
echo "Server IP detected: $SERVER_IP"

# 9. Configure VNC Server
echo "--> Configuring VNC Server..."
# Create VNC directory for ubuntu user
sudo -u ubuntu mkdir -p /home/ubuntu/.vnc

# Set VNC password (383360)
echo "383360" | sudo -u ubuntu vncpasswd -f > /home/ubuntu/.vnc/passwd
sudo chmod 600 /home/ubuntu/.vnc/passwd
sudo chown ubuntu:ubuntu /home/ubuntu/.vnc/passwd

# Create VNC startup script
sudo -u ubuntu tee /home/ubuntu/.vnc/xstartup > /dev/null << 'EOF'
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF

sudo chmod +x /home/ubuntu/.vnc/xstartup
sudo chown ubuntu:ubuntu /home/ubuntu/.vnc/xstartup

# 10. Configure firewall for VNC
echo "--> Configuring firewall for VNC access..."
sudo ufw allow 5901/tcp
sudo ufw --force enable

# 11. Start VNC server
echo "--> Starting VNC server..."
sudo -u ubuntu vncserver :1 -geometry 1024x768 -depth 24 || echo "VNC server start failed, but service will handle it"

# 12. Create VNC service for auto-start
sudo tee /etc/systemd/system/vncserver@.service > /dev/null << 'EOF'
[Unit]
Description=Start TigerVNC server at startup
After=syslog.target network.target

[Service]
Type=forking
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu
PIDFile=/home/ubuntu/.vnc/%H:%i.pid
ExecStartPre=-/usr/bin/vncserver -kill :%i > /dev/null 2>&1
ExecStart=/usr/bin/vncserver -depth 24 -geometry 1024x768 :%i
ExecStop=/usr/bin/vncserver -kill :%i

[Install]
WantedBy=multi-user.target
EOF

# Enable VNC service
sudo systemctl daemon-reload
sudo systemctl enable vncserver@1.service

# Verify VNC service status
echo "--> Verifying VNC service status..."
sudo systemctl status vncserver@1.service --no-pager || echo "VNC service not running yet (normal on first setup)"

# 7. Install project-specific dependencies
echo "--> Installing project-specific dependencies..."
npm install puppeteer-real-browser imapflow winston quoted-printable cheerio mailparser node-fetch@3

# 8. Set execution permissions
echo "--> Setting execution permissions..."
chmod +x index.js

# 9. Verify src directory structure
echo "--> Verifying src directory structure..."
mkdir -p src/modules src/utils

# 10. Show summary
echo "--- Environment setup completed successfully ---"
echo "Project structure:"
ls -la
echo ""
echo "Node.js dependencies installed:"
npm list --depth=0
echo ""
echo "=== VNC CONNECTION INFORMATION ==="
echo "VNC Server IP: $SERVER_IP"
echo "VNC Port: 5901"
echo "VNC Password: 383360"
echo "Connection string: $SERVER_IP:5901"
echo "=== TO CONNECT ==="
echo "Use TigerVNC Viewer or any VNC client"
echo "Address: $SERVER_IP:1"
echo "Password: 383360"
echo ""
echo "Remember to run the bot with: node index.js"
echo "-----------------------------------------------------------"

echo ""
echo "=== NEXT STEPS ==="
echo "1. Test VNC connection from your local machine:"
echo "   - Use TigerVNC Viewer"
echo "   - Connect to: $SERVER_IP:1"
echo "   - Password: 383360"
echo "2. Run the bot:"
echo "   - cd to project directory"
echo "   - Run: node index.js"
echo "   - Follow configuration prompts"
echo ""

exit 0