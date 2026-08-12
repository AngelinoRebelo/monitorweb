#!/usr/bin/env bash
# Launch Android Studio in "light" mode for ~8 GB RAM machines.
# Stops the emulator first so Studio has room to breathe.
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/home/machaddoo/opt/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-/home/machaddoo/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

STUDIO="${STUDIO:-/home/machaddoo/opt/android-studio/bin/studio}"
PROJECT="${1:-/home/machaddoo/PROJETOS/monitorweb/mobile/android}"

echo "== Fechando emulador/Gradle para liberar RAM =="
adb emu kill 2>/dev/null || true
pkill -f 'qemu-system-x86_64' 2>/dev/null || true
if command -v jps >/dev/null 2>&1; then
  jps -l 2>/dev/null | awk '/GradleDaemon/{print $1}' | xargs -r kill 2>/dev/null || true
fi
sleep 1
free -h | head -2

echo "Abrindo Android Studio (heap ~1.25 GB). Para testar o app, use depois:"
echo "  mobile/scripts/emu-lite.sh"
exec "$STUDIO" "$PROJECT"
