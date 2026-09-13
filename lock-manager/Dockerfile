ARG BUILD_FROM="node:22-alpine"

FROM ${BUILD_FROM} AS build
WORKDIR /src

# Install dependencies first so this layer caches independently of source changes
COPY app/package.json app/package-lock.json ./
RUN npm ci

COPY app/ ./
# Compiles the server (tsc -> dist/) and builds the web UI (vite -> dist-web/)
RUN npm run build

FROM ${BUILD_FROM}
LABEL \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.name="Lock Manager" \
    io.hass.description="Manage keypad users (PIN slots) for Zigbee2MQTT locks" \
    io.hass.version="${BUILD_VERSION}"

WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/dist-web ./web

CMD ["node", "dist/server.js"]