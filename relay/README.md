# MonitorWeb Relay (Brasil)

Microserviço que busca páginas **a partir de São Paulo (Fly.io `gru`)** e devolve o conteúdo ao MonitorWeb no Railway.

Isso contorna o bloqueio/timeout do SEI e outros sites que não respondem de servidores nos EUA.

## Variáveis

| Variável | Obrigatória | Uso |
|----------|-------------|-----|
| `RELAY_SECRET` | sim | Token compartilhado com o MonitorWeb |
| `PORT` | não | Padrão `8080` |
| `FETCH_TIMEOUT_MS` | não | Padrão `25000` |

## Deploy (Fly.io · São Paulo)

```bash
export PATH="$HOME/.fly/bin:$PATH"
cd relay
fly auth login
fly apps create monitorweb-relay --org personal
fly secrets set RELAY_SECRET='SEU_SEGREDO_FORTE'
fly deploy
```

## No Railway (MonitorWeb)

```bash
railway variable set FETCH_RELAY_URL=https://monitorweb-relay.fly.dev
railway variable set FETCH_RELAY_SECRET='SEU_SEGREDO_FORTE'
# opcional (compatibilidade):
railway variable set PROXY_URL=https://monitorweb-relay.fly.dev
```
