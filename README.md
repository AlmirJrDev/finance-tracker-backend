# Finance Tracker — API

API do [Finance Tracker](https://github.com/AlmirJrDev/Finance-Tracker). Express + MongoDB (Mongoose) + Zod, em TypeScript, com deploy serverless na Vercel.

## Rodando localmente

```bash
npm install
npm run dev:memory   # sobe a API com um MongoDB embutido (não precisa do Atlas)
```

A API sobe em `http://localhost:3001`, os dados ficam em `.data/mongo` e o login de desenvolvimento fica habilitado:

```bash
curl -X POST http://localhost:3001/api/auth/dev -H "Content-Type: application/json" -d '{"email":"voce@local.test"}'
```

Para usar o Atlas: copie `.env.example` para `.env`, preencha e rode `npm run dev`.

## Scripts

| Script | O que faz |
| --- | --- |
| `npm run dev` | API com hot reload usando o `.env` |
| `npm run dev:memory` | API com MongoDB embutido |
| `npm test` | Testes (Vitest + Supertest + MongoDB em memória) |
| `npm run typecheck` | Checagem de tipos |
| `npm run migrate:v2` | Migra dados do formato antigo (simulação por padrão) |

## Convenções

- **Valores em centavos** (`amountCents`, inteiro). R$ 12,34 → `1234`. Sem erro de arredondamento.
- **Datas como texto** `YYYY-MM-DD` e meses como `YYYY-MM`. Não dependem do fuso do servidor.
- **Tipos**: `income` (entrada) e `expense` (saída).
- **Resumos calculados na hora**: o saldo inicial de um mês é a soma de tudo antes dele. Não existe cache para ficar desatualizado.
- Respostas no formato `{ success, data }` ou `{ success: false, error, message, details? }`.

## Endpoints

Todas as rotas, exceto `/health` e `/api/auth/google|dev`, exigem `Authorization: Bearer <token>`.

| Método | Rota | Descrição |
| --- | --- | --- |
| POST | `/api/auth/google` | `{ idToken }` → `{ token, expiresAt, user }` |
| POST | `/api/auth/dev` | Login local (só com `ALLOW_DEV_LOGIN=true` fora de produção) |
| GET | `/api/auth/me` | Usuário logado |
| PUT | `/api/auth/preferences` | `{ timezone?, currency? }` |
| GET | `/api/transactions` | Filtros: `month`, `from`, `to`, `type`, `status`, `categoryId`, `q`, `sort`, `page`, `limit` (máx. 500) |
| GET/PUT/DELETE | `/api/transactions/:id` | |
| POST | `/api/transactions` | `{ date, description, amountCents, type, status?, categoryId?, note? }` — sem `status`, data futura fica `pending` |
| POST | `/api/transactions/status` | `{ ids, status }` — altera várias de uma vez |
| POST | `/api/transactions/installments` | `{ date, description, totalAmountCents, installments (2–72), type?, categoryId?, note? }` |
| DELETE | `/api/transactions/installments/:groupId` | `?onlyPending=true` mantém as parcelas pagas |
| GET/POST | `/api/categories` | A lista cria as categorias padrão na primeira vez |
| PUT/DELETE | `/api/categories/:id` | Remover move as transações para "Outros" |
| GET/POST | `/api/recurring-transactions` | `?active=true\|false` |
| GET/PUT/DELETE | `/api/recurring-transactions/:id` | |
| POST | `/api/recurring-transactions/apply` | `{ from: "2026-09", to: "2027-08", ids? }` — idempotente, máx. 24 meses |
| GET | `/api/summary/month/:YYYY-MM` | Totais, saldo dia a dia e gastos por categoria |
| GET | `/api/summary/year/:YYYY` | 12 meses com saldo encadeado |
| GET | `/api/summary/months` | Meses que têm transações |
| GET | `/api/summary/projection` | `?days=7..366` (padrão 90): saldo pago hoje, saldo previsto dia a dia, menor saldo, primeira data negativa, atrasadas e próximos 7 dias |
| GET | `/api/budgets` | `?month=YYYY-MM` (padrão: mês atual): gasto pago, previsto, % e nível (`ok`, `warning`, `exceeded`) |
| PUT/DELETE | `/api/budgets/:categoryId` | `{ amountCents, alertPercent? }` (alerta padrão em 80%) |
| GET | `/api/cron/recurring` | Chamado pela Vercel com `Authorization: Bearer $CRON_SECRET` |

## Status, projeção e recorrências automáticas

- Toda transação é `paid` ou `pending`. Documentos antigos sem status contam como pagos.
- Resumos trazem os totais **previstos** (tudo) e os **pagos** (`paidIncomeCents`, `paidFinalBalanceCents`...).
- A projeção soma as pendentes e as ocorrências das recorrências ativas que **ainda não foram geradas**, sem contar duas vezes.
- Ocorrências geradas com data passada nascem pagas; as futuras, pendentes. Com `autoConfirm: true`, viram pagas quando a data chega.
- O cron diário (`vercel.json`, 09:00 UTC) gera o mês atual e o próximo para todos os usuários e confirma as automáticas. Defina `CRON_SECRET` nas variáveis da Vercel; sem ele o endpoint fica desativado.

## Migração dos dados antigos (v1 → v2)

```bash
npm run migrate:v2                                               # simulação: mostra o que vai mudar
npm run migrate:v2 -- --apply --remove-duplicates --drop-summaries
```

Converte `amount` (Decimal128) → `amountCents`, datas → `YYYY-MM-DD`, `entrada/saída` → `income/expense`, remove campos desnormalizados e a coleção `monthlysummaries`. `--remove-duplicates` apaga as cópias de transações recorrentes geradas pelo bug antigo, mantendo a mais antiga. Também define o status das transações antigas: até hoje `paid`, datas futuras `pending`. Faça um backup (snapshot no Atlas) antes de aplicar.
