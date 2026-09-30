FROM node:22-slim
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server server
COPY frontend frontend
RUN mkdir -p data && chown node:node data
USER node
ENV NODE_ENV=production COOKIE_SECURE=1 TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "server/index.js"]
