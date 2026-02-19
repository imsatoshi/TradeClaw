#!/bin/bash

# OpenAlice with Freqtrade startup script
# This script ensures proper environment for connecting to remote Freqtrade

echo "==============================================="
echo "OpenAlice + Freqtrade Launcher"
echo "==============================================="

# Disable proxy for direct connection to Freqtrade
export NO_PROXY='*'
unset HTTP_PROXY
unset HTTPS_PROXY
unset http_proxy
unset https_proxy

echo ""
echo "Freqtrade URL: http://YOUR_FREQTRADE_HOST:8080"
echo "Status: Ready to connect"
echo ""

# Start OpenAlice
pnpm dev
