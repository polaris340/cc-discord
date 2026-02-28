FROM node:22-slim

WORKDIR /app

RUN npm install -g @anthropic-ai/claude-code

COPY package.json ./
RUN npm install

COPY bot.js ./

RUN apt-get update && apt-get install -y sudo && rm -rf /var/lib/apt/lists/* && \
    useradd -m -s /bin/bash claude && \
    echo "claude ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    mkdir -p /workspace /home/claude/.claude && \
    chown -R claude:claude /workspace /home/claude/.claude

USER claude
WORKDIR /workspace

CMD ["node", "/app/bot.js"]
