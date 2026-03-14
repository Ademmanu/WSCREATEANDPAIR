# ── Stage 1: Node.js dependencies ────────────────────────────────────────────
FROM node:20-slim AS node-deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: Final image ──────────────────────────────────────────────────────
# Use node:20-slim as base so Node.js is already present and correct.
# We then add Python on top of it.
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

# Tell Puppeteer to use the system Chromium — skip its own download
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Make python3 available as "python" and pip3 as "pip"
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

# Copy Node deps from stage 1
COPY --from=node-deps /app/node_modules ./node_modules

# Copy all application files
COPY package.json ./
COPY session_manager.js ./
COPY .github/ ./.github/

# Install Python deps (use --break-system-packages for Debian bookworm)
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# Copy Python source
COPY bot.py db.py github_actions.py utils.py otp_store.py ./

# Expose port (Render sets $PORT)
EXPOSE 8080

# Start both services
COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
