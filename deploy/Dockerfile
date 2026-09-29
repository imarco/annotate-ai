FROM node:22-alpine AS assets

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM oven/bun:1.3.10

WORKDIR /app
COPY --from=assets /build/server ./server
COPY --from=assets /build/annotate.js ./annotate.js
COPY --from=assets /build/index.html ./index.html
COPY --from=assets /build/dist ./dist

ENV NODE_ENV=production
ENV PORT=18767
ENV ANNOTATE_DB_PATH=/app/data/annotate.sqlite

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 18767

CMD ["bun", "server/index.ts"]
