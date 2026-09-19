FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY dist ./dist
COPY skills ./skills
COPY migrations ./migrations
ENV NODE_ENV=production
CMD ["node", "dist/apps/bot/src/index.js"]
