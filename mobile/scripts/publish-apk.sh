#!/usr/bin/env bash
# Gera o APK (produção) e copia para o site em public/downloads/MonitorWeb.apk
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOBILE="$ROOT/mobile"
OUT="$ROOT/public/downloads/MonitorWeb.apk"

export JAVA_HOME="${JAVA_HOME:-/home/machaddoo/opt/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-/home/machaddoo/Android/Sdk}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

cd "$MOBILE"
npm run prepare:prod
cd android

if [ -f keystore.properties ]; then
  echo "== Release assinado (keystore.properties) =="
  ./gradlew assembleRelease --quiet
  SRC="app/build/outputs/apk/release/app-release.apk"
else
  echo "== Debug assinado (sem keystore ainda — ok para download no site) =="
  ./gradlew assembleDebug --quiet
  SRC="app/build/outputs/apk/debug/app-debug.apk"
fi

mkdir -p "$(dirname "$OUT")"
cp -f "$SRC" "$OUT"
ls -lh "$OUT"
echo "Pronto: $OUT"
echo "Faça commit + push (e railway up) para publicar no site."
