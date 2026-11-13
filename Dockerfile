FROM node:22-alpine

WORKDIR /app

# Installed separately from the rest of the source so this layer only
# rebuilds when dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY frontend ./frontend
# Applied on boot by src/db/db.js's migrate() - the container cannot start
# without them.
COPY migrations ./migrations

# node:alpine images ship a non-root "node" user already.
USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
