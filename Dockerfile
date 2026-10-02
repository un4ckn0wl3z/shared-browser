FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji fonts-thai-tlwg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=17890 \
    CHROME_BIN=/usr/bin/chromium \
    HEADLESS=1 \
    CHROME_NO_SANDBOX=1 \
    DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 17890
CMD ["node", "src/server.mjs"]
