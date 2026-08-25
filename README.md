# MEK Cloud Mobile

Primeira versão do engine para Northflank.

## Endpoints

- `/` painel de status
- `/health` health check do engine + PostgreSQL
- `/api/status` status em JSON

## Variáveis de ambiente

- `PORT` — opcional, padrão `8080`
- `DATABASE_URL` — fornecida pelo Secret Group da Northflank

Nenhuma credencial deve ser colocada no repositório.
