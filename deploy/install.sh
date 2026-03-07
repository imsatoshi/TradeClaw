#!/bin/bash
# Install TradeClaw as a systemd service
# Usage: bash deploy/install.sh

set -e

SERVICE_NAME="tradeclaw"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing ${SERVICE_NAME} systemd service..."

# Copy service file
cp "${SCRIPT_DIR}/tradeclaw.service" "${SERVICE_FILE}"

# Reload systemd
systemctl daemon-reload

# Enable on boot
systemctl enable "${SERVICE_NAME}"

echo "Done. Commands:"
echo "  systemctl start ${SERVICE_NAME}    # start"
echo "  systemctl stop ${SERVICE_NAME}     # stop"
echo "  systemctl restart ${SERVICE_NAME}  # restart"
echo "  systemctl status ${SERVICE_NAME}   # status"
echo "  journalctl -u ${SERVICE_NAME} -f   # follow logs"
echo "  tail -f /root/TradeClaw/app.log    # app logs"
