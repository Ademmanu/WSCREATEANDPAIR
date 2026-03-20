# ── Stage 1: Node.js dependencies ────────────────────────────────────────────
FROM node:20-slim AS node-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Rewrite SSH GitHub URLs → HTTPS (libsignal-node uses ssh:// URL)
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --global http.sslVerify true

COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: Final image ──────────────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      curl \
      ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

COPY --from=node-deps /app/node_modules ./node_modules

COPY package.json session_manager.js wa_register_baileys.js ./

COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY bot.py db.py utils.py otp_store.py seed_github.py ./

EXPOSE 8080

COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
