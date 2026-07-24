# IA Ventas — Backend API

API Node.js/Express multi-tenant: auth, documentos/RAG, agente WhatsApp, WooCommerce y MASSI Bot.

## Inicio rápido

```bash
cp .env.example .env    # completar secretos localmente
npm install
npm run setup           # primera vez: tablas DynamoDB local + admin
npm run dev             # http://localhost:3000/api/v1
```

**Admin dev:** `admin@iaventas.com` / `Admin123!` (solo seed local)

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [`docs/whatsapp-massi.md`](docs/whatsapp-massi.md) | Flujo WhatsApp + MASSI, botones, plugin WP |
| [`../AGENTS.md`](../AGENTS.md) | Contexto completo para agentes IA (workspace) |
| [`../docs/setup-aws.md`](../docs/setup-aws.md) | Despliegue AWS |

## Módulos principales

| Módulo | Descripción |
|--------|-------------|
| `builderbot` | WhatsApp BuilderBot Cloud v2 / wa-api |
| `sales-agent` | Agente OpenAI + flujo conversacional con botones |
| `massi-bot` | Cliente REST plugin WordPress `massi-bot-api` |
| `woocommerce` | Catálogo WC + config bot por tenant |
| `knowledge` | Documentos, embeddings, RAG |

## Seguridad — `.gitignore`

**No subir nunca:**

- `backend/.env` (secretos JWT, OpenAI, BuilderBot, AWS)
- Credenciales WC / Application Password (van en DynamoDB por tenant, no en repo)

Si `.env` fue commiteado por error: `git rm --cached .env`, rotar todos los secretos y volver a commitear.

## Scripts útiles

```bash
npm run typecheck
npm run secrets:generate
npm run db:init:aws      # tablas producción AWS
```

## Remote

Repositorio: `https://github.com/StikW/IA-Ventas-B`
