FROM node:24-alpine

WORKDIR /app
# With NODE_ENV=production the server won't start unless UI_PASSWORD is set.
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/voicebot.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY knowledge ./knowledge

# The SQLite database (settings and call history) lives on a volume.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server.js"]
