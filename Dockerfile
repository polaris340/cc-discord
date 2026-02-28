FROM node:22-slim

WORKDIR /app

# Display stack + browser packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo procps \
    xvfb x11-utils \
    x11vnc \
    novnc websockify \
    fluxbox \
    chromium \
    dbus-x11 \
    xdg-utils \
    fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Bot app
COPY package.json ./
RUN npm install
COPY bot.js ./

# User setup
RUN useradd -m -s /bin/bash claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    mkdir -p /workspace /home/claude/.claude && \
    chown -R claude:claude /workspace /home/claude/.claude

# Entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Display defaults
ENV DISPLAY=:99
ENV SCREEN_RESOLUTION=1920x1080x24
ENV NOVNC_PORT=6080

EXPOSE 6080

USER claude
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
