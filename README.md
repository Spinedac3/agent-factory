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

Necesitas Node 22, pnpm, Docker, un [ai-assistant](https://github.com/Spinedac3/ai-assistant)
corriendo y el [CLI de Claude](https://docs.claude.com/en/docs/claude-code) con sesión iniciada.

```bash
pnpm install
cp .env.example .env
docker compose up -d     # su propia base, en el puerto 5434
pnpm db:migrate
pnpm dev                 # http://localhost:3100/health
pnpm check               # typecheck, Biome y tests
pnpm test:integration    # también los que usan su base
```

Corre al lado del asistente: usa otro puerto y otra base. En el asistente se declara como cliente de
máquina con `pnpm machine:create agent-factory`, y el secreto que deja se copia a
`secrets/agent-factory.secret` aquí. `pnpm assistant:check <persona> <herramienta>` prueba el enlace.

## Programas

Un agente es un **programa**: un grafo sin ciclos de pasos que el motor recorre siempre igual. Con
las mismas respuestas de las herramientas toma el mismo camino y hace las mismas llamadas. El modelo
solo redacta, dentro de un paso agéntico, sobre datos que el programa ya contó.

| Paso | Hace |
|---|---|
| `start` | Donde empieza |
| `query` | Llama una herramienta con parámetros fijos y guarda lo que devuelve |
| `classify` | Pone cada fila en la primera clase cuyo corte cumple, o en la de resto; las excepciones cambian la clase según el día |
| `join` | Cruza dos listas ya leídas, uno a uno, por una clave |
| `decision` | Elige la primera salida cuya condición se cumple, o la `otherwise` |
| `action` | Llama una herramienta una vez (`once`), una vez por fila (`per_row`), o redacta con el modelo (`agentic`), un mensaje por grupo |
| `end` | Termina: `delivered`, `no_findings` o `failed` |

Si una herramienta falla, el paso salta a su `on_failure`; sin él, la corrida termina como
`failed`, diciendo por qué. Lo que fallaría en toda corrida, como parámetros que la herramienta
rechaza o un campo que ya no trae, termina la corrida aunque haya `on_failure`. Lo que el paso
agéntico le pasa al modelo tiene un tope de 400 KB: para más filas, `summarize` cuenta y suma antes.

Cada programa se juzga contra las herramientas que su dueño puede usar ese día, leídas por MCP con
sus esquemas: lo que falte o no cuadre sale en una lista. Un borrador se guarda aunque tenga
errores; una versión solo se publica limpia y ya no cambia.

| Ruta | Para qué |
|---|---|
| `GET /programs` | Mis programas |
| `PUT /programs/:code` | Guarda el borrador (`name`, `description`, `program`) y devuelve sus errores y advertencias |
| `GET /programs/:code` | El borrador y sus versiones publicadas |
| `POST /programs/:code/publish` | Publica el borrador como versión nueva, si no tiene errores |
| `POST /programs/:code/runs` | Corre la última versión ahora; responde con el id de la corrida |
| `GET /programs/:code/runs` · `GET /runs/:id` | Las corridas, con cada paso, cada llamada y el texto final |

Cada ruta pide la sesión del asistente (`Authorization: Bearer`) y solo muestra lo de esa persona.
`demo/programs/credito-alto.json` es un programa de ejemplo sobre la base demo del asistente.

## Licencia

[AGPL-3.0](LICENSE)
