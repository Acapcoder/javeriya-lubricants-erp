FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build --workspace web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --workspace server --include-workspace-root

COPY server ./server
COPY --from=build /app/server/public ./server/public

RUN mkdir -p storage/attachments && addgroup -S orcms && adduser -S orcms -G orcms \
  && chown -R orcms:orcms /app
USER orcms

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "--workspace", "server"]
