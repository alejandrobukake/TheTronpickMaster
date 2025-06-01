#!/bin/bash

# Script para configurar el entorno para TronpickMaster en Ubuntu

echo "--- Iniciando configuración del entorno para TronpickMaster ---"

# Asegurarse de que el script se detenga si un comando falla
set -e

# 1. Crear directorios necesarios
echo "--> Creando directorios necesarios..."
mkdir -p screenshots temp user-data

# 2. Actualizar lista de paquetes
echo "--> Actualizando lista de paquetes..."
sudo apt-get update -y

# 3. Instalar dependencias básicas (curl, si no está)
echo "--> Instalando curl y otras dependencias básicas..."
sudo apt-get install curl wget git build-essential -y

# 4. Instalar Node.js v18 usando NodeSource
echo "--> Configurando repositorio NodeSource para Node.js v18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
echo "--> Instalando Node.js v18..."
sudo apt-get install nodejs -y
echo "--> Verificando versiones instaladas:"
node -v
npm -v

# 5. Instalar Xvfb (necesario para headless:false en servidor)
echo "--> Instalando Xvfb..."
sudo apt-get install xvfb -y

# 6. Instalar Chromium Browser
echo "--> Instalando Chromium Browser..."
sudo apt-get install chromium-browser -y
echo "--> Verificando instalación de Chromium:"
which chromium-browser || echo "ADVERTENCIA: chromium-browser no encontrado en PATH después de la instalación."

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
sudo -u ubuntu vncserver :1 -geometry 1024x768 -depth 24

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

# 7. Instalar dependencias específicas del proyecto
echo "--> Instalando dependencias específicas del proyecto..."
npm install puppeteer-real-browser imapflow winston quoted-printable cheerio mailparser node-fetch@3

# 8. Configurar permisos de ejecución
echo "--> Configurando permisos de ejecución..."
chmod +x index.js

# 9. Verificar estructura de directorios de src
echo "--> Verificando estructura de directorios de src..."
mkdir -p src/modules src/utils

# 10. Mostrar resumen
echo "--- Configuración del entorno completada exitosamente ---"
echo "Estructura del proyecto:"
ls -la
echo ""
echo "Dependencias Node.js instaladas:"
npm list --depth=0
echo ""
echo "=== INFORMACIÓN DE CONEXIÓN VNC ==="
echo "IP del Servidor VNC: $SERVER_IP"
echo "Puerto VNC: 5901"
echo "Contraseña VNC: 383360"
echo "Cadena de conexión: $SERVER_IP:5901"
echo "=== PARA CONECTAR ==="
echo "Usa TigerVNC Viewer o cualquier cliente VNC"
echo "Dirección: $SERVER_IP:1"
echo "Contraseña: 383360"
echo ""
echo "Recuerda ejecutar el bot con: node index.js"
echo "-----------------------------------------------------------"

exit 0