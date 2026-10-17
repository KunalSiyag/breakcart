# BreakCart web — build the SPA with Node, serve it with nginx.
# Build context: this directory (web/).

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so source edits don't bust the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------- serve
FROM nginx:1.27-alpine

# Our nginx.conf replaces the stock one entirely (listens on 8080, proxies /api and /control).
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
