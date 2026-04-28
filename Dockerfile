# Базовый образ с предустановленным Chromium и playwright dependencies.
FROM mcr.microsoft.com/playwright:v1.47.0-noble

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.js"]
