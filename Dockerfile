FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json ./
RUN npm run build \
    && npm prune --omit=dev \
    && npm rebuild node-pty \
    && npm run postinstall

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DEFAULT_PROVIDER=copilot \
    PORT=3456 \
    PROJECT_DIR=/workspace \
    EVEN_BIND_ADDRESS=0.0.0.0

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /home/node/.copilot \
    && git config --system --add safe.directory /workspace \
    && chown -R node:node /workspace /home/node/.copilot

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./

USER node

EXPOSE 3456
VOLUME ["/workspace", "/home/node/.copilot"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const net=require('node:net');const port=Number(process.env.PORT||3456);const socket=net.connect(port,'127.0.0.1',()=>{socket.end();process.exit(0)});socket.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000).unref()"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
