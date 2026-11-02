#!/bin/bash
# Double-click to start Piano Tutor for your iPad. Keep the window open while you practise.
cd "$(dirname "$0")" && exec /usr/bin/python3 server.py
