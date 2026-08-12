#!/usr/bin/env bash
# Launch Android Studio in "light" mode for ~8 GB RAM machines.
# Does NOT start the emulator (use a physical phone, or start the AVD later alone).
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/home/machaddoo/opt/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-/home/machaddoo/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

STUDIO="${STUDIO:-/home/machaddoo/opt/android-studio/bin/studio}"
PROJECT="${1:-/home/machaddoo/PROJETOS/monitorweb/mobile/android}"

# Stop leftover Gradle daemons so they don't fight Studio for RAM
if command -v jps >/dev/null 2>&1; then
  jps -l 2>/dev/null | awk '/GradleDaemon/{print $1}' | xargs -r kill 2>/dev/null || true
fi

# Warn if emulator is already eating RAM
if pgrep -f 'qemu-system-x86_64' >/dev/null 2>&1; then
  echo "AVISO: emulador Android já está rodando (~2GB+). Feche-o se o PC travar."
  echo "  pkill -f qemu-system-x86_64"
fi

free -h | head -2
echo "Abrindo Android Studio (heap limitado a ~1.25 GB)..."
exec "$STUDIO" "$PROJECT"
