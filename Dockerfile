# ── Stage 1: Node.js dependencies ────────────────────────────────────────────
FROM node:20-slim AS node-deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: Final image ──────────────────────────────────────────────────────
FROM python:3.12-slim

# Install Node.js 20 + system deps for Puppeteer/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      wget \
      gnupg \
      ca-certificates \
      chromium \
      chromium-driver \
      fonts-liberation \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libgdk-pixbuf2.0-0 \
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
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Copy Node deps from stage 1
COPY --from=node-deps /app/node_modules ./node_modules

# Copy all application files
COPY package.json ./
COPY session_manager.js ./
COPY .github/ ./.github/

# Install Python deps
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy Python source
COPY bot.py db.py github_actions.py utils.py otp_store.py ./

# Expose port (Render sets $PORT)
EXPOSE 8080

# Start both services using a shell script
COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
