FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ENV HOST=0.0.0.0 \
    PORT=8080 \
    PUBLIC_HOME=cesium \
    NODE_ENV=production

EXPOSE 8080
WORKDIR /app/visualizer
CMD ["node", "server.mjs"]
