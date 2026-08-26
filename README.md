# MEK Cloud Mobile v0.2.0

Versão inicial do WhatsApp Engine do MEK Cloud Mobile.

## O que esta versão faz

- mantém o backend Node.js online na Northflank;
- testa PostgreSQL em `/health`;
- conecta ao WhatsApp via QR Code;
- não usa Chromium, Selenium ou Android virtual;
- persiste credenciais e Signal keys no PostgreSQL;
- tenta reconectar automaticamente quando a conexão cai;
- restaura a sessão após reinício do container;
- protege conectar, QR e logout com `ADMIN_TOKEN`;
- não implementa disparos automáticos nesta versão.

## Endpoints

### Públicos

- `/`
- `/health`
- `/api/status`

### Protegidos por `Authorization: Bearer <ADMIN_TOKEN>`

- `GET /api/admin/verify`
- `GET /api/whatsapp/admin-status`
- `GET /api/whatsapp/qr`
- `POST /api/whatsapp/connect`
- `POST /api/whatsapp/logout`

## Variáveis de ambiente

### Obrigatórias

`DATABASE_URL`

Já deve estar sendo injetada pelo Secret Group da Northflank.

`ADMIN_TOKEN`

Crie um token forte e aleatório, com pelo menos 32 caracteres, e armazene-o
somente no Secret Group/Environment da Northflank.

NUNCA coloque o token no GitHub.

### Opcional

`WHATSAPP_SESSION_ID`

Padrão: `primary`.

## Banco de dados

As tabelas abaixo são criadas automaticamente:

- `mek_whatsapp_auth_creds`
- `mek_whatsapp_auth_keys`
- `mek_whatsapp_state`

Credenciais e Signal keys são material sensível de autenticação. Não exponha
o conteúdo dessas tabelas e mantenha o PostgreSQL privado.

## Primeiro uso

1. Faça deploy da v0.2.0.
2. Configure `ADMIN_TOKEN` na Northflank.
3. Abra a URL pública do `mek-mobile-engine`.
4. Digite o mesmo `ADMIN_TOKEN` no painel.
5. Clique em `CONECTAR WHATSAPP`.
6. Escaneie o QR Code em WhatsApp → Aparelhos conectados → Conectar um aparelho.
7. Depois de conectado, a sessão será salva no PostgreSQL.

## Observação importante

Baileys é uma integração não oficial baseada no protocolo do WhatsApp Web.
Use apenas de forma legítima, especialmente com contatos que tenham autorizado
o recebimento de mensagens. Não use para spam ou envio abusivo.
