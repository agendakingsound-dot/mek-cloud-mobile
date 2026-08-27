FROM node:22-alpine

WORKDIR /app

# Baileys possui dependências instaladas via Git.
# A imagem Alpine é mínima e não inclui o executável git por padrão.
RUN apk add --no-cache git openssh-client

COPY package.json ./
RUN npm install --omit=dev

# Arquivos da aplicação.
# Hotfixes carregados pelo package.json antes do server.js:
# - single-session-hotfix.js: lock exclusivo da sessão WhatsApp no PostgreSQL
# - lid-hotfix.js: diagnóstico PN/LID mantendo envio pelo PN original
COPY server.js db.js auth-store.js whatsapp.js message-store.js lid-hotfix.js single-session-hotfix.js ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["npm", "start"]
