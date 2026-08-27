FROM node:22-alpine

WORKDIR /app

# Baileys possui dependências instaladas via Git.
# A imagem Alpine é mínima e não inclui o executável git por padrão.
RUN apk add --no-cache git openssh-client

COPY package.json ./
RUN npm install --omit=dev

# Arquivos da aplicação.
# O lid-hotfix.js precisa existir em /app porque o package.json inicia com:
# node --import ./lid-hotfix.js server.js
COPY server.js db.js auth-store.js whatsapp.js message-store.js lid-hotfix.js ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["npm", "start"]
