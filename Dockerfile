# ── Stage 1: Node.js dependencies ────────────────────────────────────────────
FROM node:20-slim AS node-deps

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: Final image ──────────────────────────────────────────────────────
FROM node:20-slim

# Install Python 3 + pip only — no Chromium/Puppeteer needed (Baileys is pure Node)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      curl \
      ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Make python3/pip3 available as python/pip
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

# Copy Node deps from stage 1
COPY --from=node-deps /app/node_modules ./node_modules

# Copy Node source
COPY package.json session_manager.js wa_register_baileys.js ./

# Install Python deps
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# Copy Python source
COPY bot.py db.py utils.py otp_store.py seed_github.py ./

# Expose port
EXPOSE 8080

# Start both services
COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
