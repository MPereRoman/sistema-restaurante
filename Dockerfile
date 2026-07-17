FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends cups-client imagemagick librsvg2-bin fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/public/uploads && chown -R node:node /app/public/uploads

USER node
EXPOSE 3002
CMD ["node", "server.js"]
