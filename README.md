# agent-factory

> **In English:** builds and schedules agents that use the tools of an
> [ai-assistant](https://github.com/Spinedac3/ai-assistant) over MCP. Work in progress.

Arma y programa agentes que trabajan con las herramientas de un
[ai-assistant](https://github.com/Spinedac3/ai-assistant). Un agente se describe conversando, se
ensaya antes de programarlo y corre solo cuando toca; avisa por correo con `send_notice` y anexa
el detalle como Excel. Nunca toca una base de datos ni un documento por su cuenta: todo lo pide al
asistente por MCP, con un token que solo alcanza las herramientas de esa corrida y las que su dueño
puede usar.

**En construcción.** Este README crece con cada rebanada.

## Levantarlo

Necesitas Node 22, pnpm y Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d     # su propia base, en el puerto 5434
pnpm dev                 # http://localhost:3100/health
pnpm check               # typecheck, Biome y tests
```

Corre al lado del asistente: usa otro puerto y otra base.

## Licencia

[AGPL-3.0](LICENSE)
