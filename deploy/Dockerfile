# Build dalla radice del repository:  docker build -f deploy/Dockerfile -t substack-cli:0.1.0 .
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
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /config /data && chown -R node:node /config /data
USER node
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["help"]
