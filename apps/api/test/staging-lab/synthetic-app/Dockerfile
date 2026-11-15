FROM node:22-alpine

WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js /app/server.js

ARG APP_MODE=healthy
ENV APP_MODE=${APP_MODE}

EXPOSE 3000
CMD ["node", "/app/server.js"]
