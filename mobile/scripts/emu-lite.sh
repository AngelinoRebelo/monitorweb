#!/usr/bin/env bash
# Emulador ultra-leve para PCs com ~8 GB RAM.
# Fecha Studio/Gradle antes (eles competem pela mesma memória).
set -euo pipefail

export JAVA_HOME="${JAVA_HOME:-/home/machaddoo/opt/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-/home/machaddoo/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export DISPLAY="${DISPLAY:-:0}"

AVDMANAGER="${ANDROID_HOME}/cmdline-tools/latest/bin/avdmanager"
EMULATOR="${ANDROID_HOME}/emulator/emulator"
ADB="${ANDROID_HOME}/platform-tools/adb"

AVD_NAME="${AVD_NAME:-MonitorWeb_Lite}"
APK="${APK:-/home/machaddoo/PROJETOS/monitorweb/mobile/android/app/build/outputs/apk/debug/app-debug.apk}"

echo "== Liberando RAM (Studio / Gradle / emulador antigo) =="
pkill -f '/opt/android-studio/bin/studio' 2>/dev/null || true
pkill -f 'GradleDaemon' 2>/dev/null || true
"$ADB" emu kill 2>/dev/null || true
pkill -f 'qemu-system-x86_64' 2>/dev/null || true
sleep 2
# force if still alive
pkill -9 -f '/opt/android-studio/bin/studio' 2>/dev/null || true
pkill -9 -f 'qemu-system-x86_64' 2>/dev/null || true
sleep 1
free -h | head -2

# Create lite AVD once
if ! "$AVDMANAGER" list avd 2>/dev/null | grep -q "Name: ${AVD_NAME}"; then
  echo "== Criando AVD leve ${AVD_NAME} =="
  echo no | "$AVDMANAGER" create avd -n "$AVD_NAME" \
    -k "system-images;android-35;google_apis;x86_64" \
    -d medium_phone --force
fi

CFG="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
if [ -f "$CFG" ]; then
  sed -i 's/^hw.cpu.ncore *=.*/hw.cpu.ncore = 2/' "$CFG" || true
  if grep -q '^hw.ramSize' "$CFG"; then
    sed -i 's/^hw.ramSize *=.*/hw.ramSize = 1024/' "$CFG"
  else
    echo 'hw.ramSize = 1024' >> "$CFG"
  fi
  sed -i 's/^vm.heapSize *=.*/vm.heapSize = 128M/' "$CFG" || true
  sed -i 's/^hw.gpu.enabled *=.*/hw.gpu.enabled = yes/' "$CFG" || true
  sed -i 's/^hw.gpu.mode *=.*/hw.gpu.mode = host/' "$CFG" || true
  sed -i 's/^hw.lcd.width *=.*/hw.lcd.width = 720/' "$CFG" || true
  sed -i 's/^hw.lcd.height *=.*/hw.lcd.height = 1280/' "$CFG" || true
  sed -i 's/^hw.lcd.density *=.*/hw.lcd.density = 320/' "$CFG" || true
fi

echo "== Subindo emulador leve =="
nohup "$EMULATOR" -avd "$AVD_NAME" \
  -memory 1024 -cores 2 \
  -no-boot-anim -no-audio -no-snapshot-save \
  -gpu host \
  -netdelay none -netspeed full \
  >/home/machaddoo/opt/emulator-lite.log 2>&1 &
echo EMU_PID=$!

for i in $(seq 1 60); do
  boot=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
  if [ "$boot" = "1" ]; then
    echo BOOT_OK
    break
  fi
  sleep 3
done

if [ -f "$APK" ]; then
  "$ADB" install -r "$APK"
  "$ADB" shell am start -n br.com.monitorweb.app/.MainActivity || true
fi

free -h | head -2
echo "Pronto. Dica: no PC de 8 GB, não abra Android Studio junto com o emulador."
