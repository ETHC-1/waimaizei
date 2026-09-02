FROM docker.xuanyuan.run/node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY api ./api
COPY server.js index.html admin.html ./

USER node
EXPOSE 3000
CMD ["node", "server.js"]
