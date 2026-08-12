# MonitorWeb — app Android (Capacitor)

Casca nativa para testar e, depois, publicar na Play Store.
**A web em produção/local continua independente** — este app só abre a URL do MonitorWeb num WebView.

## Pré-requisitos

- Node 20+
- [Android Studio](https://developer.android.com/studio) (SDK + emulador ou aparelho USB com depuração)
- JDK 17 (vem com o Android Studio)

## Performance (~8 GB RAM)

Neste PC, **não rode Android Studio e o emulador ao mesmo tempo** — os dois juntos esgotam a memória e o emulador trava (“não está respondendo”).

Fluxo recomendado:

```bash
# editar código nativo
./scripts/studio-light.sh          # fecha o emulador e abre o Studio

# testar o app
./scripts/emu-lite.sh              # fecha o Studio e sobe emulador leve (1 GB)
```

Alternativa ainda melhor: celular físico via USB (quase zero RAM extra no PC).

O AVD `MonitorWeb_Lite` usa 1024 MB RAM, 2 cores e tela 720×1280.

## Setup (uma vez)

```bash
cd mobile
npm install
npm run prepare:prod    # aponta para https://monitorweb-production.up.railway.app
# se ainda não existir a pasta android/:
npx cap add android
npm run sync
npm run open            # abre no Android Studio
```

No Android Studio: rode no emulador ou no celular (`Run ▶`).

## Ambiente de teste

### A) Testar contra produção (Railway)

```bash
cd mobile
npm run prepare:prod
npm run open
```

### B) Testar contra o servidor local

1. Na raiz do repo: `npm start` (porta 3000)
2. No emulador Android, `10.0.2.2` é o `localhost` da sua máquina:

```bash
cd mobile
npm run prepare:local
npm run open
```

Aparelho físico na mesma rede Wi‑Fi:

```bash
MONITORWEB_URL=http://SEU_IP_LAN:3000 npm run prepare:local
```

## Play Store (depois)

1. Conta em [Google Play Console](https://play.google.com/console)
2. Gerar keystore de upload (guarde backup + senhas):

```bash
keytool -genkey -v -keystore monitorweb-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias monitorweb
```

3. Em `android/app/build.gradle`, configurar `signingConfigs` de `release` (não commitar o `.jks` nem senhas)
4. Build → Generate Signed Bundle / APK → **Android App Bundle (.aab)**
5. Enviar o AAB num track de teste interno na Play Console

Identidade do app (já definida):

| Campo | Valor |
|-------|--------|
| applicationId | `br.com.monitorweb.app` |
| appName | MonitorWeb |
| versionName / versionCode | em `android/app/build.gradle` |

## O que este app não altera

- Nada em `server/`, `public/` ou deploy Railway
- Dados continuam no volume `/data` (JSON) do backend
