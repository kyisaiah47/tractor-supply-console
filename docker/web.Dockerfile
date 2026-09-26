# The React UI on Next.js. /api/* is rewritten to the API service; the rewrite target is fixed at build.
FROM node:22-slim AS build
WORKDIR /app
ARG API_URL=http://api:8000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY next.config.ts tsconfig.json eslint.config.mjs ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ARG API_URL=http://api:8000
ENV NODE_ENV=production API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app/package.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
