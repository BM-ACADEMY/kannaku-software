# One image: builds the React app, then serves it + the API from Node.
FROM node:20-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
# Creates/updates tables and seed data on every start (safe to re-run), then starts the app
CMD ["sh", "-c", "node src/scripts/initDb.js && node src/index.js"]
