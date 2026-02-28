FROM node:22-slim

WORKDIR /app

RUN npm install -g @anthropic-ai/claude-code

COPY package.json ./
RUN npm install

COPY bot.js ./

WORKDIR /workspace

CMD ["node", "/app/bot.js"]
