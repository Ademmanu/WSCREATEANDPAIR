# ── Stage 1: Node.js dependencies ────────────────────────────────────────────
FROM node:20-slim AS node-deps

WORKDIR /app

# Skip Puppeteer's Chromium download — we use system Chromium in stage 2
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: Final image ──────────────────────────────────────────────────────
FROM node:20-slim

# Install Python 3 + pip + all Chromium/Puppeteer system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      curl \
      wget \
      gnupg \
      ca-certificates \
      chromium \
      fonts-liberation \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      xdg-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Skip Puppeteer Chromium download and point to system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Make python3/pip3 available as python/pip
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

# Copy Node deps from stage 1
COPY --from=node-deps /app/node_modules ./node_modules

# Copy all application files
COPY package.json ./
COPY session_manager.js ./
COPY .github/ ./.github/

# Install Python deps
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# Copy Python source
COPY bot.py db.py github_actions.py utils.py otp_store.py ./

# Expose port
EXPOSE 8080

# Start both services
COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
