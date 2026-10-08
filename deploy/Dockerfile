# Build dalla radice del repository:  docker build -f deploy/Dockerfile -t substack-cli:0.1.0 .
# Per build riproducibili fissa l'immagine base al digest, es.
#   FROM node:22-alpine@sha256:<digest>   (docker buildx imagetools inspect node:22-alpine)
# e aggiornalo consapevolmente; il tag da solo può cambiare contenuto a ogni pull.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    SUBSTACK_CLI_CONFIG_DIR=/config \
    SUBSTACK_CLI_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
# npm, npx, corepack e yarn servono solo per installare le dipendenze: a runtime l'entrypoint è node,
# quindi vengono rimossi dall'immagine finale (meno superficie d'attacco, meno CVE da seguire).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
COPY --from=build /app/dist ./dist
RUN mkdir -p /config /data && chown -R node:node /config /data
USER node
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["help"]
