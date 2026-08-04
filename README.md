# MonitorWeb

Ferramenta web para monitorar mudanças em páginas e avisar por notificação no navegador (PWA) ou no sistema (quando rodar localmente).

## O que faz

- Cadastra URLs com intervalo de checagem
- Compara o conteúdo (texto limpo ou seletor CSS)
- Guarda histórico de alterações com diff
- Envia eventos em tempo real (SSE)
- Notificações no navegador / app instalada
- `notify-send` no Linux quando o servidor roda no mesmo PC

## Rodar local

```bash
export PATH="$HOME/micromamba/envs/dev/bin:$PATH"   # se Node estiver no micromamba
npm install
npm start
```

Abra http://localhost:3000

## Railway

1. Conecte este repositório no Railway
2. Crie um **Volume** montado em `/data` (persistência dos monitores)
3. A variável `PORT` é injetada automaticamente
4. Deploy — o start command é `npm start`

Variáveis opcionais:

| Variável   | Padrão   | Uso                          |
|------------|----------|------------------------------|
| `PORT`     | `3000`   | Porta HTTP                   |
| `DATA_DIR` | `./data` | Pasta do banco JSON          |
| `PROXY_URL` | —       | Proxy HTTP(S) de saída (útil para SEI/RJ a partir do Railway) |
| `FETCH_TIMEOUT_MS` | `20000` | Timeout de busca por página |

### SEI / sites do governo

Alguns sites (como `sei.rj.gov.br`) **não respondem a servidores no exterior**. No Railway (EUA) a checagem pode dar timeout. Opções:

1. Configurar `PROXY_URL` apontando para um proxy no Brasil
2. Rodar o MonitorWeb na sua rede local (`npm start`)

## Notificações

- **Navegador / PWA:** clique em “Ativar notificações” e, se quiser, “Instalar no PC”
- **Desktop local:** deixe “Notificações do sistema” ligado; requer `notify-send` (libnotify)

No Railway, as notificações de desktop do servidor não chegam ao seu PC — use as do navegador/PWA com o painel aberto (ou instalado).
